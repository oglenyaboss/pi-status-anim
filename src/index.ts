/**
 * pi-status-anim — animated working row for the pi coding agent.
 *
 * Replaces the default streaming status row with a richer, animated status:
 * phased verbs, glyph animation, token counter, stall feedback, and easter
 * eggs. Official pi extension API only; all imports from the pi package are
 * `import type` (erased at runtime), so there are zero runtime dependencies.
 *
 * The row is only ever owned while the active status indicator is `working`,
 * and every handler is guarded by `ctx.mode === "tui"` (no work outside the
 * TUI — bug fix §12.1). Lifecycle follows pi: the row appears on
 * `agent_start`, is hidden on `agent_end`; the animation clock exists only
 * between those two events.
 */
import type {
	AgentEndEvent,
	AgentStartEvent,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	MessageEndEvent,
	MessageUpdateEvent,
	SessionBeforeCompactEvent,
	SessionCompactEvent,
	SessionShutdownEvent,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { anxietyColor, breath, glimmer, thinkingShimmer, wave } from "./anim.ts";
import { loadConfig, updateConfig, type StatusAnimConfig } from "./config.ts";
import {
	DONE_GLYPH,
	firstFrameForPhase,
	framesForPhase,
	ROBOT_DONE_FRAMES,
	ROBOT_FACE_HAPPY,
	ROBOT_FACE_SAD,
	ROBOT_SLEEP_FRAMES,
	ROBOT_SLEEP_MS,
	ROBOT_STATIC_FRAME,
	robotFramesForPhase,
	STATIC_GLYPH,
} from "./frames.ts";
import { GitStatus, gitEggFor } from "./git.ts";
import { createLogger, stripAnsi } from "./log.ts";
import { composeRow, formatTokens, stepOdometer, type RowInput, type SuffixPart } from "./render.ts";
import {
	initialState,
	onMessageEnd,
	onTextBlock,
	onThinkingBlock,
	onToolEnd,
	onToolStart,
	startLoop,
	type VerbPick,
} from "./state-machine.ts";
import { shouldStall, stallIntensity, tierIndex, updateLiveliness } from "./stall.ts";
import { fg, lerpRgb, rgbAnsi, tokenRgb } from "./theme.ts";
import {
	FUN_FACTS,
	modelEggFor,
	pickVerb,
	REQUESTING_VERBS,
	RESPONDING_VERBS,
	STALL_TIERS,
	THINKING_VERBS,
	timeEggFor,
} from "./verbs.ts";

/**
 * Interrupt hint key text. pi's keybinding registry is not exposed to
 * extensions, so the text is a fixed fallback.
 */
const INTERRUPT_KEY = "escape"; // pi default for app.interrupt

/** Structural shape of the `model_select` event (not re-exported at package root). */
type ModelSelectLike = { model: { id: string } };

/** Rotate the stall tier word every 3s. */
const STALL_WORD_ROTATE_MS = 3000;

/** Fun facts rotate every 10s after the 60s mark. */
const FACT_ROTATE_MS = 10000;
const FACT_AFTER_MS = 60000;

/** How long the robot face reaction to a finished tool stays up. */
const ROBOT_FACE_MS = 2000;

// ── /statusanim command metadata ─────────────────────────────────────────
// Options exposed by the interactive TUI menu and the `<key> <value>` form.
// Kept at module level so the same list drives the menu, argument
// validation and autocomplete.

interface StatusAnimOption {
	key: string;
	label: string;
	type: "bool" | "number" | "string" | "words";
	min?: number;
	max?: number;
}

const CONFIG_OPTIONS: StatusAnimOption[] = [
	{ key: "robotAvatar", label: "robot face across all phases", type: "bool" },
	{ key: "phaseGlyphs", label: "per-phase glyph sets", type: "bool" },
	{ key: "reducedMotion", label: "static glyph and plain text", type: "bool" },
	{ key: "animChance", label: "probability of wave/breath per agent-loop", type: "number", min: 0, max: 1 },
	{ key: "animAfterMs", label: "wave/breath start delay (ms)", type: "number", min: 0, max: 60000 },
	{ key: "stallAfterMs", label: "stall threshold without tokens (ms)", type: "number", min: 0, max: 120000 },
	{ key: "stallTiers", label: "tier words while stalled", type: "bool" },
	{ key: "showTimer", label: "elapsed timer suffix", type: "bool" },
	{ key: "timerAfterMs", label: "timer appears after (ms)", type: "number", min: 0, max: 60000 },
	{ key: "tokenCounter", label: "token counter suffix", type: "bool" },
	{ key: "tokenRate", label: "tokens/sec in the counter", type: "bool" },
	{ key: "tokenAfterMs", label: "counter appears after (ms)", type: "number", min: 0, max: 60000 },
	{ key: "toolDetail", label: "tool detail suffix", type: "bool" },
	{ key: "queueHint", label: "(+ queued) hint", type: "bool" },
	{ key: "summary", label: "end-of-loop tokens/time notification", type: "bool" },
	{ key: "modelEggs", label: "model-name easter eggs", type: "bool" },
	{ key: "timeEggs", label: "time-of-day easter eggs", type: "bool" },
	{ key: "gitStatus", label: "git easter eggs", type: "bool" },
	{ key: "funFacts", label: "fun facts after 60s of thinking", type: "bool" },
	{ key: "anxietyGradient", label: "verb warms after 60s of thinking", type: "bool" },
	{ key: "effortSuffix", label: "thinking-effort wording (empty = auto)", type: "string" },
	{ key: "words", label: "extra requesting verbs (comma-separated)", type: "words" },
];

/** Human-readable current value for the menu line. */
const optionValue = (cfg: StatusAnimConfig, opt: StatusAnimOption): string => {
	const v = (cfg as unknown as Record<string, unknown>)[opt.key];
	if (opt.type === "bool") return v ? "on" : "off";
	if (opt.type === "words") return Array.isArray(v) && v.length > 0 ? v.join(", ") : "(none)";
	return String(v);
};

/** Parse and validate one option from the quick-set form. */
const parseScalar = (
	opt: StatusAnimOption,
	raw: string,
): { ok: true; value: unknown } | { ok: false; reason: string } => {
	if (opt.type === "bool") {
		if (raw === "on" || raw === "true") return { ok: true, value: true };
		if (raw === "off" || raw === "false") return { ok: true, value: false };
		return { ok: false, reason: "expected on|off" };
	}
	if (opt.type === "number") {
		const n = Number(raw);
		if (!Number.isFinite(n)) return { ok: false, reason: "expected a number" };
		const min = opt.min ?? -Infinity;
		const max = opt.max ?? Infinity;
		if (n < min || n > max) return { ok: false, reason: `expected ${min}..${max}` };
		return { ok: true, value: n };
	}
	if (opt.type === "words") {
		return { ok: true, value: raw.split(",").map((s) => s.trim()).filter(Boolean) };
	}
	return { ok: true, value: raw };
};

/** Reduced motion keeps a single clock; it doubles as the stall timer. */
const REDUCED_MOTION_TICK_MS = 500;

/** Tool args that carry a count, for the detailed tool suffix. */
const TOOL_COUNTS: Record<string, { key: string; unit: string }> = {
	grep: { key: "limit", unit: "files" },
	find: { key: "limit", unit: "files" },
	ls: { key: "limit", unit: "entries" },
	read: { key: "limit", unit: "lines" },
};

export default function statusAnim(pi: ExtensionAPI): void {
	const cfg = loadConfig();
	if (!cfg.enabled) return;

	const log = createLogger();
	const git = new GitStatus();
	const requestingPool = [...REQUESTING_VERBS, ...cfg.words];
	const lastVerbIdx = { current: -1 };
	const tickMs = cfg.reducedMotion ? REDUCED_MOTION_TICK_MS : cfg.intervalMs;

	// ── Live state ────────────────────────────────────────────────────────
	let machine = initialState();
	let lastCtx: ExtensionContext | null = null;
	let clock: ReturnType<typeof setInterval> | null = null;
	let rowActive = false;
	let loopSeq = 0;
	let loopStart = 0;
	let lastTickAt = 0;
	let lastActivity = 0;
	let lastTokenAt = 0;
	let responseLength = 0;
	let prevTurnLen = 0; // accumulated length of completed turns in this agent-loop
	let tokens = 0;
	let displayedTokens = 0;
	let rateSamples: Array<{ at: number; len: number }> = [];
	let smoothedRate = 0; // EMA-smoothed tok/s, so the suffix doesn't jump
	let liveliness = 0;
	let stalled = false;
	let stallSince = 0;
	let stallWord = "";
	let lastStallWordAt = 0;
	let animMode: "glimmer" | "wave" | "breath" = "glimmer";
	let lastFactAt = 0;
	let factText = "";
	// Robot reaction to the last finished tool (happy/sad face for 2s).
	let faceFrames: string[] | null = null;
	let faceUntil = 0;
	let faceIsError = false;
	let modelId = "";
	let thinkingLevel: NonNullable<ExtensionContext["thinkingLevel"]> = "medium";
	let lastRendered = "";
	let lastFrames = "";

	// ── Debug logging helpers ────────────────────────────────────────────
	/** Snapshot of the live state for one log line. */
	const snap = (): Record<string, unknown> => ({
		phase: machine.phase,
		verbSource: machine.verbSource,
		verb: machine.verb,
		thinkingActive: machine.thinkingActive,
		thinkingStart: machine.thinkingStart,
		toolCount: machine.toolCount,
		toolName: machine.toolName,
		responseLength,
		prevTurnLen,
		tokens,
		displayedTokens,
		liveliness: Number(liveliness.toFixed(3)),
		stalled,
		stallSince,
		loopSeq,
		loopStart,
		lastActivity,
		lastTokenAt,
	});

	const columns = (): number =>
		process.stdout.columns && process.stdout.columns > 0 ? process.stdout.columns : 80;

	// ── Verb picking ──────────────────────────────────────────────────────

	const rollRequestingVerb = (ctx: ExtensionContext): VerbPick => {
		// git (~50% when there is something to say), then model (~25%), then
		// time (~20%), then a plain verb.
		const gitInfo = cfg.gitStatus ? git.fresh() : null;
		if (gitInfo && Math.random() < 0.5) {
			const egg = gitEggFor(gitInfo);
			if (egg) return { verb: egg, source: "egg" };
		}
		if (cfg.gitStatus && !gitInfo) {
			// Async fetch: seeds the requesting verb when it resolves, but
			// only if this agent-loop is still in `requesting` with a
			// generic verb (and no newer loop has started).
			const seq = loopSeq;
			const cwd = ctx.cwd;
			void git.refresh(pi, cwd).then((info) => {
				if (seq !== loopSeq || !rowActive || machine.phase !== "requesting") return;
				if (machine.verbSource !== "generic" || !info || Math.random() >= 0.5) return;
				const egg = gitEggFor(info);
				if (!egg) return;
				machine = { ...machine, verb: egg, verbSource: "egg" };
				render(lastCtx!, Date.now());
			});
		}
		if (cfg.modelEggs && Math.random() < 0.25) {
			const egg = modelEggFor(modelId);
			if (egg) return { verb: egg, source: "egg" };
		}
		if (cfg.timeEggs && Math.random() < 0.2) {
			const egg = timeEggFor(new Date());
			if (egg) return { verb: egg, source: "egg" };
		}
		return { verb: pickVerb(requestingPool, lastVerbIdx), source: "generic" };
	};

	const pickThinkingVerb = (): VerbPick => {
		// Keep easter-egg verbs (personality) across the thinking entry;
		// otherwise pick a thinking-ish verb.
		if (machine.verbSource === "egg") return { verb: machine.verb, source: "egg" };
		return { verb: pickVerb(THINKING_VERBS, lastVerbIdx), source: "thinking" };
	};

	// ── Phase / row helpers ───────────────────────────────────────────────

	/** Touch per-phase bookkeeping on a phase entry (kept for clarity). */
	const enterPhase = (now: number): void => {
		lastActivity = now;
	};

	const pickTierWord = (tier: number): string =>
		STALL_TIERS[tier][Math.floor(Math.random() * STALL_TIERS[tier].length)];

	/** Effort wording for the thinking marker. A non-empty `effortSuffix` in
	 * config overrides; otherwise derive from the live `thinkingLevel`. */
	const effortWord = (): string => {
		if (cfg.effortSuffix) return cfg.effortSuffix;
		switch (thinkingLevel) {
			case "high":
			case "xhigh":
			case "max":
				return "hard";
			case "minimal":
				return "lightly";
			default:
				return ""; // off / low / medium → neutral
		}
	};

	const formatSecs = (since: number, now: number): string =>
		`${Math.max(0, Math.floor((now - since) / 1000))}s`;

	const tokenRatePerSec = (now: number): number => {
		rateSamples = rateSamples.filter((s) => now - s.at <= 1200);
		if (rateSamples.length < 2) return 0; // no fresh flow → no rate
		const first = rateSamples[0];
		const last = rateSamples[rateSamples.length - 1];
		const dt = (last.at - first.at) / 1000;
		if (dt < 0.25) return 0;
		const inst = Math.max(0, (last.len - first.len) / 4 / dt);
		// EMA smooths bursty chunks into a stable average; the caller decides
		// whether a rate is meaningful at all (generation phases only).
		smoothedRate =
			inst >= smoothedRate
				? inst * 0.5 + smoothedRate * 0.5
				: inst * 0.3 + smoothedRate * 0.7;
		return Math.round(smoothedRate) > 0 ? Math.round(smoothedRate) : 0;
	};

	const toolDetailFor = (name: string, args: Record<string, unknown> | null): string => {
		const spec = TOOL_COUNTS[name];
		const n = spec && args ? args[spec.key] : undefined;
		if (typeof n === "number" && Number.isFinite(n)) {
			return `(${name} · ${n} ${spec!.unit})`;
		}
		return `(running ${name})`;
	};

	// ── Glyph frames ──────────────────────────────────────────────────────

	const stallColorAt = (theme: ExtensionContext["ui"]["theme"], now: number): string =>
		rgbAnsi(
			lerpRgb(tokenRgb(theme, "accent"), tokenRgb(theme, "error"), stallIntensity(now - stallSince)),
			theme.getColorMode(),
		);

	const currentFrames = (
		ctx: ExtensionContext,
		now: number,
	): { frames: string[]; intervalMs?: number } => {
		const theme = ctx.ui.theme;
		const mode = theme.getColorMode();
		const accent = tokenRgb(theme, "accent");

		// Robot avatar: one face per state, animated by pi's own Loader with
		// a per-set interval (thinking pulses slowly, tools fast).
		if (cfg.robotAvatar) {
			// 2s reaction to the last tool result: happy (accent) or sad (error).
			if (faceFrames && now < faceUntil) {
				const rgb = faceIsError ? tokenRgb(theme, "error") : accent;
				return { frames: [rgbAnsi(rgb, mode) + faceFrames[0]] };
			}
			// Stalled: the robot falls asleep, breathing slowly, fading red.
			if (stalled) {
				return {
					frames: ROBOT_SLEEP_FRAMES.map((f) => stallColorAt(theme, now) + f),
					intervalMs: ROBOT_SLEEP_MS,
				};
			}
			if (machine.phase === "done") return { frames: [rgbAnsi(accent, mode) + ROBOT_DONE_FRAMES[0]] };
			if (cfg.reducedMotion) return { frames: [rgbAnsi(accent, mode) + ROBOT_STATIC_FRAME] };
			const set = robotFramesForPhase(machine.phase);
			return { frames: set.frames.map((f) => rgbAnsi(accent, mode) + f), intervalMs: set.intervalMs };
		}

		// Classic abstract glyphs (Loader's default interval).
		if (stalled) {
			const staticGlyph = cfg.reducedMotion
				? STATIC_GLYPH
				: firstFrameForPhase(machine.phase, cfg.phaseGlyphs);
			return { frames: [stallColorAt(theme, now) + staticGlyph] };
		}
		if (machine.phase === "done") return { frames: [rgbAnsi(accent, mode) + DONE_GLYPH] };
		if (cfg.reducedMotion) return { frames: [rgbAnsi(accent, mode) + STATIC_GLYPH] };
		return {
			frames: framesForPhase(machine.phase, cfg.phaseGlyphs).map((f) => rgbAnsi(accent, mode) + f),
		};
	};

	const setFrames = (ctx: ExtensionContext, now: number): void => {
		const { frames, intervalMs } = currentFrames(ctx, now);
		const key = frames.join("\u0000") + "|" + (intervalMs ?? "");
		if (key === lastFrames) return;
		lastFrames = key;
		ctx.ui.setWorkingIndicator(intervalMs ? { frames, intervalMs } : { frames });
	};

	// ── Row composition ───────────────────────────────────────────────────

	const markerFor = (theme: ExtensionContext["ui"]["theme"], now: number): SuffixPart | null => {
		if (machine.thinkingActive) {
			const eff = effortWord();
			const text = `(thinking${eff ? " " + eff : ""}…)`;
			if (cfg.reducedMotion || stalled) {
				return { key: "thinking", plain: text, rendered: text };
			}
			return {
				key: "thinking",
				plain: text,
				rendered: thinkingShimmer(theme, now - machine.thinkingStart, text),
			};
		}
		if (machine.thinkingStart > 0) {
			const end = machine.thinkingEndAt || now;
			const secs = Math.max(1, Math.round((end - machine.thinkingStart) / 1000));
			const text = `(thought for ${secs}s)`;
			return { key: "thought", plain: text, rendered: fg(theme, "dim", text) };
		}
		return null;
	};

	const partsFor = (ctx: ExtensionContext, now: number): SuffixPart[] => {
		const theme = ctx.ui.theme;
		const parts: SuffixPart[] = [];

		// Direction indicator: ↑ only while truly waiting for the first byte
		// of the whole agent-loop (no tokens yet). Once any turn has produced
		// content, the ↓ counter carries the direction instead.
		if (machine.phase === "requesting" && tokens === 0) {
			parts.push({ key: "dir", plain: "↑", rendered: fg(theme, "dim", "↑") });
		}

		// Stall tier word (only while stalled; rotates every 3s in the tick).
		if (stalled && cfg.stallTiers && stallWord) {
			const text = `(${stallWord}…)`;
			parts.push({ key: "stall", plain: text, rendered: fg(theme, "error", text) });
		}

		// Fun fact after 60s of thinking.
		if (cfg.funFacts && machine.thinkingActive && now - machine.thinkingStart >= FACT_AFTER_MS) {
			if (now - lastFactAt > FACT_ROTATE_MS) {
				factText = FUN_FACTS[Math.floor(Math.random() * FUN_FACTS.length)];
				lastFactAt = now;
			}
			if (factText) {
				const text = `(fun fact: ${factText})`;
				parts.push({ key: "fact", plain: text, rendered: fg(theme, "dim", text) });
			}
		}

		// Timer is scoped to the whole agent-loop (monotonic, no downward jumps
		// on phase change).
		if (cfg.showTimer && now - loopStart >= cfg.timerAfterMs) {
			const text = formatSecs(loopStart, now);
			parts.push({ key: "timer", plain: text, rendered: fg(theme, "dim", text) });
		}

		// Token counter (full-snapshot recompute; smooth odometer). Scoped to the
		// agent-loop so it does not disappear on every phase change or between
		// turns. Uses `tokens` (accumulated loop total), not `responseLength`
		// (current message only), so it persists through inter-turn gaps.
		if (cfg.tokenCounter && tokens > 0 && now - loopStart >= cfg.tokenAfterMs) {
			let text = `↓ ${formatTokens(displayedTokens)}`;
			// Rate is a *generation* speed: shown only while the model is
			// actually generating (thinking/responding) with fresh flow. While a
			// tool runs the model is waiting, not slowing down — no rate. When
			// the flow stops the rate disappears instead of decaying to 0.
			const rate =
				cfg.tokenRate &&
				!stalled &&
				(machine.phase === "thinking" || machine.phase === "responding")
					? tokenRatePerSec(now)
					: 0;
			if (rate > 0) text += ` · ${rate}/s`;
			parts.push({ key: "tokens", plain: text, rendered: fg(theme, "dim", text) });
		}

		// Tool detail.
		if (cfg.toolDetail && machine.toolCount > 0 && machine.toolName) {
			const text = toolDetailFor(machine.toolName, machine.toolArgs);
			parts.push({ key: "tool", plain: text, rendered: fg(theme, "dim", text) });
		}

		// Queue hint.
		if (cfg.queueHint && ctx.hasPendingMessages()) {
			const text = "(+ queued)";
			parts.push({ key: "queue", plain: text, rendered: fg(theme, "dim", text) });
		}

		return parts;
	};

	const verbFor = (ctx: ExtensionContext, now: number): { plain: string; rendered: string } => {
		const plain = `${machine.verb}…`;
		if (cfg.reducedMotion || stalled) return { plain, rendered: plain }; // glimmer goes dark
		const theme = ctx.ui.theme;
		const thinkingMs = now - machine.thinkingStart;
		if (cfg.anxietyGradient && machine.thinkingActive && thinkingMs >= 60000) {
			const ansi = anxietyColor(theme, thinkingMs);
			return { plain, rendered: ansi ? ansi + plain : plain };
		}
		// In `requesting` there is no token flow yet, so liveliness stays 0;
		// the phase's own fast glimmer is the "alive" signal instead.
		const animLiveliness = machine.phase === "requesting" ? 1 : liveliness;
		if (animMode !== "glimmer" && now - loopStart >= cfg.animAfterMs) {
			const elapsed = now - loopStart;
			return {
				plain,
				rendered:
					animMode === "wave"
						? wave(theme, plain, elapsed, animLiveliness)
						: breath(theme, plain, elapsed, animLiveliness),
			};
		}
		if (animLiveliness > 0.05) {
			return {
				plain,
				rendered: glimmer(
					theme,
					plain,
					now - loopStart,
					machine.phase === "requesting" ? "requesting" : "other",
					animLiveliness,
				),
			};
		}
		return { plain, rendered: plain };
	};

	const buildRow = (ctx: ExtensionContext, now: number): RowInput => {
		const theme = ctx.ui.theme;
		const verb = verbFor(ctx, now);
		const marker = markerFor(theme, now);
		const parts = partsFor(ctx, now);
		const hint: SuffixPart = {
			key: "hint",
			plain: `(${INTERRUPT_KEY} to interrupt)`,
			rendered: fg(theme, "dim", `(${INTERRUPT_KEY} to interrupt)`),
		};
		const glyph = currentFrames(ctx, now).frames[0] ?? "";
		return {
			glyph,
			verbPlain: verb.plain,
			verbRendered: verb.rendered,
			marker,
			parts,
			hint,
			columns: columns(),
		};
	};

	const render = (ctx: ExtensionContext, now: number): void => {
		if (!rowActive) return;
		setFrames(ctx, now);
		const row = composeRow(buildRow(ctx, now));
		if (row === lastRendered) return;
		log.event("render", ctx, { row: stripAnsi(row) });
		lastRendered = row;
		ctx.ui.setWorkingMessage(row);
	};

	// ── Clock ─────────────────────────────────────────────────────────────

	const startClock = (): void => {
		if (clock) return;
		lastTickAt = Date.now();
		clock = setInterval(tick, tickMs);
	};

	const stopClock = (): void => {
		if (clock) {
			clearInterval(clock);
			clock = null;
		}
	};

	function tick(): void {
		const ctx = lastCtx;
		if (!ctx || !rowActive) return;
		const now = Date.now();
		const dt = Math.min(Math.max(now - lastTickAt, 1), 300);
		lastTickAt = now;

		// Liveliness.
		liveliness = updateLiveliness(liveliness, lastTokenAt, now, dt);

		// Stall detection (an active tool suppresses it).
		const stalledNow = shouldStall(
			now,
			lastActivity,
			cfg.stallAfterMs,
			machine.toolCount,
			machine.phase,
		);
		if (stalledNow && !stalled) {
			stalled = true;
			stallSince = now;
			stallWord = cfg.stallTiers ? pickTierWord(0) : "";
			lastStallWordAt = now;
			log.event("stall_begin", ctx, { afterMs: now - lastActivity });
		} else if (!stalledNow && stalled) {
			stalled = false;
			stallSince = 0;
			stallWord = "";
			log.event("stall_end", ctx);
		} else if (stalled && cfg.stallTiers && now - lastStallWordAt >= STALL_WORD_ROTATE_MS) {
			stallWord = pickTierWord(tierIndex(now - stallSince));
			lastStallWordAt = now;
		}

		// Token odometer (eases toward the target every tick). Tracks the target
		// in both directions: a rising target animates up, a falling target
		// (new turn resets responseLength) snaps down — see stepOdometer.
		if (cfg.tokenCounter && tokens !== displayedTokens) {
			displayedTokens = stepOdometer(displayedTokens, tokens);
		}

		render(ctx, now);
	}

	// ── Reset / teardown ──────────────────────────────────────────────────

	const resetRow = (ctx: ExtensionContext): void => {
		stopClock();
		rowActive = false;
		stalled = false;
		stallSince = 0;
		stallWord = "";
		machine = initialState();
		responseLength = 0;
		prevTurnLen = 0;
		tokens = 0;
		displayedTokens = 0;
		rateSamples = [];
		smoothedRate = 0;
		liveliness = 0;
		factText = "";
		lastRendered = "";
		lastFrames = "";
		ctx.ui.setWorkingMessage();
		ctx.ui.setWorkingIndicator();
		faceFrames = null;
		faceUntil = 0;
		faceIsError = false;
	};

	// ── Events ────────────────────────────────────────────────────────────

	pi.on("agent_start", (_event: AgentStartEvent, ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		lastCtx = ctx;
		modelId = ctx.model?.id ?? "";
		thinkingLevel = ctx.thinkingLevel ?? thinkingLevel;
		loopSeq += 1;
		loopStart = Date.now();
		lastActivity = loopStart;
		lastTokenAt = 0;
		responseLength = 0;
		prevTurnLen = 0;
		tokens = 0;
		displayedTokens = 0;
		rateSamples = [];
		smoothedRate = 0;
		liveliness = 0;
		factText = "";
		animMode = Math.random() < cfg.animChance ? (Math.random() < 0.5 ? "wave" : "breath") : "glimmer";
		machine = startLoop(rollRequestingVerb(ctx));
		enterPhase(loopStart);
		rowActive = true;
		startClock();
		log.event("agent_start", ctx, { model: modelId, ...snap() });
		render(ctx, Date.now());
	});

	pi.on("message_update", (event: MessageUpdateEvent, ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		const msg = event.message;
		if (msg.role !== "assistant") return;
		lastCtx = ctx;
		const now = Date.now();

		// Defensive fallback: the loop may resume mid-stream (e.g. session
		// resume) without a fresh agent_start.
		if (!rowActive) {
			loopSeq += 1;
			loopStart = now;
			modelId = ctx.model?.id ?? "";
			prevTurnLen = 0;
			responseLength = 0;
			tokens = 0;
			displayedTokens = 0;
			machine = startLoop(rollRequestingVerb(ctx));
			enterPhase(now);
			rowActive = true;
			startClock();
			log.event("resume_mid_stream", ctx, { model: modelId, ...snap() });
		}

		// Full content snapshot recompute — never accumulate (bug 9 fix).
		const prevLen = responseLength;
		let len = 0;
		let lastBlock: "thinking" | "text" | null = null;
		for (const block of msg.content) {
			if (block.type === "thinking") {
				len += block.thinking.length;
				lastBlock = "thinking";
			} else if (block.type === "text") {
				len += block.text.length;
				lastBlock = "text";
			} else if (block.type === "toolCall") {
				// Tool-call name + arguments count toward generated tokens —
				// matches pi's own estimateTokens in compaction.js.
				try {
					len += block.name.length + JSON.stringify(block.arguments ?? {}).length;
				} catch {
					len += block.name.length; // non-serialisable partial args
				}
			}
		}
		responseLength = len;
		// The counter is scoped to the whole agent-loop (SPEC §5): completed
		// turns accumulate, so `tokens` reflects everything generated this
		// loop, not just the current message. This keeps the counter monotonic
		// across turns instead of resetting to 0 each time.
		const loopLen = prevTurnLen + responseLength;
		tokens = Math.ceil(loopLen / 4); // same estimate as pi's estimateTokens
		rateSamples.push({ at: now, len: loopLen });
		rateSamples = rateSamples.filter((s) => now - s.at <= 1200);
		lastTokenAt = now;
		lastActivity = now;
		log.event("msg_update", ctx, { lastBlock, delta: len - prevLen, prevLen, ...snap() });

		if (lastBlock === "thinking") {
			const wasEntering = !machine.thinkingActive;
			const prevPhase = machine.phase;
			machine = onThinkingBlock(machine, pickThinkingVerb(), now);
			if (wasEntering) ctx.ui.setHiddenThinkingLabel(cfg.labelActive);
			if (machine.phase !== prevPhase) enterPhase(now);
		} else if (lastBlock === "text") {
			const wasThinking = machine.thinkingActive;
			const prevPhase = machine.phase;
			machine = onTextBlock(
				machine,
				{ verb: pickVerb(RESPONDING_VERBS, lastVerbIdx), source: "responding" },
				now,
			);
			if (wasThinking) ctx.ui.setHiddenThinkingLabel(cfg.labelDone);
			if (machine.phase !== prevPhase) enterPhase(now);
		}

		render(ctx, now);
	});

	pi.on("message_end", (event: MessageEndEvent, ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		if (event.message.role !== "assistant") return;
		lastCtx = ctx;
		const now = Date.now();
		const wasThinking = machine.thinkingActive;
		const prevPhase = machine.phase;
		// Freeze the completed turn's length into the loop accumulator so the
		// next turn's counter continues from here instead of resetting.
		prevTurnLen += responseLength;
		responseLength = 0;
		machine = onMessageEnd(machine, now);
		if (wasThinking) ctx.ui.setHiddenThinkingLabel(cfg.labelDone);
		if (machine.phase !== prevPhase) enterPhase(now);
		log.event("message_end", ctx, snap());
		render(ctx, now);
	});

	pi.on("tool_execution_start", (event: ToolExecutionStartEvent, ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		lastCtx = ctx;
		const now = Date.now();
		// A new tool supersedes any pending face reaction.
		faceFrames = null;
		faceUntil = 0;
		faceIsError = false;
		if (machine.phase !== "tool") enterPhase(now);
		machine = onToolStart(machine, event.toolName, (event.args ?? null) as Record<string, unknown> | null);
		log.event("tool_start", ctx, { toolName: event.toolName, toolCallId: event.toolCallId, ...snap() });
		render(ctx, now);
	});

	pi.on("tool_execution_end", (_event: ToolExecutionEndEvent, ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		lastCtx = ctx;
		const now = Date.now();
		const prevPhase = machine.phase;
		machine = onToolEnd(machine);
		if (machine.phase !== prevPhase) lastActivity = now;
		// Robot reaction: 2s happy/sad face once the last parallel tool ends.
		if (cfg.robotAvatar && machine.toolCount === 0) {
			faceFrames = [_event.isError ? ROBOT_FACE_SAD : ROBOT_FACE_HAPPY];
			faceIsError = _event.isError;
			faceUntil = now + ROBOT_FACE_MS;
		}
		log.event("tool_end", ctx, { toolName: _event.toolName, isError: _event.isError, ...snap() });
		render(ctx, now);
	});

	pi.on("agent_end", (_event: AgentEndEvent, ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		// Final summary (like Claude Code's end-of-turn stats): total tokens
		// generated this agent-loop and elapsed wall time. Shown as a
		// transient notification; `tokens` holds the accumulated loop total.
		if (cfg.summary && tokens > 0) {
			const secs = Math.max(0, Math.round((Date.now() - loopStart) / 1000));
			ctx.ui.notify(`${formatTokens(tokens)} tokens · ${secs}s`, "info");
		}
		log.event("agent_end", ctx, snap());
		resetRow(ctx);
	});

	pi.on("model_select", (event: ModelSelectLike, ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		modelId = event.model.id;
		log.event("model_select", ctx, { model: modelId });
	});

	pi.on("thinking_level_select", (event: { level: NonNullable<ExtensionContext["thinkingLevel"]> }, ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		thinkingLevel = event.level;
		log.event("thinking_level", ctx, { level: event.level });
	});

	// Compaction pauses stall detection: resetting lastActivity here means the
	// row never falsely stalls while the context is being compacted.
	pi.on("session_before_compact", (_event: SessionBeforeCompactEvent, ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		lastActivity = Date.now();
		log.event("before_compact", ctx, { reason: _event.reason, willRetry: _event.willRetry });
	});

	pi.on("session_compact", (_event: SessionCompactEvent, ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		lastActivity = Date.now();
		log.event("after_compact", ctx, { reason: _event.reason, willRetry: _event.willRetry });
	});

	pi.on("session_shutdown", (_event: SessionShutdownEvent, ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		log.event("session_shutdown", ctx, { reason: _event.reason });
		stopClock();
	});

	// ── /statusanim command: configure from the TUI ────────────────────────
	// `ctx.ui.select/input/notify` is the official interactive UI surface for
	// extension commands. The menu loops until Done/Esc; the quick-set form
	// `/statusanim <key> <value>` writes one option without dialogs.
	pi.registerCommand("statusanim", {
		description:
			"Configure statusAnim: interactive menu, or set one option: /statusanim <key> <value>",
		getArgumentCompletions: (prefix: string) => {
			const trimmed = prefix.trim();
			const [key] = trimmed.split(/\s+/);
			if (!trimmed.includes(" ")) {
				return CONFIG_OPTIONS.filter((o) => o.key.startsWith(trimmed)).map((o) => ({
					value: o.key,
					label: o.key,
					description: o.label,
				}));
			}
			const opt = CONFIG_OPTIONS.find((o) => o.key === key);
			if (opt?.type === "bool") return [{ value: "on", label: "on" }, { value: "off", label: "off" }];
			return null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const trimmed = args.trim();

			// Quick set: /statusanim <key> <value>.
			if (trimmed) {
				const [key, ...rest] = trimmed.split(/\s+/);
				const opt = CONFIG_OPTIONS.find((o) => o.key === key);
				if (!opt) {
					ctx.ui.notify(`statusAnim: unknown option "${key}"`, "error");
					return;
				}
				const parsed = parseScalar(opt, rest.join(" ").trim());
				if (!parsed.ok) {
					ctx.ui.notify(`statusAnim: ${opt.key}: ${parsed.reason}`, "error");
					return;
				}
				if (updateConfig({ [opt.key]: parsed.value })) {
					ctx.ui.notify(`statusAnim: ${opt.key} = ${String(parsed.value)} — run /reload to apply`, "info");
				} else {
					ctx.ui.notify("statusAnim: could not write settings.json", "error");
				}
				return;
			}

			if (ctx.mode !== "tui") {
				ctx.ui.notify(
					"statusAnim: interactive menu needs TUI mode — use /statusanim <key> <value>",
					"error",
				);
				return;
			}

			// Interactive menu: pick an option, set it, repeat until Done.
			let menuCfg = loadConfig();
			for (;;) {
				const options = [
					...CONFIG_OPTIONS.map((o) => `${o.key} — ${o.label} [${optionValue(menuCfg, o)}]`),
					"Done",
				];
				const choice = await ctx.ui.select("statusAnim — pick an option", options);
				if (!choice || choice === "Done") break;
				const key = choice.slice(0, choice.indexOf(" — "));
				const opt = CONFIG_OPTIONS.find((o) => o.key === key);
				if (!opt) continue;

				const patch: Record<string, unknown> = {};
				if (opt.type === "bool") {
					const pick = await ctx.ui.select(`${opt.key} — ${opt.label}`, ["on", "off"]);
					if (!pick) continue;
					patch[opt.key] = pick === "on";
				} else {
					const raw = await ctx.ui.input(`${opt.key} — ${opt.label}`, optionValue(menuCfg, opt));
					if (!raw) continue;
					const parsed = parseScalar(opt, raw.trim());
					if (!parsed.ok) {
						ctx.ui.notify(`statusAnim: ${opt.key}: ${parsed.reason}`, "error");
						continue;
					}
					patch[opt.key] = parsed.value;
				}

				if (updateConfig(patch)) {
					ctx.ui.notify(`statusAnim: ${opt.key} saved — run /reload to apply`, "info");
					menuCfg = loadConfig(); // refresh values for the next menu round
				} else {
					ctx.ui.notify("statusAnim: could not write settings.json", "error");
				}
			}
		},
	});
}
