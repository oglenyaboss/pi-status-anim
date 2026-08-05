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
import { loadConfig } from "./config.ts";
import { DONE_GLYPH, firstFrameForPhase, framesForPhase, STATIC_GLYPH } from "./frames.ts";
import { GitStatus, gitEggFor } from "./git.ts";
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
const INTERRUPT_KEY = "Ctrl+C";

/** Structural shape of the `model_select` event (not re-exported at package root). */
type ModelSelectLike = { model: { id: string } };

/** Rotate the stall tier word every 3s. */
const STALL_WORD_ROTATE_MS = 3000;

/** Fun facts rotate every 10s after the 60s mark. */
const FACT_ROTATE_MS = 10000;
const FACT_AFTER_MS = 60000;

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
	let phaseStart = 0;
	let prevPhaseStart = 0;
	let lastTickAt = 0;
	let lastActivity = 0;
	let lastTokenAt = 0;
	let responseLength = 0;
	let tokens = 0;
	let displayedTokens = 0;
	let rateSamples: Array<{ at: number; len: number }> = [];
	let liveliness = 0;
	let stalled = false;
	let stallSince = 0;
	let stallWord = "";
	let lastStallWordAt = 0;
	let shimmerPos = 0;
	let shimmerAccum = 0;
	let animMode: "glimmer" | "wave" | "breath" = "glimmer";
	let lastFactAt = 0;
	let factText = "";
	let modelId = "";
	let lastRendered = "";
	let lastFrames = "";

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

	/** Reset per-phase timers on a phase entry. */
	const enterPhase = (now: number): void => {
		phaseStart = now;
		shimmerPos = 0;
		shimmerAccum = 0;
		lastActivity = now;
	};

	const pickTierWord = (tier: number): string =>
		STALL_TIERS[tier][Math.floor(Math.random() * STALL_TIERS[tier].length)];

	const formatSecs = (since: number, now: number): string =>
		`${Math.max(0, Math.floor((now - since) / 1000))}s`;

	const tokenRatePerSec = (now: number): number => {
		rateSamples = rateSamples.filter((s) => now - s.at <= 1200);
		if (rateSamples.length < 2) return 0;
		const first = rateSamples[0];
		const last = rateSamples[rateSamples.length - 1];
		const dt = (last.at - first.at) / 1000;
		if (dt < 0.25) return 0;
		return Math.max(0, Math.round((last.len - first.len) / 4 / dt));
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

	const currentFrames = (ctx: ExtensionContext, now: number): string[] => {
		const theme = ctx.ui.theme;
		const mode = theme.getColorMode();
		const accent = tokenRgb(theme, "accent");
		if (stalled) {
			const staticGlyph = cfg.reducedMotion
				? STATIC_GLYPH
				: firstFrameForPhase(machine.phase, cfg.phaseGlyphs);
			return [stallColorAt(theme, now) + staticGlyph];
		}
		if (machine.phase === "done") return [rgbAnsi(accent, mode) + DONE_GLYPH];
		if (cfg.reducedMotion) return [rgbAnsi(accent, mode) + STATIC_GLYPH];
		return framesForPhase(machine.phase, cfg.phaseGlyphs).map((f) => rgbAnsi(accent, mode) + f);
	};

	const setFrames = (ctx: ExtensionContext, now: number): void => {
		const frames = currentFrames(ctx, now);
		const key = frames.join("\u0000");
		if (key === lastFrames) return;
		lastFrames = key;
		ctx.ui.setWorkingIndicator({ frames });
	};

	// ── Row composition ───────────────────────────────────────────────────

	const markerFor = (theme: ExtensionContext["ui"]["theme"], now: number): SuffixPart | null => {
		if (machine.thinkingActive) {
			const text = `(thinking${cfg.effortSuffix ? " " + cfg.effortSuffix : ""}…)`;
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

		// Timer.
		if (cfg.showTimer && now - phaseStart >= cfg.timerAfterMs) {
			const text = formatSecs(phaseStart, now);
			parts.push({ key: "timer", plain: text, rendered: fg(theme, "dim", text) });
		}

		// Token counter (full-snapshot recompute; smooth odometer).
		if (cfg.tokenCounter && responseLength > 0 && now - phaseStart >= cfg.tokenAfterMs) {
			let text = `↓ ${formatTokens(displayedTokens)}`;
			if (cfg.tokenRate) {
				const rate = tokenRatePerSec(now);
				if (rate > 0) text += ` · ${rate}/s`;
			}
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
			return { plain, rendered: glimmer(theme, plain, shimmerPos, animLiveliness) };
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
		const glyph = currentFrames(ctx, now)[0] ?? "";
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
		} else if (!stalledNow && stalled) {
			stalled = false;
			stallSince = 0;
			stallWord = "";
		} else if (stalled && cfg.stallTiers && now - lastStallWordAt >= STALL_WORD_ROTATE_MS) {
			stallWord = pickTierWord(tierIndex(now - stallSince));
			lastStallWordAt = now;
		}

		// Token odometer.
		if (cfg.tokenCounter && tokens > displayedTokens) {
			displayedTokens = stepOdometer(displayedTokens, tokens);
		}

		// Glimmer sweep position.
		if (!cfg.reducedMotion && animMode === "glimmer" && !stalled && machine.phase !== "done") {
			const base = machine.phase === "requesting" ? 50 : 200;
			const eff = machine.phase === "requesting" ? 1 : liveliness;
			if (eff > 0.05) {
				shimmerAccum += dt * (0.3 + 0.7 * eff);
				if (shimmerAccum >= base) {
					shimmerAccum = 0;
					const len = [...`${machine.verb}…`].length;
					if (len > 0) {
						shimmerPos =
							(((shimmerPos + (machine.phase === "requesting" ? 1 : -1)) % len) + len) % len;
					}
				}
			}
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
		tokens = 0;
		displayedTokens = 0;
		rateSamples = [];
		liveliness = 0;
		factText = "";
		lastRendered = "";
		lastFrames = "";
		ctx.ui.setWorkingMessage();
		ctx.ui.setWorkingIndicator();
	};

	// ── Events ────────────────────────────────────────────────────────────

	pi.on("agent_start", (_event: AgentStartEvent, ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		lastCtx = ctx;
		modelId = ctx.model?.id ?? "";
		loopSeq += 1;
		loopStart = Date.now();
		lastActivity = loopStart;
		lastTokenAt = 0;
		responseLength = 0;
		tokens = 0;
		displayedTokens = 0;
		rateSamples = [];
		liveliness = 0;
		factText = "";
		animMode = Math.random() < cfg.animChance ? (Math.random() < 0.5 ? "wave" : "breath") : "glimmer";
		machine = startLoop(rollRequestingVerb(ctx));
		enterPhase(loopStart);
		rowActive = true;
		startClock();
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
			machine = startLoop(rollRequestingVerb(ctx));
			enterPhase(now);
			rowActive = true;
			startClock();
		}

		// Full content snapshot recompute — never accumulate (bug 9 fix).
		let len = 0;
		let lastBlock: "thinking" | "text" | null = null;
		for (const block of msg.content) {
			if (block.type === "thinking") {
				len += block.thinking.length;
				lastBlock = "thinking";
			} else if (block.type === "text") {
				len += block.text.length;
				lastBlock = "text";
			}
		}
		responseLength = len;
		tokens = Math.round(len / 4);
		rateSamples.push({ at: now, len });
		rateSamples = rateSamples.filter((s) => now - s.at <= 1200);
		lastTokenAt = now;
		lastActivity = now;

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
		machine = onMessageEnd(machine, now);
		if (wasThinking) ctx.ui.setHiddenThinkingLabel(cfg.labelDone);
		if (machine.phase !== prevPhase) enterPhase(now);
		render(ctx, now);
	});

	pi.on("tool_execution_start", (event: ToolExecutionStartEvent, ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		lastCtx = ctx;
		const now = Date.now();
		if (machine.phase !== "tool") {
			// Save the underlying phase's timer so the revert can restore it.
			prevPhaseStart = phaseStart;
			enterPhase(now);
		}
		machine = onToolStart(machine, event.toolName, (event.args ?? null) as Record<string, unknown> | null);
		render(ctx, now);
	});

	pi.on("tool_execution_end", (_event: ToolExecutionEndEvent, ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		lastCtx = ctx;
		const now = Date.now();
		const prevPhase = machine.phase;
		machine = onToolEnd(machine);
		if (machine.phase !== prevPhase) {
			// Revert to the underlying phase with its timer restored.
			phaseStart = prevPhaseStart;
			lastActivity = now;
		}
		render(ctx, now);
	});

	pi.on("agent_end", (_event: AgentEndEvent, ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		resetRow(ctx);
	});

	pi.on("model_select", (event: ModelSelectLike, ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		modelId = event.model.id;
	});

	// Compaction pauses stall detection: resetting lastActivity here means the
	// row never falsely stalls while the context is being compacted.
	pi.on("session_before_compact", (_event: SessionBeforeCompactEvent, ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		lastActivity = Date.now();
	});

	pi.on("session_compact", (_event: SessionCompactEvent, ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		lastActivity = Date.now();
	});

	pi.on("session_shutdown", (_event: SessionShutdownEvent, ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		stopClock();
	});
}
