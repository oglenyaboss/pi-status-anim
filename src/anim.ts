/**
 * Text animations: glimmer, wave, breath, thinking shimmer, anxiety gradient.
 *
 * All colors are derived from theme tokens (see theme.ts). The emitted ANSI
 * codes only set the foreground color and never reset, so unstyled characters
 * keep the terminal's default styling for the row.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { lerpRgb, rgbAnsi, tokenRgb } from "./theme.ts";

/** Restore the pi working-row's muted foreground after an animated verb,
 * so suffix parts inherit `muted` (pi's messageColorFn default) instead of
 * the terminal's default foreground. pi wraps the whole message in
 * `theme.fg("muted", text)` = `\x1b[muted]…\x1b[39m`; a plain `\x1b[39m` here
 * would drop the suffix to the default fg, so we re-emit muted instead.
 */
const restoreMuted = (theme: Theme, mode: "truecolor" | "256color"): string =>
	rgbAnsi(tokenRgb(theme, "muted"), mode);

/**
 * Glimmer: a soft light spot sweeping smoothly along the verb. The whole
 * verb is rendered in the base (`muted`) color; the spot is an overlay that
 * interpolates `muted → accent` by distance to a float position, so the spot
 * is a smooth gradient (not a hard 3-char step). The position travels along a
 * cycle of `len + 2·PAD` cells, entering and leaving the word with a pause at
 * each edge (matches the reference's quiet cadence rather than a busy loop).
 * Direction/speed depend on phase: `requesting` is fast L→R, everything else
 * slow R→L. As liveliness falls the spot dims back into the base color and
 * effectively disappears near 0. Always ends with a foreground reset.
 */
const GLIMMER_PAD = 10;
export function glimmer(
	theme: Theme,
	text: string,
	elapsedMs: number,
	phase: "requesting" | "other",
	liveliness: number,
): string {
	const chars = [...text];
	const len = chars.length;
	if (len === 0) return text;
	const mode = theme.getColorMode();
	const base = tokenRgb(theme, "muted");
	const intensity = Math.min(1, Math.max(0, liveliness));
	const spot = lerpRgb(base, tokenRgb(theme, "accent"), 0.35 + 0.65 * intensity);
	const speed = phase === "requesting" ? 50 : 200; // ms per cell
	const cycle = len + 2 * GLIMMER_PAD;
	const cp = (elapsedMs / speed) % cycle;
	const pos = phase === "requesting" ? cp - GLIMMER_PAD : len + GLIMMER_PAD - cp;
	let out = "";
	for (let i = 0; i < len; i += 1) {
		const d = Math.abs(i - pos);
		let t = 0;
		if (d <= 1.5) t = ((1.5 - d) / 1.5) * intensity;
		out += rgbAnsi(lerpRgb(base, spot, t), mode) + chars[i];
	}
	return out + restoreMuted(theme, mode);
}

/**
 * Wave: a traveling brightness wave along the verb. Every glyph is rendered
 * (base `muted` modulated by a sine), so the verb reads as one continuous
 * colored word with a wave of light running across it. Ends with a reset.
 */
export function wave(theme: Theme, text: string, elapsedMs: number, liveliness: number): string {
	const chars = [...text];
	const len = chars.length;
	if (len === 0) return text;
	const mode = theme.getColorMode();
	const base = tokenRgb(theme, "muted");
	const peak = tokenRgb(theme, "accent");
	const intensity = Math.min(1, Math.max(0, liveliness));
	const t = elapsedMs / 1000;
	const k = 0.9;
	const effective = (2 * Math.PI / 1.5) * (0.4 + 0.6 * intensity);
	let out = "";
	for (let i = 0; i < len; i += 1) {
		const s = (Math.sin(i * k + t * effective) + 1) / 2; // 0..1
		const rgb = lerpRgb(base, peak, (0.25 + 0.75 * s) * intensity);
		out += rgbAnsi(rgb, mode) + chars[i];
	}
	return out + restoreMuted(theme, mode);
}

/**
 * Breath: the whole verb pulses as one sine between the base and accent
 * colors (calmer than wave). Ends with a reset.
 */
export function breath(theme: Theme, text: string, elapsedMs: number, liveliness: number): string {
	const mode = theme.getColorMode();
	const base = tokenRgb(theme, "muted");
	const peak = tokenRgb(theme, "accent");
	const intensity = Math.min(1, Math.max(0, liveliness));
	const t = elapsedMs / 1000;
	const speed = (2 * Math.PI / 3) * (0.4 + 0.6 * intensity);
	const s = (Math.sin(t * speed) + 1) / 2; // 0..1
	return rgbAnsi(lerpRgb(base, peak, (0.35 + 0.65 * s) * intensity), mode) + text + restoreMuted(theme, mode);
}

/**
 * Thinking shimmer (suffix only): the `(thinking…)` marker pulses between the
 * theme's `dim` and `accent` colors with a 2s period, starting after 3s of
 * thinking. Before that the marker is plain.
 */
export function thinkingShimmer(theme: Theme, thinkingMs: number, text: string): string {
	if (thinkingMs < 3000) return text;
	const t = (Math.sin((thinkingMs * 2 * Math.PI) / 2000) + 1) / 2;
	const rgb = lerpRgb(tokenRgb(theme, "dim"), tokenRgb(theme, "accent"), t);
	return rgbAnsi(rgb, theme.getColorMode()) + text + restoreMuted(theme, theme.getColorMode());
}

/**
 * Anxiety gradient: after 60s of thinking the verb warms gray → amber →
 * orange. Endpoints are theme tokens: `muted` → `warning` (60s…120s), then
 * `warning` → `error` (120s…180s), which passes through orange.
 */
export function anxietyColor(theme: Theme, thinkingMs: number): string | null {
	if (thinkingMs < 60000) return null;
	const t1 = Math.min(1, (thinkingMs - 60000) / 60000);
	const t2 = Math.min(1, Math.max(0, (thinkingMs - 120000) / 60000));
	const rgb =
		t2 > 0
			? lerpRgb(tokenRgb(theme, "warning"), tokenRgb(theme, "error"), t2)
			: lerpRgb(tokenRgb(theme, "muted"), tokenRgb(theme, "warning"), t1);
	return rgbAnsi(rgb, theme.getColorMode());
}
