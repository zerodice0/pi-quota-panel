/**
 * 우측 상단 사용 한도(quota) 패널: Anthropic / OpenAI Codex의 5h·7d 사용률과 리셋까지 남은 시간.
 * 토글: ctrl+shift+u, alt+u 또는 /quota (on|off|refresh)
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

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

type Win = { pct: number; resetAt: number } | null;
type Row = { name: string; h5: Win; d7: Win; error?: string };

// ── 데이터 조회 ──────────────────────────────────────────────
function readAuthFile(): Record<string, any> {
	try {
		return JSON.parse(readFileSync(join(homedir(), ".pi/agent/auth.json"), "utf8"));
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
	if (res.status === 401 || res.status === 403) throw new Error("인증 만료 · /login 필요");
	if (!res.ok) throw new Error(`조회 실패 (HTTP ${res.status})`);
	return res.json() as Promise<any>;
}

async function fetchAnthropic(ctx: ExtensionContext): Promise<Row | null> {
	if (!readAuthFile().anthropic) return null;
	const row: Row = { name: "Claude", h5: null, d7: null };
	try {
		const token = await tokenFor(ctx, "anthropic");
		if (!token) throw new Error("인증 만료 · /login 필요");
		const j = await getJson("https://api.anthropic.com/api/oauth/usage", {
			Authorization: `Bearer ${token}`,
			"anthropic-beta": "oauth-2025-04-20",
		});
		const win = (w: any): Win =>
			w && typeof w.utilization === "number" ? { pct: w.utilization, resetAt: Date.parse(w.resets_at) } : null;
		row.h5 = win(j.five_hour);
		row.d7 = win(j.seven_day);
	} catch (e) {
		row.error = (e as Error).message;
	}
	return row;
}

async function fetchCodex(ctx: ExtensionContext): Promise<Row | null> {
	const cred = readAuthFile()["openai-codex"];
	if (!cred) return null;
	const row: Row = { name: "Codex", h5: null, d7: null };
	try {
		const token = await tokenFor(ctx, "openai-codex");
		if (!token) throw new Error("인증 만료 · /login 필요");
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
		row.error = (e as Error).message;
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

class QuotaPanel {
	rows: Row[] = [];
	loading = true;
	updatedAt = 0;

	invalidate() {}

	render(_width: number): string[] {
		const inner = WIDTH - 4;
		const line = (content: string) => {
			const t = truncateToWidth(content, inner);
			return `${BG}${fg(C.border, "│")} ${t}${" ".repeat(Math.max(0, inner - visibleWidth(t)))} ${fg(C.border, "│")}${BG_OFF}`;
		};

		const status = this.loading ? fg(C.dim, " 갱신 중… ") : this.updatedAt ? fg(C.dim, ` ${ago(this.updatedAt)} 갱신 `) : "";
		const title = ` ${bold(fg(C.title, "사용 한도"))} `;
		const topFill = WIDTH - 2 - visibleWidth(title) - visibleWidth(status) - 2;
		const out = [
			`${BG}${fg(C.border, "╭─")}${title}${fg(C.border, "─".repeat(Math.max(1, topFill)))}${status}${fg(C.border, "─╮")}${BG_OFF}`,
		];

		out.push(line("")); // 위쪽 여백
		if (!this.rows.length) {
			out.push(line(fg(C.dim, this.loading ? "불러오는 중…" : "로그인된 계정이 없습니다")));
		}

		this.rows.forEach((r, i) => {
			if (i > 0) out.push(line(""));
			if (r.error) {
				out.push(line(`${bold(fg(C.name, padName(r.name)))}${fg(C.crit, r.error)}`));
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
			wins.forEach(([label, w], j) => out.push(win(label, w, j === 0)));
		});

		out.push(line("")); // 아래쪽 여백
		out.push(`${BG}${fg(C.border, `╰${"─".repeat(WIDTH - 2)}╯`)}${BG_OFF}`);
		return out;
	}
}

// ── 확장 ────────────────────────────────────────────────────
export default function (pi: ExtensionAPI) {
	const panel = new QuotaPanel();
	let handle: { setHidden(h: boolean): void; isHidden(): boolean } | undefined;
	let close: (() => void) | undefined;
	let rerender: (() => void) | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let tick: ReturnType<typeof setInterval> | undefined;
	let visible = false;

	const refresh = async (ctx: ExtensionContext) => {
		panel.loading = true;
		rerender?.();
		const rows = await Promise.all([fetchAnthropic(ctx), fetchCodex(ctx)]);
		panel.rows = rows.filter((r): r is Row => r !== null);
		panel.loading = false;
		panel.updatedAt = Date.now();
		rerender?.();
	};

	const stopTimers = () => {
		if (timer) clearInterval(timer);
		if (tick) clearInterval(tick);
		timer = tick = undefined;
	};

	const show = (ctx: ExtensionContext) => {
		visible = true;
		if (handle) {
			handle.setHidden(false);
		} else {
			void ctx.ui.custom<void>(
				(tui, _theme, _kb, done) => {
					rerender = () => tui.requestRender();
					close = () => done();
					return panel;
				},
				{
					overlay: true,
					overlayOptions: {
						anchor: "top-right",
						width: WIDTH,
						margin: { top: 1, right: 1 },
						nonCapturing: true,
						visible: (w) => w >= WIDTH + 40,
					},
					onHandle: (h) => {
						handle = h;
					},
				},
			).finally(() => {
				handle = undefined;
				close = undefined;
				rerender = undefined;
			});
		}
		stopTimers();
		void refresh(ctx);
		timer = setInterval(() => void refresh(ctx), REFRESH_MS);
		tick = setInterval(() => rerender?.(), 30_000); // 남은 시간 표시 갱신
		timer.unref?.();
		tick.unref?.();
	};

	const hide = () => {
		visible = false;
		stopTimers();
		handle?.setHidden(true);
	};

	const toggle = (ctx: ExtensionContext) => (visible ? hide() : show(ctx));

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
		description: "사용 한도 패널 (on|off|refresh, 단축키 ctrl+shift+u / alt+u)",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			const a = String(args ?? "").trim();
			if (a === "on") show(ctx);
			else if (a === "off") hide();
			else if (a === "refresh") {
				if (!visible) show(ctx);
				else await refresh(ctx);
			} else toggle(ctx);
		},
	});

	pi.on("session_shutdown", () => {
		stopTimers();
		close?.();
	});
}
