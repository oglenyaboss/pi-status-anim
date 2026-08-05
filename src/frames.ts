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

export function framesForPhase(phase: Phase, perPhase: boolean): string[] {
	if (phase === "tool") return TOOL_FRAMES;
	if (!perPhase) return STAR_FRAMES;
	if (phase === "requesting") return DOT_FRAMES;
	return STAR_FRAMES;
}

export function firstFrameForPhase(phase: Phase, perPhase: boolean): string {
	return framesForPhase(phase, perPhase)[0];
}
