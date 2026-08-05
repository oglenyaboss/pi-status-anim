/**
 * Row composition + width gating.
 *
 * `composeRow` is a pure function:
 *   `<glyph> <verb-with-anim><optional suffix parts>`
 *
 * Suffix parts are ordered by priority (highest first). They are kept in
 * order and dropped from the tail while the available space is exceeded —
 * never partially. The verb and the phase marker are never dropped. The
 * interrupt hint is appended only when nothing else is shown (bug 5/6 fixes).
 */
export interface SuffixPart {
	key: string;
	/** Plain text (used for width measurement). */
	plain: string;
	/** Final rendered text (may contain ANSI color codes). */
	rendered: string;
}

export interface RowInput {
	/** Rendered glyph (may contain ANSI). */
	glyph: string;
	/** Plain verb text including the trailing ellipsis. */
	verbPlain: string;
	/** Animated verb text (may contain ANSI). */
	verbRendered: string;
	/** Phase/thought marker (priority 1, never dropped). */
	marker: SuffixPart | null;
	/** Remaining suffix parts, highest priority first. */
	parts: SuffixPart[];
	/** Interrupt hint; shown only when nothing else is. */
	hint: SuffixPart | null;
	columns: number;
}

export function composeRow(input: RowInput): string {
	const { columns } = input;
	const glyphW = displayWidth(input.glyph);
	const verbW = displayWidth(input.verbPlain);
	const markerW = input.marker ? displayWidth(input.marker.plain) + 1 : 0;
	const available = columns - verbW - glyphW - 5 - markerW;

	const kept: SuffixPart[] = [];
	let used = 0;
	for (const part of input.parts) {
		const w = displayWidth(part.plain) + 1;
		if (used + w > available) break;
		kept.push(part);
		used += w;
	}

	let tail = kept;
	if (!input.marker && kept.length === 0 && input.hint) {
		if (displayWidth(input.hint.plain) + 1 <= available) tail = [input.hint];
	}

	const parts = input.marker ? [input.marker, ...tail] : tail;
	return input.glyph + " " + input.verbRendered + parts.map((p) => " " + p.rendered).join("");
}

/** Visible width of a string: ANSI stripped, wide chars counted as 2. */
export function displayWidth(text: string): number {
	const stripped = text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
	let width = 0;
	for (const ch of stripped) {
		width += charWidth(ch.codePointAt(0) ?? 0);
	}
	return width;
}

function charWidth(cp: number): number {
	if (cp === 0 || cp === 0x200b) return 0; // zero-width
	if (cp >= 0x300 && cp <= 0x36f) return 0; // combining marks
	if (cp >= 0x1100 && cp <= 0x115f) return 2; // Hangul Jamo
	if (cp === 0x2329 || cp === 0x232a) return 2;
	if (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) return 2; // CJK, Yi
	if (cp >= 0xac00 && cp <= 0xd7a3) return 2; // Hangul syllables
	if (cp >= 0xf900 && cp <= 0xfaff) return 2; // CJK compatibility
	if (cp >= 0xfe10 && cp <= 0xfe19) return 2;
	if (cp >= 0xfe30 && cp <= 0xfe6f) return 2;
	if (cp >= 0xff00 && cp <= 0xff60) return 2; // fullwidth forms
	if (cp >= 0xffe0 && cp <= 0xffe6) return 2;
	if (cp >= 0x1f300 && cp <= 0x1faff) return 2; // emoji
	if (cp >= 0x20000 && cp <= 0x3fffd) return 2; // CJK ext
	return 1;
}

/** Smooth odometer: eases `displayed` toward `target` without overshooting. */
export function stepOdometer(displayed: number, target: number): number {
	const gap = target - displayed;
	if (gap <= 0) return displayed;
	const step = gap < 70 ? 3 : gap < 200 ? Math.ceil(gap * 0.15) : 50;
	const next = displayed + step;
	return next > target ? target : next;
}

/** "1234" → "1.2k". */
export function formatTokens(n: number): string {
	if (n >= 1000) {
		const k = n / 1000;
		return `${k >= 100 ? Math.round(k) : k.toFixed(1)}k`;
	}
	return String(n);
}
