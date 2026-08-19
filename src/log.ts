/**
 * Debug logger for pi-status-anim. Off by default.
 *
 * Enable with `PI_STATUS_ANIM_LOG=1`. Writes one file per session to
 * `~/.pi/agent/logs/status-anim-<sid>.log` (or `$PI_CODING_AGENT_DIR/logs/`),
 * so sessions are trivially separable. One line per event, append-only:
 *   `<isoTs> <sid8> <tag> key=val key=val ...`
 *
 * When disabled, every method is a no-op with zero overhead.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const ENV_VAR = "PI_STATUS_ANIM_LOG";

/** Minimal context shape needed to resolve the session id. */
export interface LogCtx {
	sessionManager: { getSessionId(): string };
}

export interface Logger {
	event(tag: string, ctx: LogCtx | null, fields?: Record<string, unknown>): void;
}

function expandTilde(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return join(homedir(), p.slice(2));
	return p;
}

function logDir(): string {
	const envDir = process.env.PI_CODING_AGENT_DIR;
	const base = envDir ? expandTilde(envDir) : join(homedir(), ".pi", "agent");
	return join(base, "logs");
}

function fmt(v: unknown): string {
	if (typeof v === "string") return v;
	if (typeof v === "number" || typeof v === "boolean") return String(v);
	if (v === null) return "null";
	if (v === undefined) return "undef";
	try {
		return JSON.stringify(v);
	} catch {
		return String(v);
	}
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
/** Strip ANSI escapes for a readable log field. */
export function stripAnsi(s: string): string {
	return s.replace(ANSI, "");
}

const noop: Logger = { event() {} };

export function createLogger(): Logger {
	if (process.env[ENV_VAR] !== "1") return noop;
	const dir = logDir();
	let path = "";
	let sid = "";
	const ts = (): string => new Date().toISOString();
	const open = (ctx: LogCtx | null): void => {
		if (path) return;
		try {
			sid = ctx ? ctx.sessionManager.getSessionId().slice(0, 8) || "nosession" : "nosession";
		} catch {
			sid = "nosession";
		}
		path = join(dir, `status-anim-${sid}.log`);
		try {
			mkdirSync(dirname(path), { recursive: true });
		} catch {
			// fall through; appendFileSync will fail silently per-line
		}
	};
	return {
		event(tag, ctx, fields) {
			open(ctx);
			let line = `${ts()} ${sid} ${tag}`;
			if (fields) for (const [k, v] of Object.entries(fields)) line += ` ${k}=${fmt(v)}`;
			try {
				appendFileSync(path, line + "\n");
			} catch {
				// never let logging crash the extension
			}
		},
	};
}
