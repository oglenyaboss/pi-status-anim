/**
 * Smoke test for the debug logger: drives the real extension factory with
 * logging enabled and a fake session manager, then asserts the per-session
 * log file is written with the expected event tags.
 *
 * Run: `PI_STATUS_ANIM_LOG=1 node --experimental-strip-types scripts/log-smoke.ts`
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import statusAnim from "../src/index.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
let checks = 0;
function check(name: string, cond: boolean, detail = ""): void {
	checks += 1;
	if (cond) {
		console.log(`  ok   ${name}`);
	} else {
		failures += 1;
		console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

Object.defineProperty(process.stdout, "columns", { value: 120, configurable: true });

// Isolated config + log dir under a temp PI_CODING_AGENT_DIR.
const base = mkdtempSync(join(tmpdir(), "pi-status-anim-log-"));
mkdirSync(join(base, "agent"));
writeFileSync(
	join(base, "agent", "settings.json"),
	JSON.stringify({
		statusAnim: {
			modelEggs: false,
			timeEggs: false,
			gitStatus: false,
			animChance: 0,
			funFacts: false,
			anxietyGradient: false,
			intervalMs: 50,
			tokenAfterMs: 0, // show tokens immediately
		},
	}),
);
process.env.PI_CODING_AGENT_DIR = join(base, "agent");
process.env.PI_STATUS_ANIM_LOG = "1";

const SID = "abc123def456"; // fake session id
const fakeTheme = {
	fg: (_t: string, text: string) => text,
	getFgAnsi: () => `\x1b[38;2;130;130;130m`,
	getColorMode: () => "truecolor",
};

const ui = { messages: [] as Array<string | undefined>, frames: undefined as string[] | undefined, label: undefined as string | undefined };
const ctx = {
	mode: "tui",
	ui: {
		setWorkingMessage: (m?: string) => void ui.messages.push(m),
		setWorkingIndicator: (o?: { frames?: string[] }) => void (ui.frames = o?.frames),
		setHiddenThinkingLabel: (l?: string) => void (ui.label = l),
		notify: () => {},
		theme: fakeTheme,
	},
	model: undefined,
	cwd: "/tmp",
	hasPendingMessages: () => false,
	sessionManager: { getSessionId: () => SID },
};

const handlers: Record<string, Array<(e: any, c: any) => void>> = {};
const pi = {
	on: (ev: string, h: (e: any, c: any) => void) => void (handlers[ev] ??= []).push(h),
	registerCommand: () => {},
	exec: async () => ({ stdout: "", stderr: "", code: 1, killed: false }),
} as unknown as ExtensionAPI;
const fire = (ev: string, event: unknown) => {
	for (const h of handlers[ev] ?? []) h(event, ctx);
};

async function main(): Promise<void> {
	statusAnim(pi);

	fire("agent_start", {});
	await sleep(60);
	// Stream a thinking block in two chunks so the delta is visible.
	fire("message_update", { message: { role: "assistant", content: [{ type: "thinking", thinking: "x".repeat(2000) }] } });
	await sleep(30);
	fire("message_update", { message: { role: "assistant", content: [{ type: "thinking", thinking: "x".repeat(4000) }] } });
	await sleep(30);
	fire("tool_execution_start", { toolName: "bash", toolCallId: "t1", args: { command: "ls" } });
	await sleep(30);
	fire("tool_execution_end", { toolName: "bash", toolCallId: "t1", isError: false });
	await sleep(30);
	fire("message_update", { message: { role: "assistant", content: [{ type: "text", text: "done" }] } });
	await sleep(30);
	fire("message_end", { message: { role: "assistant", content: [{ type: "text", text: "done" }] } });
	await sleep(30);
	fire("agent_end", {});
	await sleep(30);

	const expectedSid = SID.slice(0, 8);
	const logPath = join(base, "agent", "logs", `status-anim-${expectedSid}.log`);
	check("log file exists at <logs>/status-anim-<sid8>.log", existsSync(logPath), logPath);

	if (existsSync(logPath)) {
		const content = readFileSync(logPath, "utf8");
		const lines = content.trim().split("\n");
		check("log is non-empty", lines.length > 0, `lines=${lines.length}`);
		const tags = lines.map((l) => l.split(" ")[2]);
		check("contains agent_start tag", tags.includes("agent_start"), String(tags));
		check("contains msg_update tag", tags.includes("msg_update"), String(tags));
		check("contains tool_start tag", tags.includes("tool_start"), String(tags));
		check("contains tool_end tag", tags.includes("tool_end"), String(tags));
		check("contains message_end tag", tags.includes("message_end"), String(tags));
		check("contains agent_end tag", tags.includes("agent_end"), String(tags));
		check("every line carries the 8-char sid", lines.every((l) => l.includes(` ${expectedSid} `)), expectedSid);
		check("every line has ISO timestamp", lines.every((l) => /\d{4}-\d{2}-\d{2}T/.test(l)));

		// msg_update should carry a delta field and snapshot fields.
		const muLine = lines.find((l) => l.includes(" msg_update ")) ?? "";
		check("msg_update has delta field", muLine.includes("delta="), muLine);
		check("msg_update has responseLength field", muLine.includes("responseLength="), muLine);
		check("msg_update has tokens field", muLine.includes("tokens="), muLine);
		check("msg_update has phase field", muLine.includes("phase="), muLine);

		// render lines should be ANSI-stripped (human-readable).
		const renderLines = lines.filter((l) => l.includes(" render "));
		check("render lines exist", renderLines.length > 0, "no render lines");
		if (renderLines.length) {
			const sample = renderLines[0];
			check("render row has no ANSI escapes", !sample.includes("\x1b["), sample.slice(0, 120));
		}

		console.log("\n--- sample log lines ---");
		for (const l of lines.slice(0, 8)) console.log(l.slice(0, 160));
	}

	rmSync(base, { recursive: true, force: true });
	console.log("");
	if (failures > 0) {
		console.error(`log-smoke: ${failures} of ${checks} checks FAILED`);
		process.exit(1);
	}
	console.log(`log-smoke: all ${checks} checks passed`);
}

void main();
