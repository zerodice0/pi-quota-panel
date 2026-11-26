/**
 * 사용량 급증의 원인 진단. DB에서 읽은 턴과 사용률 표본으로 패턴을 분류하고, 패턴마다 할 조치를 붙임.
 * 비용(cost)은 공급자가 한도에 반영하는 비율과 같지 않으므로 한도 소모량의 근사치로만 씀
 */
import type { Sample, TurnRow } from "./db.ts";

/** 평균 컨텍스트가 이보다 크면 '큰 컨텍스트 반복'으로 봄 */
const LARGE_CTX = 120_000;
/**
 * 한 세션이 10분 안에 이만큼 턴을 쓰고, 턴당 출력이 짧고, 한 도구만 반복하면 '짧은 턴 폭주'(폴링·재시도 루프)로 봄.
 * 에이전트 작업은 평소에도 분당 4~5턴까지 오르므로 턴 수만으로는 판단하지 않음
 */
const STORM_BURST_10M = 30;
const STORM_OUTPUT = 250;
const STORM_TOOL_SHARE = 0.85;
/** 같은 10분 안에 함께 움직인 세션이 이만큼이면 '동시 실행'으로 봄 */
const PARALLEL_SESSIONS = 3;
const CACHE_MISS_SHARE = 0.25;
const OUTPUT_SHARE = 0.4;
const PREMIUM_SHARE = 0.8;
/** 사용률이 이만큼 올랐는데 이 기기 기록이 거의 없으면 '외부 사용'으로 봄 */
const EXTERNAL_DELTA = 3;
/**
 * 가격 정보가 없는 모델은 비용이 0으로 기록되므로, 입력 토큰 단가를 1로 두고 상대 단가로 가중한 토큰 수를 비용 대신 씀.
 * 비율은 Anthropic 가격표의 상대값(출력 5배, 캐시 읽기 0.1배, 캐시 쓰기 1.25배)을 따름
 */
const WEIGHT = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 };

export type Cause = { id: string; label: string; evidence: string; action: string; score: number };
export type SessionStat = { key: string; label: string; cost: number; turns: number; avgCtx: number; current: boolean };
export type Report = {
	provider: string;
	name: string;
	from: number;
	to: number;
	/** 구간 동안 늘어난 사용률(%p, window 기준). 표본이 없으면 undefined */
	delta?: number;
	/** delta를 잰 사용률 구간 */
	window: string;
	/** false면 cost가 달러가 아니라 가중 토큰 수 */
	priced: boolean;
	/** 10분 단위로 본 최대 동시 세션 수 */
	peakConcurrency: number;
	turns: number;
	cost: number;
	avgCtx: number;
	maxCtx: number;
	turnsPerMin: number;
	medianOutput: number;
	split: { input: number; output: number; cacheRead: number; cacheWrite: number };
	models: [string, number][];
	tools: [string, number][];
	sessions: SessionStat[];
	activeSessions: number;
	subagentShare: number;
	causes: Cause[];
};

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const ctxOf = (t: TurnRow) => t.input + t.cacheRead + t.cacheWrite;
export const kTokens = (n: number) =>
	n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n));
export const percent = (x: number) => `${Math.round(x * 100)}%`;

/** 세션별로 10분 안의 최대 턴 수, 턴당 출력 중앙값, 가장 많이 쓴 도구의 비중을 보고 루프로 보이는 세션을 찾음 */
function stormOf(conv: TurnRow[], sessions: SessionStat[]) {
	const bySession = new Map<string, TurnRow[]>();
	for (const t of conv) {
		const list = bySession.get(t.sessionFile) ?? [];
		list.push(t);
		bySession.set(t.sessionFile, list);
	}
	let found: { label: string; burst: number; median: number; tool: string; toolShare: number; cost: number } | undefined;
	for (const [key, ts] of bySession) {
		if (ts.length < STORM_BURST_10M) continue;
		let burst = 0;
		for (let i = 0, j = 0; i < ts.length; i++) {
			while (ts[i].ts - ts[j].ts > 10 * 60_000) j++;
			burst = Math.max(burst, i - j + 1);
		}
		const outs = ts.map((t) => t.output).sort((a, b) => a - b);
		const median = outs[Math.floor(outs.length / 2)];
		const counts = new Map<string, number>();
		for (const t of ts) for (const n of t.tools?.split(",") ?? []) counts.set(n, (counts.get(n) ?? 0) + 1);
		const calls = sum([...counts.values()]);
		const [tool, n] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
		const toolShare = calls ? n / calls : 0;
		if (burst < STORM_BURST_10M || median > STORM_OUTPUT || toolShare < STORM_TOOL_SHARE) continue;
		const s = sessions.find((x) => x.key === key);
		const cost = sum(ts.map((t) => t.cost));
		if (!found || cost > found.cost) found = { label: s?.label ?? key, burst, median, tool, toolShare, cost };
	}
	return found;
}

/** 리셋으로 떨어진 구간을 빼고, 늘어난 양만 더함 */
export function riseOf(samples: Sample[]): number | undefined {
	if (samples.length < 2) return undefined;
	let rise = 0;
	for (let i = 1; i < samples.length; i++) rise += Math.max(0, samples[i].pct - samples[i - 1].pct);
	return rise;
}

/** 세션 파일 경로에서 프로젝트 이름과 시작 시각을 뽑아 사람이 읽을 이름을 만듦 */
function sessionLabel(t: TurnRow): string {
	const project = t.project.split(/[\\/]/).filter(Boolean).pop() ?? t.project;
	const m = t.sessionFile.match(/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/);
	let started = "";
	if (m) {
		const d = new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
		started = ` ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
	}
	return `${project}${started}${t.agent === "subagent" ? " · 서브" : ""}`;
}

/** 턴의 80% 이상에 가격 정보가 있으면 달러 비용을 씀. 아니면 가중 토큰 수 */
export const isPriced = (turns: TurnRow[]) => turns.length > 0 && turns.filter((t) => t.cost > 0).length >= turns.length * 0.8;

export function analyze(input: {
	provider: string;
	name: string;
	from: number;
	to: number;
	turns: TurnRow[];
	samples: Sample[];
	currentSession?: string;
	/** samples의 사용률 구간(기본 5h) */
	window?: string;
	/** 두 구간을 비교할 때 같은 단위(달러 또는 가중 토큰)로 맞추려고 지정함 */
	priced?: boolean;
}): Report {
	const priced = input.priced ?? isPriced(input.turns);
	const turns = priced
		? input.turns
		: input.turns.map((t) => {
				const costInput = t.input * WEIGHT.input;
				const costOutput = t.output * WEIGHT.output;
				const costCacheRead = t.cacheRead * WEIGHT.cacheRead;
				const costCacheWrite = t.cacheWrite * WEIGHT.cacheWrite;
				return { ...t, costInput, costOutput, costCacheRead, costCacheWrite, cost: costInput + costOutput + costCacheRead + costCacheWrite };
			});
	const conv = turns.filter((t) => t.kind === "turn");
	const cost = sum(turns.map((t) => t.cost));
	const total = cost > 0 ? cost : 1;
	const ctxs = conv.map(ctxOf);
	const avgCtx = ctxs.length ? sum(ctxs) / ctxs.length : 0;
	const outputs = conv.map((t) => t.output).sort((a, b) => a - b);
	const medianOutput = outputs.length ? outputs[Math.floor(outputs.length / 2)] : 0;
	// 실제로 턴이 오간 시간으로 나눔(구간 앞뒤의 빈 시간 때문에 속도가 낮아 보이지 않게)
	const activeMin = conv.length ? Math.max(5, (conv[conv.length - 1].ts - conv[0].ts) / 60_000) : 0;
	const turnsPerMin = activeMin ? conv.length / activeMin : 0;

	const split = {
		input: sum(turns.map((t) => t.costInput)) / total,
		output: sum(turns.map((t) => t.costOutput)) / total,
		cacheRead: sum(turns.map((t) => t.costCacheRead)) / total,
		cacheWrite: sum(turns.map((t) => t.costCacheWrite)) / total,
	};

	const byModel = new Map<string, number>();
	for (const t of turns) byModel.set(t.model ?? "?", (byModel.get(t.model ?? "?") ?? 0) + t.cost);
	const models = [...byModel].map(([m, c]) => [m, c / total] as [string, number]).sort((a, b) => b[1] - a[1]);

	const byTool = new Map<string, number>();
	for (const t of conv) for (const name of t.tools?.split(",") ?? []) byTool.set(name, (byTool.get(name) ?? 0) + 1);
	const tools = [...byTool].sort((a, b) => b[1] - a[1]);

	const bySession = new Map<string, { label: string; cost: number; turns: number; ctx: number; agent: string }>();
	for (const t of turns) {
		const s = bySession.get(t.sessionFile) ?? { label: sessionLabel(t), cost: 0, turns: 0, ctx: 0, agent: t.agent };
		s.cost += t.cost;
		if (t.kind === "turn") {
			s.turns++;
			s.ctx += ctxOf(t);
		}
		bySession.set(t.sessionFile, s);
	}
	const sessions = [...bySession]
		.map(([key, s]) => ({
			key,
			label: s.label,
			cost: s.cost,
			turns: s.turns,
			avgCtx: s.turns ? s.ctx / s.turns : 0,
			current: key === input.currentSession,
		}))
		.sort((a, b) => b.cost - a.cost);
	const activeSessions = sessions.filter((s) => s.turns > 0).length;
	// 같은 10분 안에 2턴 이상 쓴 세션을 '동시에 움직인 세션'으로 셈. 하루 동안 차례로 쓴 세션을 동시 실행으로 오해하지 않게 함
	const buckets = new Map<number, Map<string, number>>();
	for (const t of conv) {
		const b = Math.floor(t.ts / 600_000);
		const m = buckets.get(b) ?? new Map<string, number>();
		m.set(t.sessionFile, (m.get(t.sessionFile) ?? 0) + 1);
		buckets.set(b, m);
	}
	const peakConcurrency = Math.max(0, ...[...buckets.values()].map((m) => [...m.values()].filter((n) => n >= 2).length));
	const subagentShare = sum(turns.filter((t) => t.agent === "subagent").map((t) => t.cost)) / total;

	const delta = riseOf(input.samples);
	const causes: Cause[] = [];
	if (delta !== undefined && delta >= EXTERNAL_DELTA && conv.length < 3) {
		causes.push({
			id: "external",
			label: "외부 사용",
			evidence: `사용률이 ${Math.round(delta)}%p 올랐지만 이 기기 기록은 ${conv.length}턴`,
			action: "다른 기기나 Claude Code·Codex CLI 사용을 확인",
			score: 1,
		});
	}
	if (avgCtx >= LARGE_CTX) {
		// 압축할 대상을 바로 알 수 있도록 컨텍스트가 큰 세션 가운데 비용이 가장 큰 세션을 함께 적음
		const target = sessions.find((s) => s.avgCtx >= LARGE_CTX);
		causes.push({
			id: "context",
			label: "큰 컨텍스트 반복",
			evidence: `평균 ${kTokens(avgCtx)} × ${conv.length}턴, 캐시 읽기가 비용의 ${percent(split.cacheRead)}${target ? `, 가장 큰 세션 ${target.label}(평균 ${kTokens(target.avgCtx)})` : ""}`,
			action: "/compact 하거나 인계서를 남기고 새 세션 시작",
			score: sum(conv.filter((t) => ctxOf(t) >= LARGE_CTX).map((t) => t.cost)) / total,
		});
	}
	const storm = stormOf(conv, sessions);
	if (storm) {
		causes.push({
			id: "storm",
			label: "짧은 턴 폭주",
			evidence: `${storm.label}: 10분에 ${storm.burst}턴, 턴당 출력 ${storm.median}토큰, ${storm.tool} ${percent(storm.toolShare)}`,
			action: "폴링·재시도 루프를 멈추고 기다리는 작업은 스크립트 한 번으로 묶기",
			score: storm.cost / total,
		});
	}
	if (peakConcurrency >= PARALLEL_SESSIONS) {
		causes.push({
			id: "parallel",
			label: "동시 실행",
			evidence: `최대 ${peakConcurrency}개 세션이 동시에 실행${subagentShare >= 0.1 ? `, 서브에이전트 ${percent(subagentShare)}` : ""}`,
			action: "동시에 돌리는 세션·서브에이전트 줄이기",
			score: 1 - (sessions[0]?.cost ?? 0) / total,
		});
	}
	if (split.cacheWrite >= CACHE_MISS_SHARE) {
		causes.push({
			id: "cache",
			label: "캐시 미스",
			evidence: `캐시 쓰기가 비용의 ${percent(split.cacheWrite)}`,
			action: "모델·설정 변경은 몰아서 하고, 오래 쉰 세션은 압축 후 재개",
			score: split.cacheWrite,
		});
	}
	if (split.output >= OUTPUT_SHARE) {
		causes.push({
			id: "output",
			label: "출력 과다",
			evidence: `출력이 비용의 ${percent(split.output)}`,
			action: "thinking 수준을 낮추고 긴 출력을 줄이기",
			score: split.output,
		});
	}
	const premium = models.filter(([m]) => /opus/i.test(m));
	const premiumShare = sum(premium.map(([, s]) => s));
	if (premiumShare >= PREMIUM_SHARE && causes.length) {
		causes.push({
			id: "model",
			label: "비싼 모델",
			evidence: `${premium[0][0]}가 비용의 ${percent(premiumShare)}`,
			action: "단순 작업은 Sonnet·Haiku로 바꾸기",
			score: 0.05,
		});
	}
	causes.sort((a, b) => b.score - a.score);

	return {
		provider: input.provider,
		name: input.name,
		from: input.from,
		to: input.to,
		delta,
		window: input.window ?? "5h",
		priced,
		peakConcurrency,
		turns: conv.length,
		cost,
		avgCtx,
		maxCtx: ctxs.length ? Math.max(...ctxs) : 0,
		turnsPerMin,
		medianOutput,
		split,
		models,
		tools,
		sessions,
		activeSessions,
		subagentShare,
		causes,
	};
}
