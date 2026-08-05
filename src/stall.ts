/**
 * Stall detection, liveliness, and fade math.
 *
 * Two coupled signals derived from token flow:
 * - liveliness ∈ [0,1]: rises toward 1 while tokens flow, decays when flow
 *   stops. Drives glimmer/wave/breath speed & presence.
 * - stalled: no new tokens for `stallAfterMs` AND no active tool (an active
 *   tool suppresses stall — bug 3 fix). Compaction pauses detection by
 *   resetting `lastActivity`.
 */
import type { Phase } from "./state-machine.ts";

export const FLOW_WINDOW_MS = 1000;
export const RISE_TAU_MS = 250;
export const DECAY_TAU_MS = 1500;

/** Exponential liveliness update. */
export function updateLiveliness(liveliness: number, lastTokenAt: number, now: number, dtMs: number): number {
	let l = liveliness;
	if (now - lastTokenAt <= FLOW_WINDOW_MS) {
		l += (1 - l) * (1 - Math.exp(-dtMs / RISE_TAU_MS));
	} else {
		l *= Math.exp(-dtMs / DECAY_TAU_MS);
	}
	if (l < 0.001) l = 0;
	if (l > 1) l = 1;
	return l;
}

export function shouldStall(
	now: number,
	lastActivity: number,
	stallAfterMs: number,
	toolCount: number,
	phase: Phase,
): boolean {
	if (stallAfterMs <= 0) return false;
	if (toolCount > 0) return false;
	if (phase !== "requesting" && phase !== "thinking" && phase !== "responding" && phase !== "tool") {
		return false;
	}
	return now - lastActivity > stallAfterMs;
}

/**
 * Stall fade intensity, 0 → 1 with an exponential approach: ~0.94 at 2s, so
 * the glyph is essentially fully red after about 2 seconds.
 */
export function stallIntensity(elapsedMs: number): number {
	return Math.min(1, 1 - Math.exp(-elapsedMs / 700));
}

/** Tier boundaries for the stall word: worried < 15s, desperate < 45s, then existential. */
export function tierIndex(elapsedMs: number): number {
	if (elapsedMs >= 45000) return 2;
	if (elapsedMs >= 15000) return 1;
	return 0;
}
