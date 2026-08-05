# pi-status-anim

A pi extension that replaces the default TUI status row during streaming with
a richer, animated status — phased verbs, glyph animation, and playful context
— held to a high quality bar (smooth animation, no flicker, correct phase
transitions). The scope is the whole status row, not just thinking blocks:
verbs, glyph, tokens, timer, git/model/time easter eggs, and stall feedback
all live here.

## Language

### Time units (borrowed from pi; reused with precise meaning)

**Agent-loop**:
One user turn-of-work: everything between `agent_start` and `agent_end`.
Contains one or more **turns**.
_Avoid_: session, run, request.

**Turn**:
One iteration of the agent loop — a single LLM response plus the tool calls
executed inside it. `turn_start` … `turn_end`. A multi-step user request is
several turns inside one agent-loop.
_Avoid_: step, round, iteration.

### The working row

**Working row**:
The single status line pi renders while the agent is streaming. Internally pi's
`WorkingStatusIndicator`. Only one status indicator is active at a time
(`working` | `compaction` | `retry` | `branchSummary`); this extension only ever
owns the row while `kind === "working"`.
_Avoid_: spinner, loader, status bar.

### Anatomy of the row (this extension's model)

**Glyph**:
The animated symbol at the start of the row (`·✢✳✶✻✽` for thinking/text,
`⠋⠙⠹` for tools). Chosen by **phase**, not by individual tool.
_Avoid_: spinner char, frame.

**Verb**:
The leading word of the row (`Reticulating…`, `Pondering…`). Stable for the
duration of a **phase**; does not change per tool call. Easter-egg verbs
(git/model/time) seed the `requesting` phase.
_Avoid_: message, label, status text.

**Suffix**:
The parenthesised, dynamic tail of the row: `(thought for 4s)`, `(↓ 1.2k tokens)`,
`(running bash)`, `(3s)`. This is where live data lives; changing it is not a
"jump" because the verb stays put.
_Avoid_: status, meta.

**Phase**:
A coarse state of an agent-loop the row reflects: `idle → requesting →
thinking → tool → responding → done`. Verbs are picked on phase entry; tools
within a phase change glyph + suffix, not verb.
_Avoid_: state, mode.

**Stall**:
A condition where there is no visible progress (no fresh tokens, no active tool).
Detection model and visual response are a separate decision (see spec).
_Avoid_: hang, stuck, frozen.
