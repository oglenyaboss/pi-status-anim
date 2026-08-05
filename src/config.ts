/**
 * Config loading + validation for pi-status-anim.
 *
 * Read once at extension load from `~/.pi/agent/settings.json` (or
 * `$PI_CODING_AGENT_DIR/agent/settings.json`) under the `statusAnim` key.
 * `/reload` recreates the extension and re-reads the config; there is no
 * hot-reload of config.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface StatusAnimConfig {
	enabled: boolean;
	/** Extra verbs appended to the default requesting verb pool. */
	words: string[];
	/** Text-animation clock period in ms. */
	intervalMs: number;
	showTimer: boolean;
	/** Show the elapsed timer suffix after this many ms in the phase. */
	timerAfterMs: number;
	tokenCounter: boolean;
	/** Show the token suffix after this many ms in the phase (flicker guard). */
	tokenAfterMs: number;
	/** Append the tokens/sec rate to the token suffix. */
	tokenRate: boolean;
	/** Wording for the thinking marker, e.g. "with high effort". */
	effortSuffix: string;
	/** No-token/no-tool threshold before the row is considered stalled. */
	stallAfterMs: number;
	stallTiers: boolean;
	modelEggs: boolean;
	timeEggs: boolean;
	gitStatus: boolean;
	funFacts: boolean;
	anxietyGradient: boolean;
	reducedMotion: boolean;
	/** Detailed tool suffix, e.g. "(grep · 247 files)" when args carry a count. */
	toolDetail: boolean;
	/** "(+ queued)" hint while `ctx.hasPendingMessages()`. */
	queueHint: boolean;
	/** Per-phase glyph sets; off = one set for all non-tool phases. */
	phaseGlyphs: boolean;
	/** Probability of wave/breath replacing the glimmer per agent-loop. */
	animChance: number;
	/** Wave/breath start only after this many ms of the agent-loop. */
	animAfterMs: number;
	/** Hidden-thinking label while thinking streams. */
	labelActive: string;
	/** Hidden-thinking label after thinking finishes. */
	labelDone: string;
}

const DEFAULTS: StatusAnimConfig = {
	enabled: true,
	words: [],
	intervalMs: 50,
	showTimer: true,
	timerAfterMs: 1000,
	tokenCounter: true,
	tokenAfterMs: 3000,
	tokenRate: true,
	effortSuffix: "with high effort",
	stallAfterMs: 3000,
	stallTiers: true,
	modelEggs: true,
	timeEggs: true,
	gitStatus: true,
	funFacts: true,
	anxietyGradient: true,
	reducedMotion: false,
	toolDetail: true,
	queueHint: true,
	phaseGlyphs: true,
	animChance: 0.25,
	animAfterMs: 1500,
	labelActive: "∴ Thinking…",
	labelDone: "∴ Thinking",
};

function bool(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function str(value: unknown, fallback: string): string {
	return typeof value === "string" ? value : fallback;
}

function num(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, value));
}

function strList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string");
}

function expandTilde(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

function settingsPath(): string {
	const envDir = process.env.PI_CODING_AGENT_DIR;
	const base = envDir ? expandTilde(envDir) : join(homedir(), ".pi", "agent");
	return join(base, "settings.json");
}

function readSettings(): Record<string, unknown> | null {
	try {
		const raw = readFileSync(settingsPath(), "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return null;
		return parsed as Record<string, unknown>;
	} catch {
		return null; // missing or unreadable settings file -> defaults
	}
}

export function loadConfig(): StatusAnimConfig {
	const raw = readSettings();
	const section = raw?.["statusAnim"];
	const s = typeof section === "object" && section !== null ? (section as Record<string, unknown>) : {};
	return {
		enabled: bool(s.enabled, DEFAULTS.enabled),
		words: strList(s.words),
		intervalMs: num(s.intervalMs, DEFAULTS.intervalMs, 20, 1000),
		showTimer: bool(s.showTimer, DEFAULTS.showTimer),
		timerAfterMs: num(s.timerAfterMs, DEFAULTS.timerAfterMs, 0, 60000),
		tokenCounter: bool(s.tokenCounter, DEFAULTS.tokenCounter),
		tokenAfterMs: num(s.tokenAfterMs, DEFAULTS.tokenAfterMs, 0, 60000),
		tokenRate: bool(s.tokenRate, DEFAULTS.tokenRate),
		effortSuffix: str(s.effortSuffix, DEFAULTS.effortSuffix),
		stallAfterMs: num(s.stallAfterMs, DEFAULTS.stallAfterMs, 0, 120000),
		stallTiers: bool(s.stallTiers, DEFAULTS.stallTiers),
		modelEggs: bool(s.modelEggs, DEFAULTS.modelEggs),
		timeEggs: bool(s.timeEggs, DEFAULTS.timeEggs),
		gitStatus: bool(s.gitStatus, DEFAULTS.gitStatus),
		funFacts: bool(s.funFacts, DEFAULTS.funFacts),
		anxietyGradient: bool(s.anxietyGradient, DEFAULTS.anxietyGradient),
		reducedMotion: bool(s.reducedMotion, DEFAULTS.reducedMotion),
		toolDetail: bool(s.toolDetail, DEFAULTS.toolDetail),
		queueHint: bool(s.queueHint, DEFAULTS.queueHint),
		phaseGlyphs: bool(s.phaseGlyphs, DEFAULTS.phaseGlyphs),
		animChance: num(s.animChance, DEFAULTS.animChance, 0, 1),
		animAfterMs: num(s.animAfterMs, DEFAULTS.animAfterMs, 0, 60000),
		labelActive: str(s.labelActive, DEFAULTS.labelActive),
		labelDone: str(s.labelDone, DEFAULTS.labelDone),
	};
}
