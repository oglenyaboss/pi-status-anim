/**
 * Dev-only runtime simulation: drives the real extension factory through a
 * fake pi API and replays a full agent-loop scenario against the real event
 * wiring (acceptance criteria that can't be checked statically).
 *
 * Run: `npm run runtime-sim` (node --experimental-strip-types).
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	ROBOT_DONE_FRAMES,
	ROBOT_FACE_HAPPY,
	ROBOT_FACE_SAD,
	ROBOT_RESPOND_FRAMES,
	ROBOT_SLEEP_FRAMES,
	ROBOT_THINK_FRAMES,
	ROBOT_TOOL_FRAMES,
	ROBOT_TOOL_MS,
	ROBOT_WAIT_FRAMES,
} from "../src/frames.ts";
import { loadConfig } from "../src/config.ts";
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

// Deterministic width for the sim.
Object.defineProperty(process.stdout, "columns", { value: 120, configurable: true });

// Isolated settings so the sim never depends on the user's real config.
const dir = mkdtempSync(join(tmpdir(), "pi-status-anim-sim-"));
mkdirSync(join(dir, "agent"));
writeFileSync(
	join(dir, "agent", "settings.json"),
	JSON.stringify({
		statusAnim: {
			modelEggs: false,
			timeEggs: false,
			gitStatus: false,
			animChance: 0,
			funFacts: false,
			anxietyGradient: false,
			robotAvatar: false,
			intervalMs: 50,
		},
	}),
);
process.env.PI_CODING_AGENT_DIR = join(dir, "agent");

/** Point the config loader at a fresh settings dir with the given overrides. */
function useSettings(overrides: Record<string, unknown>): void {
	const d = mkdtempSync(join(tmpdir(), "pi-status-anim-sim-"));
	mkdirSync(join(d, "agent"));
	writeFileSync(
		join(d, "agent", "settings.json"),
		JSON.stringify({
			statusAnim: {
				modelEggs: false,
				timeEggs: false,
				gitStatus: false,
				funFacts: false,
				anxietyGradient: false,
				...overrides,
			},
		}),
	);
	process.env.PI_CODING_AGENT_DIR = join(d, "agent");
}

// Fake theme: distinct per-token colors so fade assertions can run.
const TOKEN_RGB: Record<string, string> = {
	accent: "\x1b[38;2;220;160;60m",
	error: "\x1b[38;2;220;60;60m",
	dim: "\x1b[38;2;120;120;120m",
	muted: "\x1b[38;2;130;130;130m",
	warning: "\x1b[38;2;200;150;50m",
};
const fakeTheme = {
	fg: (_token: string, text: string) => text,
	getFgAnsi: (token: string) => TOKEN_RGB[token] ?? "\x1b[38;2;170;170;170m",
	getColorMode: () => "truecolor",
};

interface FakeUI {
	messages: Array<string | undefined>;
	frames: string[] | undefined;
	indicatorInterval: number | undefined;
	label: string | undefined;
	notifies: Array<{ msg: string; type?: string }>;
	/** Programmed answers for ctx.ui.select, consumed in order (shift). */
	selectAnswers: string[];
	selectCalls: Array<{ title: string; options: string[] }>;
	/** Programmed answers for ctx.ui.input, consumed in order; empty = keep placeholder. */
	inputAnswers: string[];
}

function makeUI(): FakeUI {
	return {
		messages: [],
		frames: undefined,
		indicatorInterval: undefined,
		label: undefined,
		notifies: [],
		selectAnswers: [],
		selectCalls: [],
		inputAnswers: [],
	};
}

function makeCtx(ui: FakeUI, mode: "tui" | "print" = "tui") {
	return {
		mode,
		ui: {
			setWorkingMessage: (m?: string) => {
				ui.messages.push(m);
			},
			setWorkingIndicator: (o?: { frames?: string[]; intervalMs?: number }) => {
				ui.frames = o?.frames;
				ui.indicatorInterval = o?.intervalMs;
			},
			setHiddenThinkingLabel: (l?: string) => {
				ui.label = l;
			},
			notify: (msg: string, type?: "info" | "warning" | "error") => {
				ui.notifies.push({ msg, type });
			},
			select: async (title: string, options: string[]) => {
				ui.selectCalls.push({ title, options });
				return ui.selectAnswers.length > 0 ? ui.selectAnswers.shift() : undefined;
			},
			confirm: async () => true,
			input: async (_title: string, placeholder?: string) => {
				const ans = ui.inputAnswers.length > 0 ? ui.inputAnswers.shift() : undefined;
				return ans ?? placeholder ?? "";
			},
			theme: fakeTheme,
		},
		model: undefined,
		cwd: "/tmp",
		hasPendingMessages: () => false,
	};
}

interface FakePi {
	handlers: Record<string, Array<(event: any, ctx: any) => void>>;
	commands: Record<string, { description?: string; handler: (args: string, ctx: any) => Promise<void> }>;
	on: (ev: string, h: (event: any, ctx: any) => void) => void;
	registerCommand: (name: string, opts: { description?: string; handler: (args: string, ctx: any) => Promise<void> }) => void;
	exec: () => Promise<{ stdout: string; stderr: string; code: number; killed: boolean }>;
}

function makePi(): FakePi {
	const handlers: FakePi["handlers"] = {};
	const commands: FakePi["commands"] = {};
	return {
		handlers,
		commands,
		on: (ev, h) => {
			(handlers[ev] ??= []).push(h);
		},
		registerCommand: (name, opts) => {
			commands[name] = opts;
		},
		exec: async () => ({ stdout: "", stderr: "", code: 1, killed: false }),
	};
}

const fire = (pi: FakePi, ev: string, event: unknown, ctx: any): void => {
	for (const h of pi.handlers[ev] ?? []) h(event, ctx);
};

const lastMessage = (ui: FakeUI): string => ui.messages[ui.messages.length - 1] ?? "";
const messageCount = (ui: FakeUI): number => ui.messages.length;

/** Strip ANSI color codes (the fake theme emits none, but the glimmer does). */
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

/** Verb portion of a rendered row: everything after the glyph up to "…". */
const verbOf = (row: string): string => {
	const s = strip(row); // glyph is NOT in the message (pi prepends it), so the verb is first
	return s.slice(0, s.indexOf("…") + 1);
};

const STALL_WORDS = [
	"Checking the connection", "Poking the model with a stick",
	"Wondering if it's stuck", "Waiting for a sign", "Knocking on the API door",
	"Listening for tokens",
];

async function main(): Promise<void> {
	const pi = makePi();
	const ui = makeUI();
	statusAnim(pi as unknown as ExtensionAPI);

	// ── Mode guard (acceptance §15.7) ─────────────────────────────────────
	const printUI = makeUI();
	const printCtx = makeCtx(printUI, "print");
	fire(pi, "agent_start", {}, printCtx);
	await sleep(200);
	check("print mode: no timer work, no messages", messageCount(printUI) === 0, `count=${messageCount(printUI)}`);

	// ── Full TUI agent-loop scenario ──────────────────────────────────────
	const ctx = makeCtx(ui);

	fire(pi, "agent_start", {}, ctx);
	await sleep(120);
	check("agent_start owns the row", messageCount(ui) > 0, lastMessage(ui));
	check("requesting row shows the interrupt hint", lastMessage(ui).includes("(escape to interrupt)"), lastMessage(ui));
	const requestingVerb = verbOf(lastMessage(ui));
	check("requesting verb ends with ellipsis", requestingVerb.endsWith("…"), requestingVerb);

	// Thinking block of ~4000 chars → ~1000 tokens (acceptance §15.2, bug 9).
	fire(
		pi,
		"message_update",
		{ message: { role: "assistant", content: [{ type: "thinking", thinking: "x".repeat(4000) }] } },
		ctx,
	);
	await sleep(120);
	check("thinking marker shown", lastMessage(ui).includes("(thinking"), lastMessage(ui));
	check("hint hidden once the marker shows", !lastMessage(ui).includes("to interrupt"));
	const thinkingVerb = verbOf(lastMessage(ui));

	// Tool starts; verb must NOT change (bug 1); tool detail appears.
	fire(pi, "tool_execution_start", { toolName: "bash", toolCallId: "t1", args: { command: "sleep 20" } }, ctx);
	await sleep(120);
	check("tool row shows the tool detail", lastMessage(ui).includes("(running bash)"), lastMessage(ui));
	check("tool entry keeps the verb (bug 1)", verbOf(lastMessage(ui)) === thinkingVerb, `${verbOf(lastMessage(ui))} vs ${thinkingVerb}`);
	check("tool frames are braille", Array.isArray(ui.frames) && ui.frames!.length === 10 && ui.frames![0].includes("⠋"), String(ui.frames?.[0]));

	// 3.2s of a tool with no output → must NOT stall (acceptance §15.3, bug 3).
	await sleep(3200);
	check("long silent tool: no false stall", !STALL_WORDS.some((w) => lastMessage(ui).includes(w)), lastMessage(ui));
	check("long silent tool: row still shows the tool", lastMessage(ui).includes("(running bash)"));

	fire(pi, "tool_execution_end", { toolName: "bash", toolCallId: "t1" }, ctx);
	await sleep(120);
	check("tool end clears the tool detail", !lastMessage(ui).includes("(running bash)"));
	check("tool end restores the verb", verbOf(lastMessage(ui)) === thinkingVerb, verbOf(lastMessage(ui)));

	// Text block → responding. After tool_end the FSM reverts to
	// `requesting` (new turn), so this update starts a fresh message; the
	// counter reflects the current "Hello!" content, not the prior thinking
	// block — no accumulation (bug 9).
	fire(pi, "message_update", { message: { role: "assistant", content: [{ type: "text", text: "Hello!" }] } }, ctx);
	await sleep(120);
	check("thought marker after thinking ends", /\(thought for \d+s\)/.test(lastMessage(ui)), lastMessage(ui));

	// Wait past tokenAfterMs (3000) since the responding entry.
	await sleep(3300);
	const tokenMatch = lastMessage(ui).match(/↓ ([\d.]+k?)/);
	check("token counter shown after tokenAfterMs", tokenMatch !== null, lastMessage(ui));
	if (tokenMatch) {
		const raw = tokenMatch[1];
		const value = raw.endsWith("k") ? parseFloat(raw) * 1000 : parseFloat(raw);
		check("token counter not cumulative (bug 9: no 100k+)", value < 1000, `got ${raw}`);
	}

	// Idle network → stall: red fade on the glyph + tier word (acceptance §15.4).
	await sleep(3400);
	check("stall tier word appears", STALL_WORDS.some((w) => lastMessage(ui).includes(w)), lastMessage(ui));
	const stallFrames = ui.frames ?? [];
	const stallAnsi = stallFrames[0] ?? "";
	const stallRgb = stallAnsi.match(/38;2;(\d+);(\d+);(\d+)/);
	check("stall glyph fades toward red", stallRgb !== null && +stallRgb[1] > 180 && +stallRgb[2] < 110, stallAnsi);

	// Resume: tokens flow again → stall clears.
	fire(pi, "message_update", { message: { role: "assistant", content: [{ type: "thinking", thinking: "y".repeat(200) }] } }, ctx);
	await sleep(250);
	check("stall clears when tokens flow", !STALL_WORDS.some((w) => lastMessage(ui).includes(w)), lastMessage(ui));

	// Compaction pause: idle 2.9s, then compaction resets the stall clock.
	await sleep(2900);
	fire(pi, "session_before_compact", { type: "session_before_compact" }, ctx);
	await sleep(1100);
	check("compaction pauses stall detection", !STALL_WORDS.some((w) => lastMessage(ui).includes(w)), lastMessage(ui));
	fire(pi, "session_compact", { type: "session_compact" }, ctx);
	await sleep(100);

	// ── Multi-turn odometer accumulation (SPEC §5: scoped to agent-loop) ──
	// The counter accumulates across turns within one agent-loop: it must
	// NOT reset to 0 when a new turn starts, and it must NOT freeze at the
	// prior turn's value. It continues to rise from the accumulated total.
	fire(pi, "message_update", { message: { role: "assistant", content: [{ type: "thinking", thinking: "x".repeat(4000) }] } }, ctx);
	await sleep(120); // let the odometer rise toward 1000
	const turn1Match = lastMessage(ui).match(/↓ ([\d.]+k?)/);
	if (turn1Match) {
		const raw1 = turn1Match[1];
		const v1 = raw1.endsWith("k") ? parseFloat(raw1) * 1000 : parseFloat(raw1);
		check("turn 1: counter rising toward ~1k for 4k chars", v1 > 100, `got ${raw1}`);
	}
	const turn1Value = turn1Match ? (turn1Match[1].endsWith("k") ? parseFloat(turn1Match[1]) * 1000 : parseFloat(turn1Match[1])) : 0;
	fire(pi, "message_end", { message: { role: "assistant", content: [{ type: "thinking", thinking: "x".repeat(4000) }] } }, ctx);
	await sleep(50);
	// New short message → counter must keep accumulating from turn 1's total,
	// not reset to 0 and not freeze.
	fire(pi, "message_update", { message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }, ctx);
	await sleep(200);
	const turn2Match = lastMessage(ui).match(/↓ ([\d.]+k?)/);
	const turn2Value = turn2Match ? (turn2Match[1].endsWith("k") ? parseFloat(turn2Match[1]) * 1000 : parseFloat(turn2Match[1])) : 0;
	check(
		"turn 2: counter continues from turn 1 (no reset, no freeze)",
		turn2Value >= turn1Value,
		`turn1=${turn1Value} turn2=${turn2Value}`,
	);

	// agent_end: row hidden, timers stopped.
	const beforeEnd = messageCount(ui);
	fire(pi, "agent_end", {}, ctx);
	check("agent_end restores the default message", ui.messages[ui.messages.length - 1] === undefined);
	check("agent_end restores the default indicator", ui.frames === undefined);
	const summary = ui.notifies.find((n) => /tokens/.test(n.msg));
	check("agent_end fires a tokens/time summary notification", summary !== undefined && /tokens/.test(summary.msg) && /\ds/.test(summary.msg), summary?.msg);
	const afterEnd = messageCount(ui);
	check("agent_end pushes exactly the reset message", afterEnd === beforeEnd + 1, `${afterEnd} vs ${beforeEnd}`);
	await sleep(300);
	check("clock stopped after agent_end", messageCount(ui) === afterEnd, `${messageCount(ui)} vs ${afterEnd}`);
	fire(pi, "session_shutdown", {}, ctx);

	// ── Wave/breath replaces the glimmer (acceptance §15.6) ───────────────
	useSettings({ animChance: 1, animAfterMs: 0, intervalMs: 50, robotAvatar: false });
	const pi2 = makePi();
	const ui2 = makeUI();
	statusAnim(pi2 as unknown as ExtensionAPI);
	const ctx2 = makeCtx(ui2);
	fire(pi2, "agent_start", {}, ctx2);
	await sleep(200);
	const row2 = lastMessage(ui2);
	const ansiCount = (s: string): number => (s.match(/\x1b\[[0-9;]*m/g) ?? []).length;
	// Glimmer would emit exactly 7 escapes (glyph + 3 lit chars × 2);
	// wave emits per-char escapes, breath a single wrap — either way ≠ 7.
	check("wave/breath is active after animAfterMs (not glimmer)", ansiCount(row2) !== 7 && ansiCount(row2) >= 2, `escapes=${ansiCount(row2)}`);
	fire(pi2, "agent_end", {}, ctx2);
	fire(pi2, "session_shutdown", {}, ctx2);

	// ── reducedMotion: static glyph + plain text (acceptance §15.6) ───────
	useSettings({ reducedMotion: true, intervalMs: 50, robotAvatar: false });
	const pi3 = makePi();
	const ui3 = makeUI();
	statusAnim(pi3 as unknown as ExtensionAPI);
	const ctx3 = makeCtx(ui3);
	fire(pi3, "agent_start", {}, ctx3);
	await sleep(200);
	const row3 = lastMessage(ui3);
	const verb3 = verbOf(row3);
	check("reducedMotion: static ● glyph via indicator frames", (ui3.frames ?? []).length === 1 && (ui3.frames?.[0] ?? "").includes("●"), String(ui3.frames?.[0]));
	check("reducedMotion: plain verb text (no per-char animation)", ansiCount(verb3) === 0, verb3);
	check("reducedMotion: hint still shown", row3.includes("to interrupt"), row3);
	fire(pi3, "agent_end", {}, ctx3);
	fire(pi3, "session_shutdown", {}, ctx3);

	// ── Robot avatar: one face per state + tool-result reactions ──────────
	useSettings({ robotAvatar: true, intervalMs: 50, animChance: 0 });
	const pi4 = makePi();
	const ui4 = makeUI();
	statusAnim(pi4 as unknown as ExtensionAPI);
	const ctx4 = makeCtx(ui4);
	const faceOf = (): string => strip(ui4.frames?.[0] ?? "");

	fire(pi4, "agent_start", {}, ctx4);
	await sleep(120);
	check(
		"robot: wait frames while requesting (blink set)",
		(ui4.frames ?? []).length === ROBOT_WAIT_FRAMES.length && faceOf() === ROBOT_WAIT_FRAMES[0],
		String(ui4.frames?.[0]),
	);

	fire(pi4, "message_update", { message: { role: "assistant", content: [{ type: "thinking", thinking: "x".repeat(100) }] } }, ctx4);
	await sleep(120);
	check(
		"robot: think frames while thinking",
		faceOf() === ROBOT_THINK_FRAMES[0] && (ui4.frames ?? []).length === ROBOT_THINK_FRAMES.length,
		faceOf(),
	);

	fire(pi4, "tool_execution_start", { toolName: "bash", toolCallId: "t1", args: { command: "ls" } }, ctx4);
	await sleep(120);
	check(
		"robot: tool frames (fast brain pulse) with 150ms interval",
		faceOf() === ROBOT_TOOL_FRAMES[0] && ui4.indicatorInterval === ROBOT_TOOL_MS,
		`${faceOf()} @${ui4.indicatorInterval}ms`,
	);

	// Failed tool → sad face in error color.
	fire(pi4, "tool_execution_end", { toolName: "bash", toolCallId: "t1", isError: true }, ctx4);
	await sleep(50);
	check(
		"robot: sad face after failed tool, in error color",
		faceOf() === ROBOT_FACE_SAD && /38;2;220;60;60/.test(ui4.frames?.[0] ?? ""),
		String(ui4.frames?.[0]),
	);

	// Next tool supersedes the reaction; success → happy face.
	fire(pi4, "tool_execution_start", { toolName: "read", toolCallId: "t2", args: { path: "/tmp/x" } }, ctx4);
	await sleep(50);
	fire(pi4, "tool_execution_end", { toolName: "read", toolCallId: "t2", isError: false }, ctx4);
	await sleep(50);
	check(
		"robot: happy face after successful tool",
		faceOf() === ROBOT_FACE_HAPPY && (ui4.frames ?? []).length === 1,
		faceOf(),
	);

	// The reaction expires after 2s; the phase face returns (responding —
	// the tool ended, then the text block moved the FSM to responding).
	await sleep(2200);
	fire(pi4, "message_update", { message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }, ctx4);
	await sleep(120);
	check(
		"robot: face reaction expires, phase face returns",
		faceOf() === ROBOT_RESPOND_FRAMES[0],
		faceOf(),
	);

	// Idle network → the robot falls asleep, frames fade red.
	await sleep(3400);
	check(
		"robot: sleeps while stalled",
		(ui4.frames ?? []).length === ROBOT_SLEEP_FRAMES.length && faceOf() === ROBOT_SLEEP_FRAMES[0],
		`${faceOf()} x${ui4.frames?.length}`,
	);
	const sleepAnsi = ui4.frames?.[0] ?? "";
	const sleepRgb = sleepAnsi.match(/38;2;(\d+);(\d+);(\d+)/);
	check(
		"robot: sleep frames fade toward red",
		sleepRgb !== null && +sleepRgb[1] > 180 && +sleepRgb[2] < 130,
		sleepAnsi,
	);

	// Tokens flow again → wakes up.
	fire(pi4, "message_update", { message: { role: "assistant", content: [{ type: "thinking", thinking: "y".repeat(100) }] } }, ctx4);
	await sleep(250);
	check(
		"robot: wakes when tokens flow",
		faceOf() === ROBOT_THINK_FRAMES[0],
		faceOf(),
	);

	// done phase → pleased face.
	fire(pi4, "message_end", { message: { role: "assistant", content: [{ type: "thinking", thinking: "y".repeat(100) }] } }, ctx4);
	await sleep(50);
	check(
		"robot: pleased face in done phase",
		faceOf() === ROBOT_DONE_FRAMES[0],
		faceOf(),
	);
	fire(pi4, "agent_end", {}, ctx4);
	check("robot: agent_end restores the default indicator", ui4.frames === undefined);
	fire(pi4, "session_shutdown", {}, ctx4);

	// reducedMotion keeps the static robot face.
	useSettings({ reducedMotion: true, robotAvatar: true, intervalMs: 50 });
	const pi5 = makePi();
	const ui5 = makeUI();
	statusAnim(pi5 as unknown as ExtensionAPI);
	const ctx5 = makeCtx(ui5);
	fire(pi5, "agent_start", {}, ctx5);
	await sleep(120);
	check(
		"robot: static face under reducedMotion",
		(ui5.frames ?? []).length === 1 && strip(ui5.frames?.[0] ?? "") === "[◉_◉]",
		String(ui5.frames?.[0]),
	);
	fire(pi5, "agent_end", {}, ctx5);
	fire(pi5, "session_shutdown", {}, ctx5);

	// ── /statusanim command: interactive config from the TUI ───────────────
	useSettings({});
	const pi6 = makePi();
	const ui6 = makeUI();
	statusAnim(pi6 as unknown as ExtensionAPI);
	const cmd = pi6.commands["statusanim"];
	check("statusanim command registered", typeof cmd?.handler === "function");

	// Quick set: /statusanim robotAvatar off writes settings.json.
	await cmd.handler("robotAvatar off", makeCtx(ui6) as never);
	check("quick set: robotAvatar off persisted", loadConfig().robotAvatar === false, String(loadConfig().robotAvatar));
	check("quick set: notifies saved", ui6.notifies.some((n) => n.msg.includes("reload to apply")), JSON.stringify(ui6.notifies));

	// Quick set rejects out-of-range values and does not write them.
	ui6.notifies = [];
	await cmd.handler("animChance 5", makeCtx(ui6) as never);
	check("quick set: out-of-range value rejected", loadConfig().animChance !== 5, String(loadConfig().animChance));
	check("quick set: error notified", ui6.notifies.some((n) => n.type === "error"), JSON.stringify(ui6.notifies));

	// Quick set rejects unknown keys.
	ui6.notifies = [];
	await cmd.handler("nonsense 1", makeCtx(ui6) as never);
	check("quick set: unknown key rejected", ui6.notifies.some((n) => n.type === "error" && n.msg.includes("nonsense")));

	// Menu: select the robotAvatar line, toggle to "on", then Done.
	const ctx6 = makeCtx(ui6);
	ui6.selectAnswers = [
		"robotAvatar — robot face across all phases [off]",
		"on",
		"Done",
	];
	await cmd.handler("", ctx6 as never);
	check("menu: robotAvatar toggled back on", loadConfig().robotAvatar === true, String(loadConfig().robotAvatar));
	check(
		"menu: saved notification mentions the key",
		ui6.notifies.some((n) => n.msg.includes("robotAvatar") && n.msg.includes("saved")),
		JSON.stringify(ui6.notifies),
	);

	// Menu: numeric option accepts a new value through input.
	ui6.notifies = [];
	ui6.selectAnswers = ["stallAfterMs — stall threshold without tokens (ms) [3000]"];
	ui6.inputAnswers = ["5000"];
	await cmd.handler("", makeCtx(ui6) as never);
	check("menu: numeric option written via input", loadConfig().stallAfterMs === 5000, String(loadConfig().stallAfterMs));

	// Menu: Esc (undefined answer) exits without changes.
	const before = loadConfig().stallAfterMs;
	ui6.notifies = [];
	ui6.selectAnswers = []; // no answers → select returns undefined
	await cmd.handler("", makeCtx(ui6) as never);
	check("menu: Esc exits without changes", loadConfig().stallAfterMs === before && ui6.notifies.length === 0, JSON.stringify(ui6.notifies));

	// ── Token rate: pi-aligned estimate + smoothed tok/s ──────────────────
	useSettings({ robotAvatar: false, intervalMs: 50, animChance: 0, tokenAfterMs: 0 });
	const pi7 = makePi();
	const ui7 = makeUI();
	statusAnim(pi7 as unknown as ExtensionAPI);
	const ctx7 = makeCtx(ui7);
	fire(pi7, "agent_start", {}, ctx7);
	await sleep(50);
	// ~4 chunks of 100 fresh chars each, arriving over ~1s → ~100 tok/s.
	for (let i = 0; i < 4; i += 1) {
		fire(pi7, "message_update", { message: { role: "assistant", content: [{ type: "thinking", thinking: "x".repeat(100 * (i + 1)) }] } }, ctx7);
		await sleep(250);
	}
	await sleep(300);
	const rateMatch = lastMessage(ui7).match(/· (\d+)\/s/);
	check("rate: tok/s shown after steady flow", rateMatch !== null, lastMessage(ui7));
	if (rateMatch) {
		const rate = parseInt(rateMatch[1], 10);
		check("rate: plausible magnitude (not 0, not absurd)", rate > 10 && rate < 300, `${rate}`);
	}
	// A tool running means the model is waiting, not slowing down: the rate
	// must disappear entirely (no "· 0/s" and no fake decay) and come back
	// once generation resumes.
	fire(pi7, "tool_execution_start", { toolName: "bash", toolCallId: "t9", args: { command: "sleep 1" } }, ctx7);
	await sleep(100);
	check("rate: hidden while a tool runs", !/· \d+\/s/.test(lastMessage(ui7)) && !/· 0\/s/.test(lastMessage(ui7)), lastMessage(ui7));
	fire(pi7, "tool_execution_end", { toolName: "bash", toolCallId: "t9", isError: false }, ctx7);
	await sleep(100);
	check("rate: returns after the tool ends", /· \d+\/s/.test(lastMessage(ui7)), lastMessage(ui7));
	// Long pause → the window empties and the rate disappears (no decay).
	await sleep(3400);
	check("rate: gone after a pause (no fake decay)", !/· \d+\/s/.test(lastMessage(ui7)), lastMessage(ui7));
	fire(pi7, "agent_end", {}, ctx7);
	fire(pi7, "session_shutdown", {}, ctx7);

	console.log("");
	if (failures > 0) {
		console.error(`runtime-sim: ${failures} of ${checks} checks FAILED`);
		process.exit(1);
	}
	console.log(`runtime-sim: all ${checks} checks passed`);
}

void main();
