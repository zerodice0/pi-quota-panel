/**
 * 조치 효과 측정. 조치한 시각(mark)을 기준으로 조치 전 구간과 조치 후 구간의 소모 속도를 비교해 판정함.
 * 5h 사용률은 계정 전체 값이고 1% 단위라 흔들리므로, 문제 세션의 시간당 비용을 주 지표로 쓰고 사용률은 함께 보여 주기만 함
 */
import type { Sample, TurnRow, WindowKey } from "./db.ts";
import { analyze, riseOf } from "./diagnose.ts";

/**
 * span 안에 사용률이 rise만큼 오르면 '급증'(패널의 원인 표시, 알림, 재발 판정에 같이 씀).
 * 5h 구간이 없는 계정(7d만 있는 요금제)은 7d로 봄. 7d는 1% 단위로 움직이고 평소 1시간에 1%p 안쪽이므로 1시간에 2%p를 급증으로 봄
 */
export const SURGE: Record<WindowKey, { rise: number; span: number }> = {
	"5h": { rise: 5, span: 15 * 60_000 },
	"7d": { rise: 2, span: 60 * 60_000 },
};
/** 조치 후 이만큼은 지나야 판정함(그 전에는 '측정 중') */
export const MIN_OBSERVE = 20 * 60_000;
/** 조치 후 속도가 조치 전의 이 비율 이하면 개선, 이 비율 이상이면 악화 */
const IMPROVED = 0.6;
const WORSE = 1.1;

export type Metrics = {
	from: number;
	to: number;
	priced: boolean;
	turns: number;
	cost: number;
	costPerH: number;
	/** 문제 세션(조치 전 구간에서 비용이 가장 큰 세션)의 값 */
	focusTurns: number;
	focusCostPerH: number;
	turnsPerMin: number;
	avgCtx: number;
	peakConcurrency: number;
	/** 사용률(mark.window)이 오른 양(%p)과 시간당 속도. 표본이 모자라면 undefined */
	rise?: number;
	risePerH?: number;
	/** 급증 판정 창(SURGE.span) 안에 오른 최대 폭(%p). 급증 재발 판정에 씀 */
	peakRise: number;
	causes: { id: string; label: string }[];
};

export type VerdictKind = "pending" | "unknown" | "improved" | "same" | "worse" | "recurred";
export const VERDICT_LABEL: Record<VerdictKind, string> = {
	pending: "측정 중",
	unknown: "판단 불가",
	improved: "개선",
	same: "변화 작음",
	worse: "악화",
	recurred: "급증 재발",
};

export type Verdict = {
	kind: VerdictKind;
	/** 조치 후 속도 / 조치 전 속도 */
	ratio?: number;
	basis: "session" | "total";
	summary: string;
	notes: string[];
};

export type Mark = {
	provider: string;
	name: string;
	/** 조치한 시각 */
	at: number;
	/** 측정이 끝나는 시각 */
	until: number;
	memo?: string;
	/** 사용률을 볼 구간. 5h가 없는 계정은 7d */
	window: WindowKey;
	/** 표시를 만든 pi 세션. 끝났을 때 이 세션에서 알림 */
	createdIn?: string;
	/** 조치 전 구간이 최근 급증 구간이면 true, 조치 직전 1시간이면 false */
	fromIncident: boolean;
	focus?: { key: string; label: string };
	baseline: Metrics;
	/** 측정이 끝난 뒤 한 번 계산해 저장한 결과 */
	result?: { after: Metrics; verdict: Verdict; at: number };
};

/** span 길이의 창을 밀면서 가장 크게 오른 폭 */
export function peakRise(samples: Sample[], span: number): number {
	let peak = 0;
	for (let i = 0; i < samples.length; i++) {
		let j = i;
		while (j + 1 < samples.length && samples[j + 1].at - samples[i].at <= span) j++;
		peak = Math.max(peak, riseOf(samples.slice(i, j + 1)) ?? 0);
	}
	return peak;
}

export function measure(input: {
	provider: string;
	name: string;
	from: number;
	to: number;
	turns: TurnRow[];
	samples: Sample[];
	priced: boolean;
	focusKey?: string;
	window: WindowKey;
}): Metrics {
	const r = analyze(input);
	const hours = Math.max(1 / 60, (input.to - input.from) / 3600_000);
	const focus = input.focusKey ? r.sessions.find((s) => s.key === input.focusKey) : undefined;
	const s = input.samples.filter((x) => x.at >= input.from && x.at <= input.to);
	const rise = riseOf(s);
	// 표본 간격이 10분이 안 되면 시간당 속도가 크게 흔들리므로 비우고, 표본이 덮은 시간으로 나눔
	const sampleSpan = s.length >= 2 ? s[s.length - 1].at - s[0].at : 0;
	return {
		from: input.from,
		to: input.to,
		priced: r.priced,
		turns: r.turns,
		cost: r.cost,
		costPerH: r.cost / hours,
		focusTurns: focus?.turns ?? 0,
		focusCostPerH: (focus?.cost ?? 0) / hours,
		turnsPerMin: r.turnsPerMin,
		avgCtx: r.avgCtx,
		peakConcurrency: r.peakConcurrency,
		rise,
		risePerH: rise !== undefined && sampleSpan >= 10 * 60_000 ? (rise / sampleSpan) * 3600_000 : undefined,
		peakRise: peakRise(s, SURGE[input.window].span),
		causes: r.causes.map((c) => ({ id: c.id, label: c.label })),
	};
}

/** 비율을 증감률로. 예: 0.28 → "−72%" */
export const signedPct = (ratio: number) => {
	const d = Math.round((ratio - 1) * 100);
	return `${d > 0 ? "+" : d < 0 ? "−" : "±"}${Math.abs(d)}%`;
};

/** 조치 전후를 비교해 판정. now는 판정 시각(측정이 끝나기 전에도 중간 결과를 볼 수 있음) */
export function judge(mark: Pick<Mark, "at" | "focus" | "baseline" | "window">, after: Metrics, now: number): Verdict {
	const before = mark.baseline;
	const notes: string[] = [];
	const elapsed = Math.min(now, after.to) - mark.at;
	if (elapsed < MIN_OBSERVE) {
		return {
			kind: "pending",
			basis: "total",
			summary: `조치 후 ${Math.round(elapsed / 60_000)}분째입니다. ${MIN_OBSERVE / 60_000}분이 지나야 판정합니다`,
			notes,
		};
	}

	// 문제 세션이 조치 후에도 쓰였으면 그 세션의 시간당 비용으로, 아니면 이 기기 전체로 비교
	let basis: Verdict["basis"] = "total";
	let ratio: number | undefined;
	if (mark.focus && before.focusCostPerH > 0 && after.focusTurns > 0) {
		basis = "session";
		ratio = after.focusCostPerH / before.focusCostPerH;
	} else {
		if (mark.focus) notes.push(`문제 세션(${mark.focus.label})은 조치 후 쓰이지 않아 이 기기 전체로 비교했습니다`);
		if (before.costPerH > 0) ratio = after.costPerH / before.costPerH;
	}

	const kept = before.causes.filter((c) => after.causes.some((a) => a.id === c.id)).map((c) => c.label);
	const gone = before.causes.filter((c) => !after.causes.some((a) => a.id === c.id)).map((c) => c.label);
	const added = after.causes.filter((c) => !before.causes.some((b) => b.id === c.id)).map((c) => c.label);
	if (gone.length) notes.push(`사라진 원인: ${gone.join(", ")}`);
	if (kept.length) notes.push(`남은 원인: ${kept.join(", ")}`);
	if (added.length) notes.push(`새 원인: ${added.join(", ")}`);
	if (after.rise !== undefined && after.rise >= 3 && after.turns < 3)
		notes.push("사용률은 올랐지만 이 기기 기록이 거의 없습니다. 다른 기기나 Claude Code·Codex CLI 사용을 확인하세요");

	const surge = SURGE[mark.window];
	const recurred = after.peakRise >= surge.rise;
	if (recurred)
		notes.unshift(`조치 후 ${surge.span / 60_000}분 동안 ${mark.window} 사용률이 +${Math.round(after.peakRise)}%p 오른 구간이 있습니다`);

	const what = basis === "session" ? "문제 세션의 시간당 비용" : "이 기기의 시간당 비용";
	if (ratio === undefined || (basis === "total" && after.turns < 3 && !recurred)) {
		return {
			kind: recurred ? "recurred" : "unknown",
			ratio,
			basis,
			summary: recurred
				? "조치 후에도 급증이 다시 일어났습니다"
				: "조치 전후로 비교할 작업량이 없습니다. 같은 작업을 다시 돌린 뒤 측정하세요",
			notes,
		};
	}
	const kind: VerdictKind = recurred ? "recurred" : ratio <= IMPROVED ? "improved" : ratio >= WORSE ? "worse" : "same";
	return { kind, ratio, basis, summary: `${what} ${signedPct(ratio)}`, notes };
}
