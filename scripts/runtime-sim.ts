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
	label: string | undefined;
}

function makeUI(): FakeUI {
	return {
		messages: [],
		frames: undefined,
		label: undefined,
	};
}

function makeCtx(ui: FakeUI, mode: "tui" | "print" = "tui") {
	return {
		mode,
		ui: {
			setWorkingMessage: (m?: string) => {
				ui.messages.push(m);
			},
			setWorkingIndicator: (o?: { frames?: string[] }) => {
				ui.frames = o?.frames;
			},
			setHiddenThinkingLabel: (l?: string) => {
				ui.label = l;
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
	on: (ev: string, h: (event: any, ctx: any) => void) => void;
	exec: () => Promise<{ stdout: string; stderr: string; code: number; killed: boolean }>;
}

function makePi(): FakePi {
	const handlers: FakePi["handlers"] = {};
	return {
		handlers,
		on: (ev, h) => {
			(handlers[ev] ??= []).push(h);
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
	const s = strip(row);
	const afterGlyph = s.slice(s.indexOf(" ") + 1);
	return afterGlyph.slice(0, afterGlyph.indexOf("…") + 1);
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
	check("requesting row shows the interrupt hint", lastMessage(ui).includes("(Ctrl+C to interrupt)"), lastMessage(ui));
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
	check("thinking marker shown", lastMessage(ui).includes("(thinking with high effort…)"), lastMessage(ui));
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

	// Text block → responding.
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
		check("token counter is realistic (~1k for 4k chars, not 100k+)", value > 900 && value < 1100, `got ${raw}`);
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

	// agent_end: row hidden, timers stopped.
	const beforeEnd = messageCount(ui);
	fire(pi, "agent_end", {}, ctx);
	check("agent_end restores the default message", ui.messages[ui.messages.length - 1] === undefined);
	check("agent_end restores the default indicator", ui.frames === undefined);
	const afterEnd = messageCount(ui);
	check("agent_end pushes exactly the reset message", afterEnd === beforeEnd + 1, `${afterEnd} vs ${beforeEnd}`);
	await sleep(300);
	check("clock stopped after agent_end", messageCount(ui) === afterEnd, `${messageCount(ui)} vs ${afterEnd}`);
	fire(pi, "session_shutdown", {}, ctx);

	// ── Wave/breath replaces the glimmer (acceptance §15.6) ───────────────
	useSettings({ animChance: 1, animAfterMs: 0, intervalMs: 50 });
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
	useSettings({ reducedMotion: true, intervalMs: 50 });
	const pi3 = makePi();
	const ui3 = makeUI();
	statusAnim(pi3 as unknown as ExtensionAPI);
	const ctx3 = makeCtx(ui3);
	fire(pi3, "agent_start", {}, ctx3);
	await sleep(200);
	const row3 = lastMessage(ui3);
	const verb3 = verbOf(row3);
	check("reducedMotion: static ● glyph", row3.includes("●") && (ui3.frames ?? []).length === 1, row3);
	check("reducedMotion: plain verb text (no per-char animation)", ansiCount(verb3) === 0, verb3);
	check("reducedMotion: hint still shown", row3.includes("to interrupt"), row3);
	fire(pi3, "agent_end", {}, ctx3);
	fire(pi3, "session_shutdown", {}, ctx3);

	console.log("");
	if (failures > 0) {
		console.error(`runtime-sim: ${failures} of ${checks} checks FAILED`);
		process.exit(1);
	}
	console.log(`runtime-sim: all ${checks} checks passed`);
}

void main();
