/**
 * Dev-only self-check for the pure modules (no pi runtime needed).
 * Run: `npm run selfcheck` (node --experimental-strip-types).
 *
 * Covers the statically checkable acceptance criteria: width gating,
 * FSM verb stability (bug 1), stall suppression by active tools (bug 3),
 * stall fade math, liveliness dynamics, token formatting, theme conversion.
 */
import { ansi256ToRgb, lerpRgb, rgbToAnsi256 } from "../src/theme.ts";
import { composeRow, displayWidth, formatTokens, stepOdometer } from "../src/render.ts";
import {
	onMessageEnd,
	onTextBlock,
	onThinkingBlock,
	onToolEnd,
	onToolStart,
	startLoop,
} from "../src/state-machine.ts";
import type { Phase } from "../src/state-machine.ts";
import {
	DOT_FRAMES,
	firstFrameForPhase,
	ROBOT_DONE_FRAMES,
	ROBOT_FACE_HAPPY,
	ROBOT_FACE_SAD,
	ROBOT_RESPOND_FRAMES,
	ROBOT_SLEEP_FRAMES,
	ROBOT_STATIC_FRAME,
	ROBOT_THINK_FRAMES,
	ROBOT_TOOL_FRAMES,
	ROBOT_WAIT_FRAMES,
	STAR_FRAMES,
	TOOL_FRAMES,
	framesForPhase,
	robotFramesForPhase,
} from "../src/frames.ts";
import { shouldStall, stallIntensity, tierIndex, updateLiveliness } from "../src/stall.ts";
import { modelEggFor, pickVerb, timeEggFor } from "../src/verbs.ts";

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

console.log("— render: width gating (acceptance §15.5) —");

const vp = "Reticulating…";
const g = "\u001b[38;2;200;100;0m⠋";

// COLUMNS=120: everything fits.
const wide = composeRow({
	glyph: g,
	verbPlain: vp,
	verbRendered: vp,
	marker: { key: "thought", plain: "(thought for 4s)", rendered: "(thought for 4s)" },
	parts: [
		{ key: "timer", plain: "12s", rendered: "12s" },
		{ key: "tokens", plain: "↓ 1.2k · 42/s", rendered: "↓ 1.2k · 42/s" },
		{ key: "tool", plain: "(running bash)", rendered: "(running bash)" },
		{ key: "queue", plain: "(+ queued)", rendered: "(+ queued)" },
	],
	hint: { key: "hint", plain: "(Ctrl+C to interrupt)", rendered: "(Ctrl+C to interrupt)" },
	columns: 120,
});
check(
	"120 cols: all 4 parts shown",
	wide.includes("(thought for 4s)") &&
		wide.includes("12s") &&
		wide.includes("↓ 1.2k · 42/s") &&
		wide.includes("(running bash)") &&
		wide.includes("(+ queued)"),
);

// COLUMNS=40: low-priority parts drop cleanly, never partial.
const narrow = composeRow({
	glyph: g,
	verbPlain: vp,
	verbRendered: vp,
	marker: { key: "thought", plain: "(thought for 4s)", rendered: "(thought for 4s)" },
	parts: [
		{ key: "timer", plain: "12s", rendered: "12s" },
		{ key: "tokens", plain: "↓ 1.2k · 42/s", rendered: "↓ 1.2k · 42/s" },
		{ key: "tool", plain: "(running bash)", rendered: "(running bash)" },
		{ key: "queue", plain: "(+ queued)", rendered: "(+ queued)" },
	],
	hint: { key: "hint", plain: "(Ctrl+C to interrupt)", rendered: "(Ctrl+C to interrupt)" },
	columns: 40,
});
check(
	"40 cols: queue+tool dropped, no partial parts",
	!narrow.includes("queued") && !narrow.includes("bash") && narrow.includes("12s"),
	JSON.stringify(narrow),
);
check("40 cols: row never exceeds the column width", displayWidth(narrow) <= 40, `w=${displayWidth(narrow)}`);
check("40 cols: verb + marker never dropped", narrow.includes(vp) && narrow.includes("(thought for 4s)"));

// Interrupt hint appears only when nothing else is shown.
const hintOnly = composeRow({
	glyph: g,
	verbPlain: vp,
	verbRendered: vp,
	marker: null,
	parts: [],
	hint: { key: "hint", plain: "(Ctrl+C to interrupt)", rendered: "(Ctrl+C to interrupt)" },
	columns: 80,
});
check("hint shown when nothing else is", hintOnly.includes("to interrupt"), JSON.stringify(hintOnly));
const hintHidden = composeRow({
	glyph: g,
	verbPlain: vp,
	verbRendered: vp,
	marker: { key: "thinking", plain: "(thinking…)", rendered: "(thinking…)" },
	parts: [],
	hint: { key: "hint", plain: "(Ctrl+C to interrupt)", rendered: "(Ctrl+C to interrupt)" },
	columns: 80,
});
check("hint hidden when the marker shows", !hintHidden.includes("to interrupt"));

check("displayWidth strips ANSI", displayWidth("\u001b[38;2;1;2;3m⠋ Reticulating…") === 15, `${displayWidth("\u001b[38;2;1;2;3m⠋ Reticulating…")}`);

console.log("— tokens (acceptance §15.2) —");
check("formatTokens 1234 → 1.2k", formatTokens(1234) === "1.2k");
check("formatTokens 42 → 42", formatTokens(42) === "42");
let od = 0;
od = stepOdometer(950, 1000);
check("odometer small gap step is 3", od === 953, `got ${od}`);
check("odometer never overshoots", od <= 1000);
od = stepOdometer(99, 100);
check("odometer clamps at target", od === 100, `got ${od}`);
const mid = stepOdometer(0, 150); // gap 150 (<200) → ceil(150*0.15)=23
check("odometer mid gap uses ceil(0.15·gap)", mid === 23, `got ${mid}`);
const big = stepOdometer(0, 5000); // gap ≥200 → +50
check("odometer big gap step is 50", big === 50);
// Snap-down fix: when target drops (new turn resets responseLength), the
// odometer must jump down immediately, not freeze at the old high value.
const snap = stepOdometer(1000, 50);
check("odometer snaps down when target drops", snap === 50, `got ${snap}`);

console.log("— FSM: verb stability (acceptance §15.1, bug 1) —");
let m = startLoop({ verb: "Reticulating", source: "generic" });
check("requesting entry sets verb", m.phase === "requesting" && m.verb === "Reticulating");
m = onThinkingBlock(m, { verb: "Pondering", source: "thinking" }, 1000);
check("thinking entry picks thinking verb", m.phase === "thinking" && m.verb === "Pondering");
const verbDuringTool = m.verb;
m = onToolStart(m, "bash", { command: "sleep 20" });
check("tool entry inherits the verb", m.phase === "tool" && m.verb === verbDuringTool);
check("active tool suppresses stall (bug 3)", !shouldStall(20000, 1000, 3000, m.toolCount, m.phase));
m = onToolEnd(m);
check("tool end reverts to thinking", m.phase === "thinking");
check("tool end restores the verb, not re-rolled", m.verb === verbDuringTool);
m = onTextBlock(m, { verb: "Polishing the answer", source: "responding" }, 2000);
check("responding entry picks text verb", m.phase === "responding" && m.verb === "Polishing the answer");
m = onMessageEnd(m, 3000);
check(
	"message_end → done, thought finalized",
	m.phase === "done" && !m.thinkingActive && m.thinkingEndAt === 2000,
	`endAt=${m.thinkingEndAt}`,
);
// tool_end reverts to `requesting`, not the terminal `done`/`idle` it was
// called from (the agent starts a new turn after a tool).
m = onToolStart(m, "bash", { command: "ls" });
check("tool from done enters tool phase", m.phase === "tool");
m = onToolEnd(m);
check("tool end from done → requesting (new turn)", m.phase === "requesting", `phase=${m.phase}`);
m = onThinkingBlock(m, { verb: "Pondering", source: "thinking" }, 4000);
check("thinking entry applies thinking verb", m.verb === "Pondering");
m = onToolStart(m, "read", null);
m = onToolStart(m, "grep", { pattern: "x" }); // parallel tools
check("parallel tools count", m.toolCount === 2);
m = onToolEnd(m);
check("one tool still active → phase stays tool", m.phase === "tool" && m.toolCount === 1);
m = onToolEnd(m);
check("last tool ends → revert", m.phase === "thinking");

console.log("— stall & liveliness (acceptance §15.4) —");
check("stall triggers after threshold with no activity", shouldStall(13001, 10000, 3000, 0, "thinking"));
check("stall suppressed by active tool", !shouldStall(13000, 10000, 3000, 1, "tool"));
check("no stall in done phase", !shouldStall(13000, 10000, 3000, 0, "done"));
check("no stall in requesting phase (first-byte wait)", !shouldStall(13000, 10000, 3000, 0, "requesting"));
check("stall disabled when threshold is 0", !shouldStall(13000, 10000, 0, 0, "thinking"));
const i0 = stallIntensity(0);
const i2 = stallIntensity(2000);
const i5 = stallIntensity(5000);
check("fade starts at 0", i0 === 0, `${i0}`);
check("fade ~0.94 at 2s (exponential approach)", i2 > 0.9 && i2 < 0.99, `${i2}`);
check("fade reaches 1 by 5s (exponential approach)", i5 > 0.99 && i5 < 1, `${i5}`);
check("tier word escalates with elapsed stall time", tierIndex(5000) === 0 && tierIndex(20000) === 1 && tierIndex(60000) === 2);
let liv = 0;
for (let t = 50; t <= 500; t += 50) liv = updateLiveliness(liv, 0, t, 50);
check("liveliness rises toward 1 while tokens flow", liv > 0.8, `${liv}`);
for (let t = 2000; t <= 6000; t += 50) liv = updateLiveliness(liv, 1000, t, 50);
check("liveliness decays when flow stops", liv < 0.2, `${liv}`);
const l1 = updateLiveliness(0.5, 5000, 5200, 50);
check("liveliness bounded to [0,1]", l1 >= 0 && l1 <= 1);

console.log("— frames —");
check("requesting uses dots set", framesForPhase("requesting", true) === DOT_FRAMES);
check("thinking uses star set", framesForPhase("thinking", true) === STAR_FRAMES);
check("tool uses braille set", framesForPhase("tool", true) === TOOL_FRAMES);
check("phaseGlyphs off → one set", framesForPhase("thinking", false) === STAR_FRAMES && framesForPhase("requesting", false) === STAR_FRAMES);
check("firstFrameForPhase works", firstFrameForPhase("thinking", true) === "·");

console.log("— robot avatar frames —");
const robotSets: Record<string, string[]> = {
	wait: ROBOT_WAIT_FRAMES,
	think: ROBOT_THINK_FRAMES,
	respond: ROBOT_RESPOND_FRAMES,
	tool: ROBOT_TOOL_FRAMES,
	sleep: ROBOT_SLEEP_FRAMES,
	done: ROBOT_DONE_FRAMES,
	happy: [ROBOT_FACE_HAPPY],
	sad: [ROBOT_FACE_SAD],
	static: [ROBOT_STATIC_FRAME],
};
for (const [name, frames] of Object.entries(robotSets)) {
	const widths = new Set(frames.map((f) => displayWidth(f)));
	check(
		`robot ${name}: every frame is 5 cells wide`,
		widths.size === 1 && [...widths][0] === 5,
		[...widths].join(","),
	);
}
const robotPhases: Phase[] = ["requesting", "thinking", "responding", "tool", "done"];
check(
	"robot frames cover every phase",
	robotPhases.every((p) => robotFramesForPhase(p).frames.length > 0),
);
check(
	"robot sets carry a positive Loader interval",
	robotPhases.every((p) => robotFramesForPhase(p).intervalMs > 0),
);

console.log("— theme conversion —");
const r = ansi256ToRgb(196);
check("ansi256 196 ≈ red", r.r === 255 && r.g === 0 && r.b === 0, JSON.stringify(r));
const mid2 = lerpRgb({ r: 0, g: 0, b: 0 }, { r: 100, g: 50, b: 25 }, 0.5);
check("lerpRgb midpoint", mid2.r === 50 && mid2.g === 25 && mid2.b === 13, JSON.stringify(mid2));
check("rgbToAnsi256 round-trips cube colors", rgbToAnsi256({ r: 255, g: 0, b: 0 }) === 196);
check("rgbToAnsi256 handles grays", rgbToAnsi256({ r: 128, g: 128, b: 128 }) === 244 || rgbToAnsi256({ r: 128, g: 128, b: 128 }) === 8, `${rgbToAnsi256({ r: 128, g: 128, b: 128 })}`);

console.log("— verbs / eggs —");
check("model egg matches by substring", modelEggFor("anthropic/claude-sonnet-4") !== null);
check("model egg unknown model → null", modelEggFor("zzz-unknown-model") === null);
check("time egg never null", timeEggFor(new Date()) !== null);
check("pickVerb avoids immediate repeat", pickVerb(["a", "b", "c", "d", "e"], { current: 0 }) !== "a");
check("pickVerb empty list fallback", pickVerb([], { current: 0 }) === "Working");

console.log("");
if (failures > 0) {
	console.error(`selfcheck: ${failures} of ${checks} checks FAILED`);
	process.exit(1);
}
console.log(`selfcheck: all ${checks} checks passed`);
