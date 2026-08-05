/**
 * Text animations: glimmer, wave, breath, thinking shimmer, anxiety gradient.
 *
 * All colors are derived from theme tokens (see theme.ts). The emitted ANSI
 * codes only set the foreground color and never reset, so unstyled characters
 * keep the terminal's default styling for the row.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { lerpRgb, rgbAnsi, tokenRgb } from "./theme.ts";

/**
 * Glimmer: a soft 3-character light spot sweeping along the verb
 * (`pos-1, pos, pos+1` in the shimmer color, the rest in the verb color).
 * The spot dims toward the verb color as liveliness falls and goes away
 * entirely when liveliness ≈ 0. Each lit character re-emits the muted color
 * so the spot really is 3 characters (no ANSI leak into the tail).
 */
export function glimmer(theme: Theme, text: string, pos: number, liveliness: number): string {
	const chars = [...text];
	const len = chars.length;
	if (len === 0) return text;
	const t = 0.35 + 0.65 * Math.min(1, Math.max(0, liveliness));
	const spot = lerpRgb(tokenRgb(theme, "muted"), tokenRgb(theme, "accent"), t);
	const mode = theme.getColorMode();
	const ansi = rgbAnsi(spot, mode);
	const rest = rgbAnsi(tokenRgb(theme, "muted"), mode);
	const p = ((pos % len) + len) % len;
	const lit = new Set([p, (p - 1 + len) % len, (p + 1) % len]);
	return chars.map((c, i) => (lit.has(i) ? ansi + c + rest : c)).join("");
}

/**
 * Wave: brightness of each glyph position = base + amp·sin(pos·k + t·speed) —
 * a traveling light wave along the verb. Dims and slows as liveliness falls.
 */
export function wave(theme: Theme, text: string, elapsedMs: number, liveliness: number): string {
	const chars = [...text];
	const base = tokenRgb(theme, "muted");
	const mode = theme.getColorMode();
	const dim = 0.35 + 0.65 * Math.min(1, Math.max(0, liveliness));
	const t = elapsedMs / 1000;
	const k = 0.9;
	const speed = (2 * Math.PI) / 1.5;
	const effective = speed * (0.4 + 0.6 * Math.min(1, Math.max(0, liveliness)));
	return chars
		.map((c, i) => {
			const b = Math.max(0.25, Math.min(1, 0.65 + 0.35 * Math.sin(i * k + t * effective)));
			const rgb = {
				r: Math.round(base.r * b * dim),
				g: Math.round(base.g * b * dim),
				b: Math.round(base.b * b * dim),
			};
			return rgbAnsi(rgb, mode) + c;
		})
		.join("");
}

/**
 * Breath: the whole verb's brightness pulses as one sine (calmer than wave).
 */
export function breath(theme: Theme, text: string, elapsedMs: number, liveliness: number): string {
	const base = tokenRgb(theme, "muted");
	const mode = theme.getColorMode();
	const dim = 0.35 + 0.65 * Math.min(1, Math.max(0, liveliness));
	const t = elapsedMs / 1000;
	const speed = (2 * Math.PI) / 3;
	const b = Math.max(
		0.25,
		Math.min(1, 0.7 + 0.3 * Math.sin(t * speed * (0.4 + 0.6 * Math.min(1, Math.max(0, liveliness))))),
	);
	const rgb = {
		r: Math.round(base.r * b * dim),
		g: Math.round(base.g * b * dim),
		b: Math.round(base.b * b * dim),
	};
	return rgbAnsi(rgb, mode) + text;
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
	return rgbAnsi(rgb, theme.getColorMode()) + text;
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
