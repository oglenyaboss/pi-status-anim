/**
 * Theme-derived color helpers.
 *
 * All interpolated colors (glimmer spot, wave/breath brightness, thinking
 * shimmer, anxiety gradient, stall fade) are derived from the active theme's
 * tokens — never hardcoded. `tokenRgb` parses the ANSI escape the theme emits
 * for a token and converts 256-color indices through the standard xterm
 * palette, so interpolation works in both truecolor and 256-color terminals.
 */
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";

export interface Rgb {
	r: number;
	g: number;
	b: number;
}

const clamp255 = (n: number): number => Math.min(255, Math.max(0, Math.round(n)));

/** `theme.fg(token, text)` with a safe fallback to the plain text. */
export function fg(theme: Theme, color: ThemeColor, text: string): string {
	try {
		return theme.fg(color, text);
	} catch {
		return text;
	}
}

/** Resolve a theme token to RGB components. */
export function tokenRgb(theme: Theme, color: ThemeColor): Rgb {
	let ansi = "";
	try {
		ansi = theme.getFgAnsi(color);
	} catch {
		// fall through to the neutral default below
	}
	const rgb = ansi.match(/38;2;(\d+);(\d+);(\d+)/);
	if (rgb) {
		return { r: clamp255(+rgb[1]), g: clamp255(+rgb[2]), b: clamp255(+rgb[3]) };
	}
	const index = ansi.match(/38;5;(\d+)/);
	if (index) return ansi256ToRgb(+index[1]);
	// Default foreground or unresolvable token: neutral gray.
	return { r: 170, g: 170, b: 170 };
}

/** Linear interpolation between two RGB colors, t clamped to [0, 1]. */
export function lerpRgb(a: Rgb, b: Rgb, t: number): Rgb {
	const k = Math.min(1, Math.max(0, t));
	return {
		r: Math.round(a.r + (b.r - a.r) * k),
		g: Math.round(a.g + (b.g - a.g) * k),
		b: Math.round(a.b + (b.b - a.b) * k),
	};
}

/** ANSI foreground escape for an RGB color in the theme's color mode. */
export function rgbAnsi(rgb: Rgb, mode: "truecolor" | "256color"): string {
	if (mode === "256color") return `\x1b[38;5;${rgbToAnsi256(rgb)}m`;
	return `\x1b[38;2;${rgb.r};${rgb.g};${rgb.b}m`;
}

// Standard xterm 256-color palette.
const BASIC_COLORS: Rgb[] = [
	{ r: 0, g: 0, b: 0 },
	{ r: 128, g: 0, b: 0 },
	{ r: 0, g: 128, b: 0 },
	{ r: 128, g: 128, b: 0 },
	{ r: 0, g: 0, b: 128 },
	{ r: 128, g: 0, b: 128 },
	{ r: 0, g: 128, b: 128 },
	{ r: 192, g: 192, b: 192 },
	{ r: 128, g: 128, b: 128 },
	{ r: 255, g: 0, b: 0 },
	{ r: 0, g: 255, b: 0 },
	{ r: 255, g: 255, b: 0 },
	{ r: 0, g: 0, b: 255 },
	{ r: 255, g: 0, b: 255 },
	{ r: 0, g: 255, b: 255 },
	{ r: 255, g: 255, b: 255 },
];

const CUBE_VALUES = [0, 95, 135, 175, 215, 255];
const GRAY_VALUES = Array.from({ length: 24 }, (_, i) => 8 + i * 10);

export function ansi256ToRgb(index: number): Rgb {
	const n = Math.min(255, Math.max(0, Math.round(index)));
	if (n < 16) return BASIC_COLORS[n];
	if (n < 232) {
		const v = n - 16;
		return {
			r: CUBE_VALUES[Math.floor(v / 36)],
			g: CUBE_VALUES[Math.floor(v / 6) % 6],
			b: CUBE_VALUES[v % 6],
		};
	}
	const gray = GRAY_VALUES[n - 232];
	return { r: gray, g: gray, b: gray };
}

function closestIndex(values: number[], value: number): number {
	let best = 0;
	let bestDist = Infinity;
	for (let i = 0; i < values.length; i += 1) {
		const d = Math.abs(values[i] - value);
		if (d < bestDist) {
			bestDist = d;
			best = i;
		}
	}
	return best;
}

function colorDistance(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number {
	const dr = r1 - r2;
	const dg = g1 - g2;
	const db = b1 - b2;
	return dr * dr * 0.299 + dg * dg * 0.587 + db * db * 0.114;
}

/** Nearest 256-color index (weighted distance; grayscale only when neutral). */
export function rgbToAnsi256(rgb: Rgb): number {
	const { r, g, b } = rgb;
	const ri = closestIndex(CUBE_VALUES, r);
	const gi = closestIndex(CUBE_VALUES, g);
	const bi = closestIndex(CUBE_VALUES, b);
	const cubeIndex = 16 + 36 * ri + 6 * gi + bi;
	const cubeDist = colorDistance(r, g, b, CUBE_VALUES[ri], CUBE_VALUES[gi], CUBE_VALUES[bi]);
	const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
	const grayIdx = closestIndex(GRAY_VALUES, gray);
	const grayIndex = 232 + grayIdx;
	const grayDist = colorDistance(r, g, b, GRAY_VALUES[grayIdx], GRAY_VALUES[grayIdx], GRAY_VALUES[grayIdx]);
	const spread = Math.max(r, g, b) - Math.min(r, g, b);
	if (spread < 10 && grayDist < cubeDist) return grayIndex;
	return cubeIndex;
}
