/**
 * 우측 상단 사용 한도(quota) 패널: Anthropic / OpenAI Codex의 5h·7d 사용률과 리셋까지 남은 시간.
 * 토글: ctrl+shift+u, alt+u 또는 /quota (on|off|refresh|reset|move|login)
 * 위치는 /quota move(키보드)나 fullscreen 모드의 마우스 드래그로 옮기고, ~/.pi/agent/quota-panel.json에 저장됨
 */
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { KeyId, OverlayHandle, OverlayOptions, TUI, TuiMouseEvent } from "@earendil-works/pi-tui";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { openStore, type Sample, sessionsDir, type Store, type WindowKey } from "./db.ts";
import { analyze, kTokens, percent, type Report, riseOf } from "./diagnose.ts";

// ── titanium 팔레트 ──────────────────────────────────────────
const rgb = (hex: string) => {
	const n = Number.parseInt(hex.slice(1), 16);
	return `${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}`;
};
const fg = (hex: string, s: string) => `\x1b[38;2;${rgb(hex)}m${s}\x1b[39m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
const C = {
	panel: "#151820",
	border: "#2a3038",
	trackBlock: "#3b424d",
	title: "#d4c090",
	name: "#e8ecf4",
	label: "#9ca3b0",
	dim: "#6b7280",
	ok: "#00b4ff",
	warn: "#ffb347",
	crit: "#ff4757",
};
const BG = `\x1b[48;2;${rgb(C.panel)}m`;
const BG_OFF = "\x1b[49m";

const WIDTH = 42;
const BAR = 12;
const REFRESH_MS = 3 * 60_000;
// pi-tui는 offset을 더한 뒤 margin 안으로 위치를 제한하므로 margin은 최소로 두고 위치는 offset으로 표현
const MARGIN_TOP = 1;
const MARGIN_RIGHT = 1;
const positionFile = join(homedir(), ".pi/agent/quota-panel.json");
const authFile = join(homedir(), ".pi/agent/auth.json");
// 키보드 이동 한 번의 칸 수(방향키 / shift+방향키)
const STEP = { x: 2, y: 1 };
const BIG_STEP = { x: 10, y: 3 };

type ProviderId = "anthropic" | "openai-codex";
const PROVIDERS: { id: ProviderId; name: string; aliases: string[] }[] = [
	{ id: "anthropic", name: "Claude", aliases: ["claude", "anthropic"] },
	{ id: "openai-codex", name: "Codex", aliases: ["codex", "openai-codex", "openai"] },
];

/** rate는 단위 시간(5h는 1시간, 7d는 1일)당 늘어난 %p, eta는 이 속도로 100%에 닿는 시각 */
type Trend = { rate: number; unit: "h" | "d"; eta?: number };
type Win = { pct: number; resetAt: number; trend?: Trend } | null;
type Status = { fetchedAt: number; rows: Row[] };
/** cause는 사용량이 급증하거나 리셋 전에 소진될 때만 채움(패널의 '원인:' 줄) */
type Row = { id: ProviderId; name: string; h5: Win; d7: Win; error?: string; needsLogin?: boolean; cause?: string };

/** 다시 로그인해야 풀리는 오류(토큰 없음·만료, HTTP 401/403) */
class LoginError extends Error {}
class HttpError extends Error {}

const describeError = (e: unknown) =>
	e instanceof LoginError
		? "로그인 필요 · /quota login"
		: e instanceof HttpError
			? e.message
			: (e as Error)?.name === "TimeoutError"
				? "응답 시간 초과"
				: "연결 실패";

// ── 데이터 조회 ──────────────────────────────────────────────
function readAuthFile(): Record<string, any> {
	try {
		return JSON.parse(readFileSync(authFile, "utf8"));
	} catch {
		return {};
	}
}

async function tokenFor(ctx: ExtensionContext, id: string): Promise<string | undefined> {
	try {
		const r = await ctx.modelRegistry.getProviderAuth(id);
		if (r?.auth.apiKey) return r.auth.apiKey;
	} catch {}
	const c = readAuthFile()[id];
	return c?.type === "oauth" && c.expires > Date.now() ? c.access : undefined;
}

async function getJson(url: string, headers: Record<string, string>) {
	const res = await fetch(url, { headers: { "User-Agent": "pi-quota-panel", ...headers }, signal: AbortSignal.timeout(10_000) });
	if (res.status === 401 || res.status === 403) throw new LoginError();
	if (!res.ok) throw new HttpError(`조회 실패 (HTTP ${res.status})`);
	return res.json() as Promise<any>;
}

async function fetchAnthropic(ctx: ExtensionContext): Promise<Row | null> {
	if (!readAuthFile().anthropic) return null;
	const row: Row = { id: "anthropic", name: "Claude", h5: null, d7: null };
	try {
		const token = await tokenFor(ctx, "anthropic");
		if (!token) throw new LoginError();
		const j = await getJson("https://api.anthropic.com/api/oauth/usage", {
			Authorization: `Bearer ${token}`,
			"anthropic-beta": "oauth-2025-04-20",
		});
		const win = (w: any): Win =>
			w && typeof w.utilization === "number" ? { pct: w.utilization, resetAt: Date.parse(w.resets_at) } : null;
		row.h5 = win(j.five_hour);
		row.d7 = win(j.seven_day);
	} catch (e) {
		row.error = describeError(e);
		row.needsLogin = e instanceof LoginError;
	}
	return row;
}

async function fetchCodex(ctx: ExtensionContext): Promise<Row | null> {
	const cred = readAuthFile()["openai-codex"];
	if (!cred) return null;
	const row: Row = { id: "openai-codex", name: "Codex", h5: null, d7: null };
	try {
		const token = await tokenFor(ctx, "openai-codex");
		if (!token) throw new LoginError();
		const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
		if (cred.accountId) headers["ChatGPT-Account-Id"] = cred.accountId;
		const j = await getJson("https://chatgpt.com/backend-api/wham/usage", headers);
		// primary/secondary 중 어느 쪽이 5h인지 고정돼 있지 않으므로 구간 길이로 판별
		for (const w of [j.rate_limit?.primary_window, j.rate_limit?.secondary_window]) {
			if (!w || typeof w.used_percent !== "number") continue;
			const v = { pct: w.used_percent, resetAt: Date.now() + (w.reset_after_seconds ?? 0) * 1000 };
			if ((w.limit_window_seconds ?? 0) <= 6 * 3600) row.h5 = v;
			else row.d7 = v;
		}
	} catch (e) {
		row.error = describeError(e);
		row.needsLogin = e instanceof LoginError;
	}
	return row;
}

// ── 렌더링 ──────────────────────────────────────────────────
const padName = (n: string) => n + " ".repeat(Math.max(1, 7 - visibleWidth(n)));
const levelColor = (pct: number) => (pct >= 90 ? C.crit : pct >= 70 ? C.warn : C.ok);

function bar(pct: number): string {
	const cells = (Math.max(0, Math.min(100, pct)) / 100) * BAR;
	// 0%가 아니면 최소 1칸은 채워서 '사용 중'임을 알 수 있게 함
	const full = pct > 0 ? Math.max(1, Math.round(cells)) : 0;
	return fg(levelColor(pct), "█".repeat(full)) + fg(C.trackBlock, "░".repeat(BAR - full));
}

function left(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return "곧 리셋";
	const m = Math.floor(ms / 60_000);
	const d = Math.floor(m / 1440);
	const h = Math.floor((m % 1440) / 60);
	if (d > 0) return `${d}d${String(h).padStart(2, " ")}h`;
	if (h > 0) return `${h}h${String(m % 60).padStart(2, "0")}m`;
	return `${m}m`;
}

function ago(ts: number): string {
	const s = Math.floor((Date.now() - ts) / 1000);
	if (s < 60) return "방금";
	return `${Math.floor(s / 60)}분 전`;
}

// ── 소모 속도 ──────────────────────────────────────────────
// 5h는 최근 1시간, 7d는 최근 24시간의 표본으로 속도를 구함. 표본 간격이 너무 짧으면 흔들리므로 최소 구간을 둠
const TREND = {
	"5h": { span: 3600_000, minSpan: 10 * 60_000, unit: "h", unitMs: 3600_000 },
	"7d": { span: 24 * 3600_000, minSpan: 2 * 3600_000, unit: "d", unitMs: 24 * 3600_000 },
} as const;

function trendOf(samples: Sample[], win: NonNullable<Win>, key: WindowKey): Trend | undefined {
	const cfg = TREND[key];
	// 리셋으로 사용률이 떨어진 뒤의 표본만 씁
	let start = 0;
	for (let i = 1; i < samples.length; i++) if (samples[i].pct < samples[i - 1].pct - 0.5) start = i;
	const s = samples.slice(start);
	if (s.length < 2) return undefined;
	const first = s[0];
	const last = s[s.length - 1];
	const dt = last.at - first.at;
	if (dt < cfg.minSpan) return undefined;
	const perMs = (last.pct - first.pct) / dt;
	return {
		rate: perMs * cfg.unitMs,
		unit: cfg.unit,
		eta: perMs > 0 ? last.at + Math.max(0, 100 - win.pct) / perMs : undefined,
	};
}

function clock(ts: number): string {
	const d = new Date(ts);
	const now = new Date();
	const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
	return d.toDateString() === now.toDateString() ? hm : `${d.getDate()}일 ${d.getHours()}시`;
}

/** 예: "+18%/h · 14:20 소진 예상"(리셋 전에 다 씀), "+4%/h · 리셋까지 여유" */
function trendText(w: NonNullable<Win>): { text: string; danger: boolean } | undefined {
	const t = w.trend;
	if (!t || t.rate <= 0) return undefined;
	const value = t.rate >= 10 ? Math.round(t.rate) : Math.round(t.rate * 10) / 10;
	const rate = `+${value}%/${t.unit === "h" ? "h" : "일"}`;
	const danger = isDanger(w);
	return { text: danger ? `${rate} · ${clock(t.eta!)} 소진 예상` : `${rate} · 리셋까지 여유`, danger };
}

// ── 원인 분석 화면 ──────────────────────────────────────────
const WHY_RANGES = [
	{ ms: 30 * 60_000, label: "최근 30분", arg: "30m" },
	{ ms: 3600_000, label: "최근 1시간", arg: "1h" },
	{ ms: 3 * 3600_000, label: "최근 3시간", arg: "3h" },
	{ ms: 5 * 3600_000, label: "최근 5시간", arg: "5h" },
	{ ms: 24 * 3600_000, label: "최근 24시간", arg: "24h" },
];

const hm = (ts: number, ref = ts) => {
	const d = new Date(ts);
	const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
	// 기준 시각과 날짜가 다르면 날짜를 붙임(예: 24일 16:22)
	return d.toDateString() === new Date(ref).toDateString() ? time : `${d.getDate()}일 ${time}`;
};

/** 왼쪽 제목 열(한글 폭을 고려해 너비 11칸에 맞춤) */
const col = (label: string) => fg(C.label, label + " ".repeat(Math.max(1, 11 - visibleWidth(label))));

function whyLines(r: Report | undefined, rangeLabel: string): string[] {
	if (!r) return [fg(C.crit, "이력 DB를 읽을 수 없습니다")];
	const out = [`${bold(fg(C.title, "사용량 원인 분석"))} · ${r.name} · ${rangeLabel} (${hm(r.from, r.to)}–${hm(r.to)})`];
	const delta = r.delta === undefined ? "5h 표본 없음" : `5h +${Math.round(r.delta)}%p`;
	// 가격 정보가 없는 모델은 달러 대신 가중 토큰으로 표시
	const amount = (v: number) => (r.priced ? `$${v.toFixed(2)}` : `${kTokens(v)} 가중 토큰`);
	out.push(
		`${col("사용량")}${delta} · ${r.priced ? "비용 환산 " : ""}${amount(r.cost)} · ${r.turns}턴 · 세션 ${r.activeSessions}개(최대 동시 ${r.peakConcurrency}개)`,
	);
	if (!r.turns && !r.causes.length) {
		out.push(`${col("")}${fg(C.dim, "이 기간에는 이 기기의 pi 기록이 없습니다")}`);
		return out;
	}
	const [main, ...others] = r.causes;
	if (main) {
		out.push(`${col("주원인")}${fg(C.warn, main.label)}: ${main.evidence}`);
		out.push(`${col("조치")}${fg(C.ok, main.action)}`);
	} else out.push(`${col("주원인")}${fg(C.dim, "뚜렷한 원인 없음")}`);
	others.slice(0, 3).forEach((c, i) => {
		out.push(`${col(i === 0 ? "다른 요인" : "")}${fg(C.warn, c.label)}: ${c.evidence} → ${c.action}`);
	});
	r.sessions.slice(0, 3).forEach((s, i) => {
		const mine = s.current ? fg(C.ok, "  ← 이 세션") : "";
		out.push(
			`${col(i === 0 ? "상위 세션" : "")}${s.label}  ${fg(C.dim, `${amount(s.cost)} · ${s.turns}턴 · 평균 ${kTokens(s.avgCtx)}`)}${mine}`,
		);
	});
	const sp = r.split;
	out.push(
		`${col("비용 구성")}캐시 읽기 ${percent(sp.cacheRead)} · 캐시 쓰기 ${percent(sp.cacheWrite)} · 출력 ${percent(sp.output)} · 입력 ${percent(sp.input)}`,
	);
	out.push(
		`${col("컨텍스트")}평균 ${kTokens(r.avgCtx)} · 최대 ${kTokens(r.maxCtx)} · 분당 ${r.turnsPerMin.toFixed(1)}턴 · 턴당 출력 ${r.medianOutput}토큰(중앙값)`,
	);
	if (r.models.length) out.push(`${col("모델")}${r.models.slice(0, 3).map(([m, s]) => `${m} ${percent(s)}`).join(" · ")}`);
	if (r.tools.length) out.push(`${col("도구")}${r.tools.slice(0, 5).map(([t, n]) => `${t} ${n}`).join(" · ")}`);
	return out;
}

/** 지금 속도로는 리셋 전에 100%에 닿음 */
const isDanger = (w: Win) => !!w?.trend?.eta && w.trend.rate > 0 && w.trend.eta < w.resetAt;

/**
 * 하단 상태줄 한 줄 요약. 계정마다 5h 구간(없으면 7d)의 사용률을 보이고, 늘고 있으면 속도를,
 * 리셋 전에 소진될 속도면 소진 예상 시각을 붙임. 예: "Claude 5h 42% +22%/h 19:01 소진 · Codex 7d 77%"
 */
function statusText(rows: Row[]): string | undefined {
	if (!rows.length) return undefined;
	const parts = rows.map((r) => {
		const name = fg(C.name, r.name);
		if (r.error) return `${name} ${fg(r.needsLogin ? C.warn : C.crit, r.needsLogin ? "로그인 필요" : "조회 실패")}`;
		const [label, w] = r.h5 ? (["5h", r.h5] as const) : (["7d", r.d7] as const);
		if (!w) return `${name} ${fg(C.dim, "기록 없음")}`;
		let text = `${name} ${fg(C.label, label)} ${fg(levelColor(w.pct), `${Math.round(w.pct)}%`)}`;
		const t = trendText(w);
		if (t) {
			const rate = t.text.split(" · ")[0];
			text += ` ${fg(t.danger ? C.crit : C.dim, t.danger ? `${rate} ${clock(w.trend!.eta!)} 소진` : rate)}`;
		}
		if (r.cause) text += ` ${fg(C.warn, r.cause)}`;
		return text;
	});
	return parts.join(fg(C.dim, " · "));
}

type Position = { offsetX: number; offsetY: number };

function readPosition(): Position {
	try {
		const p = JSON.parse(readFileSync(positionFile, "utf8"));
		const x = Number(p.offsetX);
		const y = Number(p.offsetY);
		return { offsetX: Number.isFinite(x) ? Math.min(0, x) : 0, offsetY: Number.isFinite(y) ? Math.max(0, y) : 0 };
	} catch {
		return { offsetX: 0, offsetY: 0 };
	}
}

class QuotaPanel {
	rows: Row[] = [];
	loading = true;
	updatedAt = 0;
	/** 마우스로 끄는 중이거나 키보드 이동 모드 */
	moving = false;
	/** 클릭하면 로그인을 시작하는 줄 → 대상 계정(null이면 계정 선택) */
	loginLines = new Map<number, Row | null>();
	/** 클릭하면 원인 분석을 여는 줄 → 대상 계정 */
	whyLines = new Map<number, Row>();

	invalidate() {}

	render(_width: number): string[] {
		const inner = WIDTH - 4;
		const line = (content: string) => {
			const t = truncateToWidth(content, inner);
			return `${BG}${fg(C.border, "│")} ${t}${" ".repeat(Math.max(0, inner - visibleWidth(t)))} ${fg(C.border, "│")}${BG_OFF}`;
		};

		const status = this.loading ? fg(C.dim, " 갱신 중… ") : this.updatedAt ? fg(C.dim, ` ${ago(this.updatedAt)} 갱신 `) : "";
		const title = ` ${bold(fg(this.moving ? C.ok : C.title, "사용 한도"))} `;
		const topFill = WIDTH - 2 - visibleWidth(title) - visibleWidth(status) - 2;
		const out = [
			`${BG}${fg(C.border, "╭─")}${title}${fg(C.border, "─".repeat(Math.max(1, topFill)))}${status}${fg(C.border, "─╮")}${BG_OFF}`,
		];

		this.loginLines.clear();
		this.whyLines.clear();
		out.push(line("")); // 위쪽 여백
		if (!this.rows.length) {
			out.push(line(fg(C.dim, this.loading ? "불러오는 중…" : "로그인된 계정이 없습니다")));
			if (!this.loading) {
				this.loginLines.set(out.length, null);
				out.push(line(fg(C.dim, "/quota login 으로 로그인")));
			}
		}

		this.rows.forEach((r, i) => {
			if (i > 0) out.push(line(""));
			if (r.error) {
				if (r.needsLogin) this.loginLines.set(out.length, r);
				out.push(line(`${bold(fg(C.name, padName(r.name)))}${fg(r.needsLogin ? C.warn : C.crit, r.error)}`));
				return;
			}
			const win = (label: string, w: Win, first: boolean) => {
				const name = first ? bold(fg(C.name, padName(r.name))) : " ".repeat(7);
				if (!w) return line(`${name}${fg(C.label, label)}  ${fg(C.dim, "사용 기록 없음")}`);
				const pct = fg(levelColor(w.pct), `${Math.round(w.pct)}%`.padStart(4));
				return line(`${name}${fg(C.label, label)}  ${bar(w.pct)} ${pct}  ${fg(C.dim, `↻${left(w.resetAt - Date.now()).padStart(6)}`)}`);
			};
			// 값이 없는 구간(예: 5h 구간이 아직 시작되지 않음)은 숨김
			const wins = ([["5h", r.h5], ["7d", r.d7]] as const).filter(([, w]) => w);
			if (!wins.length) out.push(win("  ", null, true));
			wins.forEach(([label, w], j) => {
				out.push(win(label, w, j === 0));
				// 소모 속도가 있을 때만 한 줄 더 표시. 리셋 전에 다 쓸 속도면 빨간색
				const t = w && trendText(w);
				if (t) out.push(line(`${" ".repeat(7)}${fg(t.danger ? C.crit : C.dim, t.text)}`));
			});
			if (r.cause) {
				this.whyLines.set(out.length, r);
				out.push(line(`${" ".repeat(7)}${fg(C.warn, `원인: ${r.cause}`)}`));
			}
		});

		out.push(line("")); // 아래쪽 여백
		out.push(`${BG}${fg(C.border, `╰${"─".repeat(WIDTH - 2)}╯`)}${BG_OFF}`);
		return out;
	}
}

// ── 확장 ────────────────────────────────────────────────────
const VERBS = [
	{ value: "on", description: "패널 표시" },
	{ value: "off", description: "패널 숨김" },
	{ value: "refresh", description: "지금 갱신" },
	{ value: "move", description: "키보드로 위치 이동 (방향키, enter 저장)" },
	{ value: "reset", description: "기본 위치(오른쪽 위)로 되돌림" },
	{ value: "login", description: "계정 로그인 (/login 명령을 입력창에 채움)" },
	{ value: "why", description: "사용량 급증 원인 분석 (계정, 기간: 30m|1h|3h|5h|24h)" },
];
const STATUS_KEY = "quota-panel";
const MOVE_ARGS = ["left", "right", "up", "down", "top-left", "top-right", "bottom-left", "bottom-right"];

export default function (pi: ExtensionAPI) {
	const panel = new QuotaPanel();
	// showOverlay는 이 객체를 참조로 보관하고 매 프레임 다시 읽으므로, offset을 바꾸면 바로 위치가 바뀜
	const options: OverlayOptions = {
		anchor: "top-right",
		width: WIDTH,
		margin: { top: MARGIN_TOP, right: MARGIN_RIGHT },
		nonCapturing: true,
		visible: (w) => w >= WIDTH + 40,
		...readPosition(),
	};
	const savePosition = () => {
		try {
			writeFileSync(positionFile, `${JSON.stringify({ offsetX: options.offsetX ?? 0, offsetY: options.offsetY ?? 0 })}\n`);
		} catch {}
	};
	let drag: { x: number; y: number; ox: number; oy: number } | undefined;
	let tui: TUI | undefined;
	let lastCtx: ExtensionContext | undefined;
	let handle: OverlayHandle | undefined;
	let close: (() => void) | undefined;
	let rerender: (() => void) | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let tick: ReturnType<typeof setInterval> | undefined;
	let authWatch: ReturnType<typeof setInterval> | undefined;
	let authStamp = "";
	let refreshing: Promise<void> | undefined;
	let ingestTimer: ReturnType<typeof setInterval> | undefined;
	let ingestKick: ReturnType<typeof setTimeout> | undefined;
	let visible = false;
	/** 수집 타이머가 돌고 있는지. 패널 표시와는 별개로 TUI 세션이 시작되면 켜짐 */
	let collecting = false;
	/** 세션 전환(/new, /resume 등) 뒤에도 패널을 다시 띄우기 위해 직전 표시 상태를 기억 */
	let wasVisible = false;
	// undefined: 아직 열지 않음, null: node:sqlite를 쓸 수 없어 이력 없이 동작
	let store: Store | null | undefined;
	const getStore = () => {
		if (store === undefined) store = openStore() ?? null;
		return store ?? undefined;
	};
	// DB 오류(잠금 대기 초과 등)로 pi가 멈추거나 죽지 않도록 모든 저장소 호출을 감쌈
	const withStore = <T>(fn: (s: Store) => T): T | undefined => {
		const s = getStore();
		if (!s) return undefined;
		try {
			return fn(s);
		} catch {
			return undefined;
		}
	};

	// ── 위치 ──
	// 화면 밖으로 쌓인 offset이 없도록 직접 범위를 제한(되돌아올 때 헛도는 구간 방지)
	const placeAt = (x: number, y: number) => {
		const cols = tui?.terminal.columns ?? process.stdout.columns ?? 120;
		const rows = tui?.terminal.rows ?? process.stdout.rows ?? 40;
		const maxLeft = Math.max(0, cols - MARGIN_RIGHT - WIDTH);
		// 높이는 내용(계정 수·오류)에 따라 달라지므로 지금 내용으로 다시 셈
		const maxDown = Math.max(0, rows - MARGIN_TOP - panel.render(WIDTH).length);
		options.offsetX = Math.min(0, Math.max(-maxLeft, Math.round(x)));
		options.offsetY = Math.min(maxDown, Math.max(0, Math.round(y)));
		rerender?.();
	};
	const moveBy = (dx: number, dy: number) => placeAt((options.offsetX ?? 0) + dx, (options.offsetY ?? 0) + dy);

	// ── 원인 진단 ──
	/** 이 pi 세션의 기록 파일(turns.session_file과 같은 형식). 상위 세션에서 '이 세션'을 표시하고 알림 대상을 고를 때 씀 */
	const currentSession = () => {
		try {
			const file = lastCtx?.sessionManager.getSessionFile();
			return file ? relative(sessionsDir, file) : undefined;
		} catch {
			return undefined;
		}
	};

	const buildReport = (id: ProviderId, from: number, to: number): Report | undefined =>
		withStore((s) =>
			analyze({
				provider: id,
				name: PROVIDERS.find((p) => p.id === id)?.name ?? id,
				from,
				to,
				turns: s.turnsBetween(from, to, id),
				samples: s.samples(id, "5h", from).filter((x) => x.at <= to),
				currentSession: currentSession(),
			}),
		);

	// 같은 계정의 알림은 프로세스마다 30분에 한 번만
	const alertedAt = new Map<ProviderId, number>();

	/**
	 * 급증(최근 15분에 5h 사용률 +5%p 이상)이거나 리셋 전에 소진될 속도면 최근 1시간을 진단해 패널에 원인을 표시함.
	 * 알림은 이 세션이 그 구간 비용의 20% 이상을 차지할 때만 띄움. 모든 pi가 동시에 알리지 않고, 원인을 만든 세션에서만 알림
	 */
	const diagnose = (row: Row, now: number) => {
		if (row.error) return;
		const recent = withStore((s) => s.samples(row.id, "5h", now - 15 * 60_000)) ?? [];
		const surge = (riseOf(recent) ?? 0) >= 5;
		if (!surge && !isDanger(row.h5) && !isDanger(row.d7)) return;
		// 처음 수집 중이거나 수집이 멈춘 상태에서 진단하면 일부 기록만 보고 원인을 잘못 짚으므로 건너뜀
		const ingestedAt = withStore((s) => s.getMeta<number>("ingested_at")) ?? 0;
		if (now - ingestedAt > 3 * 60_000) return;
		const report = buildReport(row.id, now - 3600_000, now);
		if (!report) return;
		const cause = report.causes[0];
		row.cause = cause?.label ?? "뚜렷한 원인 없음";

		const mine = report.sessions.find((s) => s.current);
		if (!cause || !mine || !lastCtx?.hasUI || report.cost <= 0 || mine.cost / report.cost < 0.2) return;
		if (now - (alertedAt.get(row.id) ?? 0) < 30 * 60_000) return;
		alertedAt.set(row.id, now);
		lastCtx.ui.notify(
			`${row.name} 사용량 급증: ${cause.label}. 이 세션이 최근 1시간 비용의 ${percent(mine.cost / report.cost)}를 차지합니다. ${cause.action}. 자세한 내용은 /quota why`,
			"warning",
		);
	};

	// ── 조회 ──
	// 조회 결과를 패널에 반영하고, 저장된 표본으로 소모 속도와 원인을 붙임
	let lastStatus: Status | undefined;
	const apply = (status: Status) => {
		lastStatus = status;
		const now = Date.now();
		panel.rows = status.rows.map((r) => {
			const row: Row = { ...r, cause: undefined };
			for (const key of ["5h", "7d"] as const) {
				const prop = key === "5h" ? "h5" : "d7";
				const w = row[prop];
				if (!w) continue;
				const samples = withStore((s) => s.samples(r.id, key, now - TREND[key].span)) ?? [];
				row[prop] = { pct: w.pct, resetAt: w.resetAt, trend: trendOf(samples, w, key) };
			}
			diagnose(row, now);
			return row;
		});
		panel.updatedAt = status.fetchedAt;
		panel.loading = false;
		rerender?.();
		// 패널을 숨겨도 하단 상태줄에서 사용률과 급증 여부를 볼 수 있게 함
		try {
			lastCtx?.ui.setStatus(STATUS_KEY, statusText(panel.rows));
		} catch {}
	};

	const record = (status: Status) =>
		withStore((s) =>
			s.transaction(() => {
				for (const r of status.rows) {
					if (r.error) continue;
					if (r.h5) s.addSample(r.id, "5h", status.fetchedAt, r.h5.pct, r.h5.resetAt);
					if (r.d7) s.addSample(r.id, "7d", status.fetchedAt, r.d7.pct, r.d7.resetAt);
				}
				s.setMeta("status", status);
			}),
		);

	/**
	 * 여러 pi 프로세스가 같은 DB를 공유하므로, 최근 조회 결과가 있으면 API를 부르지 않고 그 결과를 씁.
	 * API는 'fetch' 임대를 잡은 한 프로세스만 부름. force면 최근 결과가 있어도 다시 조회
	 */
	const refresh = (ctx: ExtensionContext, force = false) => {
		if (refreshing) return refreshing;
		refreshing = (async () => {
			const shared = withStore((s) => s.getMeta<Status>("status"));
			if (!force && shared && Date.now() - shared.fetchedAt < REFRESH_MS - 15_000) {
				apply(shared);
				return;
			}
			const leased = withStore((s) => s.tryLease("fetch", 30_000));
			if (leased === false) {
				// 다른 프로세스가 조회 중이면 그 결과는 다음 동기화(30초)에서 받음
				if (shared) apply(shared);
				return;
			}
			try {
				panel.loading = true;
				rerender?.();
				const rows = await Promise.all([fetchAnthropic(ctx), fetchCodex(ctx)]);
				const status: Status = { fetchedAt: Date.now(), rows: rows.filter((r): r is Row => r !== null) };
				record(status);
				apply(status);
			} finally {
				if (leased) withStore((s) => s.release("fetch"));
			}
		})().finally(() => {
			refreshing = undefined;
		});
		return refreshing;
	};

	/**
	 * 다른 프로세스가 더 새 결과를 저장했으면 가져옴. 새 결과가 없어도 다시 적용해서,
	 * 다른 프로세스가 수집한 턴으로 원인 진단을 갱신함
	 */
	const syncFromStore = () => {
		if (refreshing) return;
		const shared = withStore((s) => s.getMeta<Status>("status"));
		if (shared && shared.fetchedAt > panel.updatedAt) apply(shared);
		else if (lastStatus) apply(lastStatus);
	};

	/**
	 * 세션 기록 증분 수집. 한 프로세스만 수집하도록 'ingest' 임대를 잡고, 다른 프로세스가 50초 안에
	 * 수집을 끝냈으면 건너뜀(기기 전체에서 1분에 한 번만 세션 파일을 훑음). force는 /quota why처럼 지금 바로 최신이어야 할 때.
	 * 처음 쌓인 기록이 많으면 한 번에 다 읽지 않고 1초 간격으로 나눠 읽어 pi가 멈추지 않게 함
	 */
	const ingest = (force = false): void => {
		const r = withStore((s) => {
			if (!force && Date.now() - (s.getMeta<number>("ingested_at") ?? 0) < 50_000) return undefined;
			if (!s.tryLease("ingest", 120_000)) return undefined;
			try {
				const r = s.ingest();
				if (!r.more) {
					s.prune();
					// 세션 기록을 끝까지 수집한 시각. 원인 진단은 이 값이 최근일 때만 함
					s.setMeta("ingested_at", Date.now());
				}
				return r;
			} finally {
				s.release("ingest");
			}
		});
		// 새 턴이 들어왔으면 원인 진단을 다시 함(시작 직후 수집 전에 진단해 '외부 사용'으로 잘못 보이는 것 방지)
		if (r?.added && lastStatus) apply(lastStatus);
		if (r?.more && collecting) setTimeout(() => ingest(), 1_000).unref?.();
	};

	// /login이 끝나면 auth.json이 바뀌므로, 로그인이 필요한 계정이 있거나 계정 목록이 달라졌을 때만 다시 조회
	const authFingerprint = () => {
		try {
			return String(statSync(authFile).mtimeMs);
		} catch {
			return "";
		}
	};
	const watchAuth = (ctx: ExtensionContext) => {
		const stamp = authFingerprint();
		if (stamp === authStamp) return;
		authStamp = stamp;
		const auth = readAuthFile();
		const configured = PROVIDERS.filter((p) => auth[p.id]).map((p) => p.id).join(",");
		const shown = panel.rows.map((r) => r.id).join(",");
		if (configured !== shown || panel.rows.some((r) => r.needsLogin)) void refresh(ctx, true);
	};

	const stopTimers = () => {
		if (timer) clearInterval(timer);
		if (tick) clearInterval(tick);
		if (authWatch) clearInterval(authWatch);
		if (ingestTimer) clearInterval(ingestTimer);
		if (ingestKick) clearTimeout(ingestKick);
		timer = tick = authWatch = ingestTimer = ingestKick = undefined;
	};

	// ── 수집 ──
	/**
	 * 패널을 숨겨도 이력 수집과 급증 경고가 이어지도록, TUI 세션이 시작되면 수집 타이머를 켬.
	 * 같은 기기의 pi 프로세스마다 타이머가 돌지만 'fetch'·'ingest' 임대와 최신 여부 검사 때문에
	 * 실제 API 조회(3분)와 세션 기록 수집(1분)은 기기 전체에서 한 번씩만 일어남.
	 * RPC·print 모드(pi-subagents 자식 등)에서는 켜지 않음
	 */
	const startCollector = (ctx: ExtensionContext) => {
		lastCtx = ctx;
		if (collecting) return;
		collecting = true;
		authStamp = authFingerprint();
		// 공유 결과가 최신이면 API를 부르지 않고 그 결과를 씀
		void refresh(ctx);
		timer = setInterval(() => void refresh(ctx), REFRESH_MS);
		// 남은 시간 표시를 갱신하고, 다른 프로세스가 저장한 더 새 결과와 수집한 턴으로 다시 진단함
		tick = setInterval(() => {
			syncFromStore();
			rerender?.();
		}, 30_000);
		authWatch = setInterval(() => watchAuth(ctx), 3_000);
		// 세션 기록 수집은 시작 직후를 피해 조금 뒤에 처음 실행하고, 이후 1분마다 실행
		ingestKick = setTimeout(() => ingest(), 5_000);
		ingestTimer = setInterval(() => ingest(), 60_000);
		for (const t of [timer, tick, authWatch, ingestKick, ingestTimer]) t.unref?.();
	};

	const stopCollector = () => {
		stopTimers();
		collecting = false;
	};

	// ── 로그인 ──
	// 확장은 /login 같은 내장 명령을 직접 실행할 수 없으므로 입력창에 명령을 채워 두고 Enter를 안내함
	const startLogin = async (ctx: ExtensionContext, id?: ProviderId) => {
		if (!id) {
			const failing = panel.rows.filter((r) => r.needsLogin);
			if (failing.length === 1) id = failing[0].id;
			else {
				const choices = PROVIDERS.map((p) => {
					const r = panel.rows.find((x) => x.id === p.id);
					const state = !r ? "로그인 안 됨" : r.needsLogin ? "로그인 필요" : r.error ? "조회 오류" : "로그인됨";
					return `${p.name} (${state})`;
				});
				const picked = await ctx.ui.select("어느 계정에 로그인할까요?", choices);
				if (!picked) return;
				id = PROVIDERS[choices.indexOf(picked)].id;
			}
		}
		const name = PROVIDERS.find((p) => p.id === id)?.name ?? id;
		if (ctx.ui.getEditorText().trim()) {
			const ok = await ctx.ui.confirm("입력창 바꾸기", "입력 중인 내용을 지우고 /login 명령을 넣을까요?");
			if (!ok) return;
		}
		ctx.ui.setEditorText(`/login ${id}`);
		ctx.ui.notify(`Enter를 누르면 ${name} 로그인을 시작합니다. 로그인이 끝나면 패널이 자동으로 갱신됩니다.`, "info");
	};

	// ── 표시 ──
	const show = (ctx: ExtensionContext) => {
		visible = true;
		lastCtx = ctx;
		if (handle) {
			handle.setHidden(false);
		} else {
			void ctx.ui.custom<void>(
				(t, _theme, _kb, done) => {
					tui = t;
					rerender = () => t.requestRender();
					close = () => done();
					return {
						render: (width: number) => panel.render(width),
						invalidate: () => panel.invalidate(),
						// fullscreen 모드에서만 마우스 이벤트가 overlay로 전달됨. 패널 어디를 잡아도 끌어 옮길 수 있음
						handleMouse(event: TuiMouseEvent) {
							// 움직이지 않고 놓으면 click이 옴. '로그인 필요' 줄을 누르면 로그인 시작
							if (event.type === "click") {
								const target = panel.loginLines.get(event.y);
								if (target !== undefined && lastCtx) void startLogin(lastCtx, target?.id);
								// '원인:' 줄을 누르면 그 계정의 원인 분석을 엶
								const why = panel.whyLines.get(event.y);
								if (why && lastCtx) void showWhy(lastCtx, why.id);
								return { handled: true };
							}
							if (event.type === "press" && event.button === "left") {
								drag = { x: event.screenX, y: event.screenY, ox: options.offsetX ?? 0, oy: options.offsetY ?? 0 };
								panel.moving = true;
								return { capture: true, render: true };
							}
							if (!drag) return undefined;
							if (event.type === "drag" || event.type === "move") {
								placeAt(drag.ox + event.screenX - drag.x, drag.oy + event.screenY - drag.y);
								return { handled: true, capture: true, render: true };
							}
							if (event.type === "release") {
								savePosition();
								drag = undefined;
								panel.moving = false;
								return { handled: true, render: true };
							}
							return { handled: true, capture: true };
						},
					};
				},
				{
					overlay: true,
					overlayOptions: options,
					onHandle: (h) => {
						handle = h;
					},
				},
			).finally(() => {
				handle = undefined;
				close = undefined;
				rerender = undefined;
				tui = undefined;
				drag = undefined;
				panel.moving = false;
			});
		}
		// 패널을 켤 때는 수집 상태와 상관없이 바로 최신 결과를 보여 줌(공유 결과가 최신이면 API는 부르지 않음)
		if (ctx.mode === "tui") startCollector(ctx);
		if (lastStatus) apply(lastStatus);
		void refresh(ctx);
	};

	// 패널만 숨기고 수집과 경고는 계속함
	const hide = () => {
		visible = false;
		handle?.setHidden(true);
	};

	const toggle = (ctx: ExtensionContext) => (visible ? hide() : show(ctx));

	// ── 원인 분석 화면(/quota why) ──
	let whyOpen = false;
	const showWhy = async (ctx: ExtensionContext, id?: ProviderId, rangeMs?: number) => {
		if (whyOpen) return;
		if (!getStore()) {
			ctx.ui.notify("이력 DB를 열 수 없어 원인을 분석할 수 없습니다 (node:sqlite 필요)", "error");
			return;
		}
		// 방금 쓴 턴까지 반영되도록 먼저 수집
		ingest(true);
		const ids = PROVIDERS.map((p) => p.id);
		// 계정을 고르지 않았으면 원인이 표시된 계정, 없으면 최근 1시간에 비용이 가장 큰 계정
		let index = ids.indexOf(
			id ??
				panel.rows.find((r) => r.cause)?.id ??
				ids
					.map((p) => ({ p, cost: buildReport(p, Date.now() - 3600_000, Date.now())?.cost ?? 0 }))
					.sort((a, b) => b.cost - a.cost)[0].p,
		);
		let range = Math.max(0, WHY_RANGES.findIndex((r) => r.ms === (rangeMs ?? 3600_000)));
		let report = buildReport(ids[index], Date.now() - WHY_RANGES[range].ms, Date.now());
		const rebuild = () => {
			report = buildReport(ids[index], Date.now() - WHY_RANGES[range].ms, Date.now());
		};
		whyOpen = true;
		try {
			await ctx.ui.custom<void>((t, _theme, _kb, done) => ({
				render: (width: number) =>
					[...whyLines(report, WHY_RANGES[range].label), fg(C.dim, "tab 계정 전환 · ←→ 기간 변경 · esc 닫기")].map((l) =>
						truncateToWidth(l, width),
					),
				invalidate() {},
				handleInput(data: string) {
					if (matchesKey(data, Key.tab)) index = (index + 1) % ids.length;
					else if (matchesKey(data, Key.left)) range = Math.max(0, range - 1);
					else if (matchesKey(data, Key.right)) range = Math.min(WHY_RANGES.length - 1, range + 1);
					else if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter) || data === "q") {
						done();
						return;
					} else return;
					rebuild();
					t.requestRender();
				},
			}));
		} finally {
			whyOpen = false;
		}
	};

	// ── 키보드 이동 모드 ──
	// 일반 모드에서는 마우스가 터미널 몫이라 드래그가 안 되므로, 방향키로 옮기는 길을 따로 둠
	const startMove = async (ctx: ExtensionContext) => {
		if (!visible) show(ctx);
		const origin = { x: options.offsetX ?? 0, y: options.offsetY ?? 0 };
		panel.moving = true;
		rerender?.();
		const keys: [KeyId, string | undefined, number, number][] = [
			["left", "h", -STEP.x, 0],
			["right", "l", STEP.x, 0],
			["up", "k", 0, -STEP.y],
			["down", "j", 0, STEP.y],
			["shift+left", "H", -BIG_STEP.x, 0],
			["shift+right", "L", BIG_STEP.x, 0],
			["shift+up", "K", 0, -BIG_STEP.y],
			["shift+down", "J", 0, BIG_STEP.y],
		];
		const saved = await ctx.ui.custom<boolean>((t, _theme, _kb, done) => ({
			render: (width: number) => [
				truncateToWidth(
					`${bold(fg(C.title, "사용 한도 패널 이동"))}  ${fg(C.label, "←↑↓→/hjkl 이동 · shift 크게 · r 기본 위치 · enter 저장 · esc 취소")}`,
					width,
				),
			],
			invalidate() {},
			handleInput(data: string) {
				tui ??= t;
				for (const [key, vim, dx, dy] of keys) {
					if (matchesKey(data, key) || data === vim) {
						moveBy(dx, dy);
						return;
					}
				}
				if (data === "r") placeAt(0, 0);
				else if (matchesKey(data, Key.enter)) done(true);
				else if (matchesKey(data, Key.escape)) done(false);
			},
		}));
		panel.moving = false;
		if (saved) {
			savePosition();
			ctx.ui.notify("패널 위치를 저장했습니다", "info");
		} else placeAt(origin.x, origin.y);
		rerender?.();
	};

	const moveByArgs = async (ctx: ExtensionContext, dir: string, count?: string) => {
		const corners: Record<string, [number, number]> = {
			"top-right": [0, 0],
			"top-left": [-Infinity, 0],
			"bottom-right": [0, Infinity],
			"bottom-left": [-Infinity, Infinity],
		};
		const n = count === undefined ? undefined : Number(count);
		if (n !== undefined && !(Number.isInteger(n) && n > 0)) {
			ctx.ui.notify(`칸 수는 양의 정수여야 합니다: ${count}`, "error");
			return;
		}
		// 조회가 끝나야 패널 높이가 정해지므로 처음 띄울 때는 기다렸다가 옮김
		if (!visible) {
			show(ctx);
			await refreshing;
		}
		if (corners[dir]) placeAt(...corners[dir]);
		else if (dir === "left") moveBy(-(n ?? BIG_STEP.x), 0);
		else if (dir === "right") moveBy(n ?? BIG_STEP.x, 0);
		else if (dir === "up") moveBy(0, -(n ?? BIG_STEP.y));
		else if (dir === "down") moveBy(0, n ?? BIG_STEP.y);
		else {
			ctx.ui.notify(`알 수 없는 방향: ${dir} (${MOVE_ARGS.join(", ")})`, "error");
			return;
		}
		savePosition();
	};

	// ctrl+shift+u는 Linux 입력기(fcitx5/IBus)의 유니코드 입력 단축키와 겹칠 수 있어 alt+u도 함께 등록
	for (const key of ["ctrl+shift+u", "alt+u"] as const) {
		pi.registerShortcut(key, {
			description: "사용 한도 패널 토글",
			handler: async (ctx) => {
				if (ctx.hasUI) toggle(ctx);
			},
		});
	}

	pi.registerCommand("quota", {
		description: "사용 한도 패널 (on|off|refresh|move|reset|login|why, 단축키 ctrl+shift+u / alt+u)",
		// 입력이 이미 완성된 값이면 목록을 닫아 둠. 목록이 열려 있으면 Enter가 제출 대신 완성에 쓰임
		getArgumentCompletions: (prefix) => {
			const [verb, ...rest] = prefix.trimStart().split(/\s+/);
			if (rest.length === 1 && (verb === "move" || verb === "login")) {
				const values = verb === "move" ? MOVE_ARGS : PROVIDERS.map((p) => p.aliases[0]);
				if (values.includes(rest[0])) return null;
				return values.filter((v) => v.startsWith(rest[0])).map((v) => ({ value: `${verb} ${v}`, label: v }));
			}
			if (verb === "why" && rest.length >= 1 && rest.length <= 2) {
				const last = rest[rest.length - 1];
				const values = [...PROVIDERS.map((p) => p.aliases[0]), ...WHY_RANGES.map((r) => r.arg)];
				if (values.includes(last)) return null;
				const before = [verb, ...rest.slice(0, -1)].join(" ");
				return values.filter((v) => v.startsWith(last)).map((v) => ({ value: `${before} ${v}`, label: v }));
			}
			if (rest.length || VERBS.some((v) => v.value === verb)) return null;
			return VERBS.filter((v) => v.value.startsWith(verb)).map((v) => ({ ...v, label: v.value }));
		},
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			const [verb = "", ...rest] = String(args ?? "").trim().split(/\s+/);
			if (verb === "on") show(ctx);
			else if (verb === "off") hide();
			else if (verb === "reset") {
				// 기본 위치(오른쪽 위)로 되돌림
				if (!visible) show(ctx);
				placeAt(0, 0);
				savePosition();
			} else if (verb === "move") {
				if (rest.length) await moveByArgs(ctx, rest[0], rest[1]);
				else await startMove(ctx);
			} else if (verb === "login") {
				// 어느 계정이 로그인을 요구하는지 알아야 하므로 처음 띄울 때는 조회를 기다림
				if (!visible) {
					show(ctx);
					await refreshing;
				}
				const ref = rest[0]?.toLowerCase();
				const provider = ref ? PROVIDERS.find((p) => p.aliases.includes(ref)) : undefined;
				if (ref && !provider) {
					ctx.ui.notify(`알 수 없는 계정: ${rest[0]} (claude, codex)`, "error");
					return;
				}
				await startLogin(ctx, provider?.id);
			} else if (verb === "why") {
				// 인자 순서는 상관없음: /quota why codex 3h, /quota why 30m
				let provider: ProviderId | undefined;
				let rangeMs: number | undefined;
				for (const arg of rest.map((a) => a.toLowerCase())) {
					const p = PROVIDERS.find((x) => x.aliases.includes(arg));
					const r = WHY_RANGES.find((x) => x.arg === arg);
					if (p) provider = p.id;
					else if (r) rangeMs = r.ms;
					else {
						ctx.ui.notify(`알 수 없는 인자: ${arg} (claude, codex, ${WHY_RANGES.map((x) => x.arg).join(", ")})`, "error");
						return;
					}
				}
				lastCtx ??= ctx;
				await showWhy(ctx, provider, rangeMs);
			} else if (verb === "refresh") {
				if (!visible) show(ctx);
				else await refresh(ctx, true);
			} else toggle(ctx);
		},
	});

	pi.on("session_start", (event, ctx) => {
		if (ctx.mode !== "tui") return;
		startCollector(ctx);
		// 같은 확장 인스턴스에서 세션만 바뀐 경우(/new, /resume, /fork) 패널을 켜 두었으면 다시 띄움
		if (wasVisible && event.reason !== "startup") show(ctx);
		wasVisible = false;
	});

	pi.on("session_shutdown", () => {
		wasVisible = visible;
		visible = false;
		stopCollector();
		close?.();
		try {
			lastCtx?.ui.setStatus(STATUS_KEY, undefined);
		} catch {}
		store?.close();
		store = undefined;
	});
}
