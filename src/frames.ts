/**
 * Glyph frame sets, chosen by phase, not by individual tool.
 */
import type { Phase } from "./state-machine.ts";

/** Requesting phase: a single braille dot travelling around its 8 positions. */
export const DOT_FRAMES = ["⠁", "⠂", "⠄", "⡀", "⢀", "⠠", "⠐", "⠈"];

/** Thinking / responding phase: soft star set, forward + reverse. */
export const STAR_FRAMES = ["·", "✢", "✳", "✶", "✻", "✽", "✽", "✻", "✶", "✳", "✢", "·"];

/** Tool phase: braille dots. */
export const TOOL_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Static glyph under reducedMotion. */
export const STATIC_GLYPH = "●";

/** Static glyph for the brief `done` phase (message_end … agent_end). */
export const DONE_GLYPH = "✽";

// ── Robot avatar (robotAvatar: true) ──────────────────────────────────────
// One 5-cell-wide robot face per state. Every frame of every set is exactly
// 5 cells wide (enforced by selfcheck), so the row never jumps when a set
// swaps. `·` is a closed eye. The face is a character, not a spinner: it
// blinks while waiting, rolls its eyes up and pulses its brain while
// thinking, works with a fast brain pulse while tools run, smiles while
// responding, sleeps when stalled, and reacts to tool results
// (ROBOT_FACE_*).

/** Waiting for the first token: neutral face, blinks once per cycle. */
export const ROBOT_WAIT_FRAMES = [
	"[◉_◉]", "[◉_◉]", "[◉_◉]", "[◉_◉]", "[·_·]",
	"[◉_◉]", "[◉_◉]", "[◉_◉]", "[◉_◉]", "[◉_◉]",
];

/** Thinking: eyes rolled up, slow brain pulse. */
export const ROBOT_THINK_FRAMES = ["[◕▂◔]", "[◕▄◔]", "[◕▆◔]", "[◕▄◔]"];

/** Responding: smiling, blinks once per cycle. */
export const ROBOT_RESPOND_FRAMES = [
	"[◉‿◉]", "[◉‿◉]", "[◉‿◉]", "[◉‿◉]", "[·‿·]",
	"[◉‿◉]", "[◉‿◉]", "[◉‿◉]", "[◉‿◉]", "[◉‿◉]",
];

/** Tool phase: eyes forward, fast brain pulse. */
export const ROBOT_TOOL_FRAMES = ["[◉▂◉]", "[◉▄◉]", "[◉▆◉]", "[◉▄◉]"];

/** Stalled: asleep, slow breathing. */
export const ROBOT_SLEEP_FRAMES = ["[·_·]", "[·_·]", "[·_·]", "[·‿·]", "[·‿·]", "[·_·]", "[·_·]", "[·_·]"];

/** Done phase: pleased. */
export const ROBOT_DONE_FRAMES = ["[◕‿◕]"];

/** Static frame under reducedMotion. */
export const ROBOT_STATIC_FRAME = "[◉_◉]";

/** Short reaction shown right after a tool finishes (driven by index.ts). */
export const ROBOT_FACE_HAPPY = "[◕‿◕]";
export const ROBOT_FACE_SAD = "[◉⌓◉]";

/** Loader frame interval (ms per frame) for each robot set. */
export const ROBOT_WAIT_MS = 120;
export const ROBOT_THINK_MS = 300;
export const ROBOT_RESPOND_MS = 120;
export const ROBOT_TOOL_MS = 150;
export const ROBOT_SLEEP_MS = 350;

export interface RobotFrameSet {
	frames: string[];
	/** Loader frame interval; the set cycles at this speed. */
	intervalMs: number;
}

/** Robot frame set for a phase (done/idle fall back to the pleased face). */
export function robotFramesForPhase(phase: Phase): RobotFrameSet {
	switch (phase) {
		case "requesting":
			return { frames: ROBOT_WAIT_FRAMES, intervalMs: ROBOT_WAIT_MS };
		case "thinking":
			return { frames: ROBOT_THINK_FRAMES, intervalMs: ROBOT_THINK_MS };
		case "responding":
			return { frames: ROBOT_RESPOND_FRAMES, intervalMs: ROBOT_RESPOND_MS };
		case "tool":
			return { frames: ROBOT_TOOL_FRAMES, intervalMs: ROBOT_TOOL_MS };
		default:
			return { frames: ROBOT_DONE_FRAMES, intervalMs: ROBOT_WAIT_MS };
	}
}

export function framesForPhase(phase: Phase, perPhase: boolean): string[] {
	if (phase === "tool") return TOOL_FRAMES;
	if (!perPhase) return STAR_FRAMES;
	if (phase === "requesting") return DOT_FRAMES;
	return STAR_FRAMES;
}

export function firstFrameForPhase(phase: Phase, perPhase: boolean): string {
	return framesForPhase(phase, perPhase)[0];
}
