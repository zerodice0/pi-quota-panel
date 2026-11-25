/**
 * 우측 상단 사용 한도(quota) 패널: Anthropic / OpenAI Codex의 5h·7d 사용률과 리셋까지 남은 시간.
 * 토글: ctrl+shift+u, alt+u 또는 /quota (on|off|refresh|reset|move|login)
 * 위치는 /quota move(키보드)나 fullscreen 모드의 마우스 드래그로 옮기고, ~/.pi/agent/quota-panel.json에 저장됨
 */
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { KeyId, OverlayHandle, OverlayOptions, TUI, TuiMouseEvent } from "@earendil-works/pi-tui";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

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

type Win = { pct: number; resetAt: number } | null;
type Row = { id: ProviderId; name: string; h5: Win; d7: Win; error?: string; needsLogin?: boolean };

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
			wins.forEach(([label, w], j) => out.push(win(label, w, j === 0)));
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
];
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
	let visible = false;

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

	// ── 조회 ──
	const refresh = (ctx: ExtensionContext) => {
		if (refreshing) return refreshing;
		refreshing = (async () => {
			panel.loading = true;
			rerender?.();
			const rows = await Promise.all([fetchAnthropic(ctx), fetchCodex(ctx)]);
			panel.rows = rows.filter((r): r is Row => r !== null);
			panel.loading = false;
			panel.updatedAt = Date.now();
			rerender?.();
		})().finally(() => {
			refreshing = undefined;
		});
		return refreshing;
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
		if (configured !== shown || panel.rows.some((r) => r.needsLogin)) void refresh(ctx);
	};

	const stopTimers = () => {
		if (timer) clearInterval(timer);
		if (tick) clearInterval(tick);
		if (authWatch) clearInterval(authWatch);
		timer = tick = authWatch = undefined;
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
		stopTimers();
		authStamp = authFingerprint();
		void refresh(ctx);
		timer = setInterval(() => void refresh(ctx), REFRESH_MS);
		tick = setInterval(() => rerender?.(), 30_000); // 남은 시간 표시 갱신
		authWatch = setInterval(() => watchAuth(ctx), 3_000);
		timer.unref?.();
		tick.unref?.();
		authWatch.unref?.();
	};

	const hide = () => {
		visible = false;
		stopTimers();
		handle?.setHidden(true);
	};

	const toggle = (ctx: ExtensionContext) => (visible ? hide() : show(ctx));

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
		description: "사용 한도 패널 (on|off|refresh|move|reset|login, 단축키 ctrl+shift+u / alt+u)",
		// 입력이 이미 완성된 값이면 목록을 닫아 둠. 목록이 열려 있으면 Enter가 제출 대신 완성에 쓰임
		getArgumentCompletions: (prefix) => {
			const [verb, ...rest] = prefix.trimStart().split(/\s+/);
			if (rest.length === 1 && (verb === "move" || verb === "login")) {
				const values = verb === "move" ? MOVE_ARGS : PROVIDERS.map((p) => p.aliases[0]);
				if (values.includes(rest[0])) return null;
				return values.filter((v) => v.startsWith(rest[0])).map((v) => ({ value: `${verb} ${v}`, label: v }));
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
			} else if (verb === "refresh") {
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
