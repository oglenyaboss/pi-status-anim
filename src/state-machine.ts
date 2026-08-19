/**
 * Phase FSM: events → phase transitions.
 *
 * `idle → requesting → thinking → tool → responding → done`
 *
 * Rules enforced here:
 * - The verb changes only on phase entry; tools within a phase change glyph +
 *   suffix only (bug 1 fix).
 * - `tool_execution_end` reverts to the phase that was active before the tool;
 *   the verb is restored, not re-rolled.
 * - `turn_start` / `turn_end` do not change the verb (the verb is scoped to
 *   the agent-loop, not the turn).
 */

export type Phase = "idle" | "requesting" | "thinking" | "responding" | "tool" | "done";

export type VerbSource = "generic" | "thinking" | "responding" | "egg";

export interface MachineState {
	phase: Phase;
	/** Phase that was active before the current tool (for revert). */
	prevPhase: Phase;
	verb: string;
	verbSource: VerbSource;
	/** Thinking started this loop and has not finished yet. */
	thinkingActive: boolean;
	/** When thinking first started this agent-loop; 0 = none yet. */
	thinkingStart: number;
	/** When thinking finished (0 = still active / never started). */
	thinkingEndAt: number;
	/** Number of active tool executions (parallel tools are possible). */
	toolCount: number;
	/** Most recently started tool. */
	toolName: string;
	toolArgs: Record<string, unknown> | null;
}

export interface VerbPick {
	verb: string;
	source: VerbSource;
}

export function initialState(): MachineState {
	return {
		phase: "idle",
		prevPhase: "idle",
		verb: "",
		verbSource: "generic",
		thinkingActive: false,
		thinkingStart: 0,
		thinkingEndAt: 0,
		toolCount: 0,
		toolName: "",
		toolArgs: null,
	};
}

/** `agent_start`: enter `requesting` with the seeded verb. */
export function startLoop(pick: VerbPick): MachineState {
	const next = initialState();
	next.phase = "requesting";
	next.verb = pick.verb;
	next.verbSource = pick.source;
	return next;
}

/** `message_update` with an assistant message whose last block is thinking. */
export function onThinkingBlock(state: MachineState, pick: VerbPick, now: number): MachineState {
	const next: MachineState = { ...state };
	if (!next.thinkingActive) {
		next.thinkingActive = true;
		next.thinkingStart = now;
	}
	// A tool owns the row; the verb and phase stay put.
	if (next.toolCount > 0) return next;
	if (next.phase !== "thinking") {
		next.phase = "thinking";
		next.verb = pick.verb;
		next.verbSource = pick.source;
	}
	return next;
}

/** `message_update` with an assistant message whose last block is text. */
export function onTextBlock(state: MachineState, pick: VerbPick, now: number): MachineState {
	const next: MachineState = { ...state };
	if (next.thinkingActive) {
		next.thinkingActive = false;
		next.thinkingEndAt = now;
	}
	if (next.toolCount > 0) return next;
	if (next.phase !== "responding") {
		next.phase = "responding";
		next.verb = pick.verb;
		next.verbSource = pick.source;
	}
	return next;
}

/** `tool_execution_start`: enter `tool`, inherit the verb. */
export function onToolStart(
	state: MachineState,
	name: string,
	args: Record<string, unknown> | null,
): MachineState {
	const next: MachineState = { ...state };
	if (next.phase !== "tool") next.prevPhase = next.phase;
	next.phase = "tool";
	next.toolCount += 1;
	next.toolName = name;
	next.toolArgs = args;
	return next;
}

/** `tool_execution_end`: drop the tool; revert to the previous phase.
 * `done`/`idle` are terminal — after a tool the agent starts a new turn (a
 * new LLM response), so revert to `requesting` rather than a dead state. */
export function onToolEnd(state: MachineState): MachineState {
	const next: MachineState = { ...state };
	next.toolCount = Math.max(0, next.toolCount - 1);
	if (next.toolCount === 0) {
		next.phase = next.prevPhase === "done" || next.prevPhase === "idle" ? "requesting" : next.prevPhase;
		next.prevPhase = "idle";
		next.toolName = "";
		next.toolArgs = null;
	}
	return next;
}

/** `message_end` (assistant): finalize thinking; the loop settles into `done`. */
export function onMessageEnd(state: MachineState, now: number): MachineState {
	const next: MachineState = { ...state };
	if (next.thinkingActive) {
		next.thinkingActive = false;
		next.thinkingEndAt = now;
	}
	next.phase = "done";
	next.toolCount = 0;
	next.toolName = "";
	next.toolArgs = null;
	return next;
}
