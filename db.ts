/**
 * 사용 이력 저장소(~/.pi/agent/quota-panel.db).
 * - quota_samples: 사용량 API에서 받은 5h·7d 사용률 표본
 * - turns: pi 세션 JSONL에서 모은 턴별 토큰·비용(대화 내용은 저장하지 않음)
 * - file_offsets: 세션 파일마다 어디까지 읽었는지(증분 수집)
 * - lease: 여러 pi 프로세스 가운데 한 곳만 API 조회·수집을 하도록 잡는 임대
 * - meta: 마지막 조회 결과 등 공유 상태
 * node:sqlite가 없거나 열지 못하면 openStore()가 undefined를 돌려주고, 패널은 이력 없이 동작함
 */
import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, relative, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";

const SCHEMA_VERSION = 1;
const RETENTION_MS = 60 * 24 * 3600_000;
/** 한 번의 수집에서 읽는 최대 바이트. 동기 API가 pi를 멈추는 시간을 제한함 */
const INGEST_BUDGET = 8 * 1024 * 1024;

export const dbFile = join(homedir(), ".pi/agent/quota-panel.db");
export const sessionsDir = join(homedir(), ".pi/agent/sessions");

export type WindowKey = "5h" | "7d";
export type Sample = { at: number; pct: number };

function loadSqlite(): typeof import("node:sqlite") | undefined {
	// Node 22에서는 node:sqlite를 처음 불러올 때 ExperimentalWarning을 stderr로 출력해 TUI 화면이 깨지므로 그 경고만 걸러 냄
	const original = process.emitWarning;
	process.emitWarning = function (this: unknown, warning: string | Error, ...rest: unknown[]) {
		const text = typeof warning === "string" ? warning : warning?.message;
		if (/SQLite/i.test(text ?? "")) return;
		return (original as (...args: unknown[]) => void).call(process, warning, ...rest);
	} as typeof process.emitWarning;
	try {
		return process.getBuiltinModule?.("node:sqlite") as typeof import("node:sqlite") | undefined;
	} catch {
		return undefined;
	} finally {
		process.emitWarning = original;
	}
}

export class Store {
	private readonly owner = `${hostname()}:${process.pid}:${Math.random().toString(36).slice(2, 8)}`;

	private readonly db: DatabaseSync;

	constructor(db: DatabaseSync) {
		this.db = db;
	}

	// ── 임대 ──
	/** 다른 프로세스가 유효한 임대를 갖고 있지 않으면 잡음. 같은 프로세스는 다시 잡을 수 있음 */
	tryLease(name: string, ms: number): boolean {
		const now = Date.now();
		const r = this.db
			.prepare(
				`INSERT INTO lease(name, owner, until) VALUES (?, ?, ?)
				 ON CONFLICT(name) DO UPDATE SET owner = excluded.owner, until = excluded.until
				 WHERE lease.until < ? OR lease.owner = excluded.owner`,
			)
			.run(name, this.owner, now + ms, now);
		return Number(r.changes) > 0;
	}

	release(name: string) {
		this.db.prepare("DELETE FROM lease WHERE name = ? AND owner = ?").run(name, this.owner);
	}

	// ── 공유 상태 ──
	getMeta<T>(key: string): T | undefined {
		const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
		if (!row) return undefined;
		try {
			return JSON.parse(row.value) as T;
		} catch {
			return undefined;
		}
	}

	setMeta(key: string, value: unknown) {
		this.db
			.prepare("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
			.run(key, JSON.stringify(value));
	}

	// ── 사용률 표본 ──
	addSample(provider: string, window: WindowKey, at: number, pct: number, resetsAt: number) {
		this.db
			.prepare(
				`INSERT OR IGNORE INTO quota_samples(provider, window, fetched_at, used_pct, resets_at, host)
				 VALUES (?, ?, ?, ?, ?, ?)`,
			)
			.run(provider, window, at, pct, Number.isFinite(resetsAt) ? resetsAt : null, hostname());
	}

	samples(provider: string, window: WindowKey, since: number): Sample[] {
		return (
			this.db
				.prepare(
					`SELECT fetched_at AS at, used_pct AS pct FROM quota_samples
					 WHERE provider = ? AND window = ? AND fetched_at >= ? ORDER BY fetched_at`,
				)
				.all(provider, window, since) as Sample[]
		).map((r) => ({ at: Number(r.at), pct: Number(r.pct) }));
	}

	transaction(fn: () => void) {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			fn();
			this.db.exec("COMMIT");
		} catch (e) {
			this.db.exec("ROLLBACK");
			throw e;
		}
	}

	// ── 세션 수집 ──
	/**
	 * 세션 JSONL에서 새로 추가된 줄만 읽어 turns에 넣음. 한 번에 INGEST_BUDGET 바이트까지만 읽고,
	 * 남은 분량은 다음 호출에서 이어서 읽음. more가 true면 아직 읽지 않은 분량이 남아 있음
	 */
	ingest(dir = sessionsDir): { added: number; more: boolean } {
		const files = listSessionFiles(dir);
		const offsets = new Map(
			(this.db.prepare("SELECT session_file, offset, project, agent FROM file_offsets").all() as {
				session_file: string;
				offset: number;
				project: string | null;
				agent: string | null;
			}[]).map((r) => [r.session_file, r]),
		);
		const insertTurn = this.db.prepare(
			`INSERT OR IGNORE INTO turns(session_file, entry_id, ts, project, agent, kind, provider, model,
				input, output, cache_read, cache_write, reasoning, cost, stop_reason, duration_ms, tools)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		const saveOffset = this.db.prepare(
			`INSERT INTO file_offsets(session_file, offset, mtime, project, agent) VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(session_file) DO UPDATE SET offset = excluded.offset, mtime = excluded.mtime,
				project = excluded.project, agent = excluded.agent`,
		);

		let budget = INGEST_BUDGET;
		let added = 0;
		let more = false;
		for (const file of files) {
			if (budget <= 0) {
				more = true;
				break;
			}
			let st: ReturnType<typeof statSync>;
			try {
				st = statSync(file);
			} catch {
				continue;
			}
			const key = relative(dir, file);
			const prev = offsets.get(key);
			let offset = prev?.offset ?? 0;
			// 파일이 줄었으면 새로 쓰인 것으로 보고 처음부터 다시 읽음(중복은 기본 키로 걸러짐)
			if (st.size < offset) offset = 0;
			if (st.size === offset) continue;

			const length = Math.min(st.size - offset, budget);
			if (length < st.size - offset) more = true;
			budget -= length;
			const buf = Buffer.alloc(length);
			const fd = openSync(file, "r");
			try {
				readSync(fd, buf, 0, length, offset);
			} finally {
				closeSync(fd);
			}
			// 끝까지 쓰이지 않은 마지막 줄은 다음에 읽음
			const end = buf.lastIndexOf(0x0a) + 1;
			if (end === 0) {
				if (length === INGEST_BUDGET) {
					// 한 줄이 예산 전체보다 크면(큰 도구 결과 등) 읽은 만큼 건너뜀.
					// 다음에는 줄 중간부터 읽게 되지만 그 조각은 JSON 파싱에 실패해 버려짐
					saveOffset.run(key, offset + length, st.mtimeMs, prev?.project ?? null, prev?.agent ?? null);
				}
				// 예산이 모자라 줄이 잘렸으면 다음 호출에서 이어서 읽음
				continue;
			}

			let project = offset === 0 ? null : (prev?.project ?? null);
			let agent = offset === 0 ? "main" : (prev?.agent ?? "main");
			this.transaction(() => {
				for (const line of buf.subarray(0, end).toString("utf8").split("\n")) {
					if (!line) continue;
					let e: any;
					try {
						e = JSON.parse(line);
					} catch {
						continue;
					}
					if (e.type === "session") {
						project = typeof e.cwd === "string" ? e.cwd : project;
						if (e.parentSession) agent = "subagent";
						continue;
					}
					const turn = toTurn(e);
					if (!turn) continue;
					const r = insertTurn.run(
						key,
						turn.id,
						turn.ts,
						project ?? projectFromDir(key),
						agent,
						turn.kind,
						turn.provider,
						turn.model,
						turn.input,
						turn.output,
						turn.cacheRead,
						turn.cacheWrite,
						turn.reasoning,
						turn.cost,
						turn.stopReason,
						turn.durationMs,
						turn.tools,
					);
					added += Number(r.changes);
				}
				saveOffset.run(key, offset + end, st.mtimeMs, project, agent);
			});
		}
		return { added, more };
	}

	/** 보관 기간이 지난 표본과 턴을 지움. 하루에 한 번만 실행 */
	prune() {
		const last = this.getMeta<number>("pruned_at") ?? 0;
		if (Date.now() - last < 24 * 3600_000) return;
		const cutoff = Date.now() - RETENTION_MS;
		this.transaction(() => {
			this.db.prepare("DELETE FROM quota_samples WHERE fetched_at < ?").run(cutoff);
			this.db.prepare("DELETE FROM turns WHERE ts < ?").run(cutoff);
			this.setMeta("pruned_at", Date.now());
		});
	}

	close() {
		try {
			this.db.close();
		} catch {}
	}
}

type Turn = {
	id: string;
	ts: number;
	kind: string;
	provider: string | null;
	model: string | null;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning: number;
	cost: number;
	stopReason: string | null;
	durationMs: number | null;
	tools: string | null;
};

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** assistant 메시지와 대화 밖의 usage 항목(cache_warm 등)을 턴으로 바꿈 */
function toTurn(e: any): Turn | undefined {
	const fromUsage = (u: any) => ({
		input: num(u?.input),
		output: num(u?.output),
		cacheRead: num(u?.cacheRead),
		cacheWrite: num(u?.cacheWrite),
		reasoning: num(u?.reasoning),
		cost: num(u?.cost?.total),
	});
	if (e.type === "message" && e.message?.role === "assistant" && e.message.usage && typeof e.id === "string") {
		const m = e.message;
		const tools = Array.isArray(m.content)
			? m.content.filter((c: any) => c?.type === "toolCall" && typeof c.name === "string").map((c: any) => c.name)
			: [];
		return {
			id: e.id,
			ts: typeof m.timestamp === "number" ? m.timestamp : Date.parse(e.timestamp),
			kind: "turn",
			provider: m.provider ?? null,
			model: m.model ?? null,
			...fromUsage(m.usage),
			stopReason: m.stopReason ?? null,
			durationMs: typeof m.durationMs === "number" ? m.durationMs : null,
			tools: tools.length ? tools.join(",") : null,
		};
	}
	if (e.type === "usage" && e.usage && typeof e.id === "string") {
		return {
			id: e.id,
			ts: Date.parse(e.timestamp),
			kind: typeof e.kind === "string" ? e.kind : "usage",
			provider: e.provider ?? null,
			model: e.model ?? null,
			...fromUsage(e.usage),
			stopReason: null,
			durationMs: null,
			tools: null,
		};
	}
	return undefined;
}

/** 세션 헤더에 cwd가 없을 때 디렉터리 이름(--home-user-proj--)으로 대신함 */
function projectFromDir(key: string) {
	return key.split(sep)[0] ?? key;
}

/** sessions 아래의 모든 세션 JSONL(서브에이전트 run 포함). subagent-artifacts의 transcript는 같은 내용이라 제외 */
function listSessionFiles(dir: string): string[] {
	const out: string[] = [];
	const walk = (d: string, depth: number) => {
		let entries;
		try {
			entries = readdirSync(d, { withFileTypes: true });
		} catch {
			return;
		}
		for (const ent of entries) {
			const p = join(d, ent.name);
			if (ent.isDirectory()) {
				if (ent.name !== "subagent-artifacts" && depth < 6) walk(p, depth + 1);
			} else if (ent.isFile() && ent.name.endsWith(".jsonl")) out.push(p);
		}
	};
	walk(dir, 0);
	return out;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS lease (name TEXT PRIMARY KEY, owner TEXT NOT NULL, until INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS quota_samples (
	provider TEXT NOT NULL,
	window TEXT NOT NULL,
	fetched_at INTEGER NOT NULL,
	used_pct REAL NOT NULL,
	resets_at INTEGER,
	host TEXT NOT NULL,
	PRIMARY KEY (provider, window, fetched_at)
);
CREATE TABLE IF NOT EXISTS turns (
	session_file TEXT NOT NULL,
	entry_id TEXT NOT NULL,
	ts INTEGER NOT NULL,
	project TEXT NOT NULL,
	agent TEXT NOT NULL,
	kind TEXT NOT NULL,
	provider TEXT,
	model TEXT,
	input INTEGER NOT NULL,
	output INTEGER NOT NULL,
	cache_read INTEGER NOT NULL,
	cache_write INTEGER NOT NULL,
	reasoning INTEGER NOT NULL,
	cost REAL NOT NULL,
	stop_reason TEXT,
	duration_ms INTEGER,
	tools TEXT,
	PRIMARY KEY (session_file, entry_id)
);
CREATE INDEX IF NOT EXISTS turns_ts ON turns(ts);
CREATE TABLE IF NOT EXISTS file_offsets (
	session_file TEXT PRIMARY KEY,
	offset INTEGER NOT NULL,
	mtime REAL NOT NULL,
	project TEXT,
	agent TEXT
);
`;

export function openStore(file = dbFile): Store | undefined {
	const sqlite = loadSqlite();
	if (!sqlite) return undefined;
	let db: DatabaseSync | undefined;
	try {
		db = new sqlite.DatabaseSync(file);
		db.exec("PRAGMA busy_timeout = 3000");
		db.exec("PRAGMA journal_mode = WAL");
		db.exec("PRAGMA synchronous = NORMAL");
		const version = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
		if (version > SCHEMA_VERSION) {
			// 더 새로운 버전이 만든 DB는 건드리지 않음
			db.close();
			return undefined;
		}
		if (version < SCHEMA_VERSION) {
			db.exec("BEGIN IMMEDIATE");
			db.exec(SCHEMA);
			db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
			db.exec("COMMIT");
		}
		return new Store(db);
	} catch {
		try {
			db?.close();
		} catch {}
		return undefined;
	}
}
