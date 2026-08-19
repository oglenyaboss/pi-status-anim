# SPEC — pi-status-anim

**Status:** ready for implementation
**Audience:** implementing subagent
**Glossary:** see [`CONTEXT.md`](./CONTEXT.md) for ubiquitous language (Agent-loop, Turn, Phase, Verb, Glyph, Suffix, Stall, Working row). Use those terms verbatim.

---

## 1. Identity & philosophy

`pi-status-anim` is a pi extension that replaces the default TUI status row during
streaming with a richer, animated status. It is **not** a clone of any other tool:
the quality bar (smooth animation, no flicker, correct phase transitions, edge cases)
is the reference point, while the personality (verbs, easter eggs, playful animations)
is our own.

Design rules, in priority order:
1. **No flicker, no layout jumps.** The verb is stable within a phase; only glyph + suffix move. All updates are predictable (animation frames), not reactive chaos.
2. **Everything carries meaning.** Animation presence/speed/color reflects real state (token flow, phase, stall). No decoration for decoration's sake.
3. **Playful, not chaotic.** Rich features, but every one is a toggle and defaults to tasteful.
4. **Minimal surface.** Official pi extension API only. No runtime deps (types are `import type` → erased at runtime).

## 2. Operating environment (facts from pi)

- Extension runs in all modes, but `setWorkingMessage`/`setWorkingIndicator`/`setHiddenThinkingLabel` are **no-op outside TUI** (`rpc`/`json`/`print`). → guard everything on `ctx.mode === "tui"`.
- pi renders exactly **one** status indicator at a time: `working` | `compaction` | `retry` | `branchSummary`. This extension only ever owns the row while the active indicator is `working`. Calls to `setWorkingMessage` are silently ignored otherwise (safe).
- pi shows the working row on `agent_start`, hides on `agent_end`. The extension hooks the same lifecycle.
- `Loader.setMessage(text)` → `setText + requestRender`, batched by TUI. ~20 updates/sec is safe **as long as content is predictable** (same string, only color changes) — that is animation, not flicker.
- Terminal width is **not** in `ctx`; use `process.stdout.columns` with a non-TTY guard and fallback `80`.
- `pi.exec(cmd, args, opts)` is async, returns `{stdout, stderr, code}` — use instead of blocking `execSync`.
- `ctx.model` is always the current model (fresh); `ctx.thinkingLevel` is the current thinking level.

## 3. Repository structure

```
pi-status-anim/
├── package.json
├── README.md            # English, primary
├── README_RU.md         # Russian
├── LICENSE              # MIT
└── src/
    ├── index.ts         # entry: factory, event wiring, lifecycle
    ├── state-machine.ts # Phase FSM, events → phase transitions
    ├── render.ts        # composeRow(phase, anim, suffix, width) → string, width-gating
    ├── verbs.ts         # verb lists + easter eggs (model/time/git)
    ├── frames.ts        # glyph frame sets per phase
    ├── stall.ts         # stall detection + liveliness + fade math
    ├── anim.ts          # text animations: glimmer, wave, breath
    ├── git.ts           # async git info with 30s cache
    ├── config.ts        # load + validate config from settings.json
    └── theme.ts         # color helpers via theme tokens; RGB interpolation helpers
```

`package.json` essentials:
```json
{
  "name": "pi-status-anim",
  "version": "0.1.0",
  "type": "module",
  "pi": { "extensions": ["./src/index.ts"] },
  "devDependencies": { "@earendil-works/pi-coding-agent": "*" },
  "license": "MIT"
}
```
- `@earendil-works/pi-coding-agent` is **devDependencies only** — all imports are `import type` (erased at runtime). No `dependencies`, no `peerDependencies` needed for runtime.
- Entry: default-export factory `(pi: ExtensionAPI) => void`.
- **No attribution/links to any other project's repository** anywhere in the published tree (code comments, README, docs). Internal references to "the reference" stay verbal/in this spec only.

## 4. Phase model (FSM)

The row reflects a coarse phase. The **verb changes only on phase transitions**; tools within a phase change glyph + suffix only.

| Phase | Entered on | Verb source | Glyph set | Glimmer |
|---|---|---|---|---|
| `idle` | `agent_end` | — | none | none |
| `requesting` | `agent_start` (before first assistant token) | start egg (git/model/time) or random verb | dots set | fast, → |
| `thinking` | `message_update`: assistant, last block `type:"thinking"` with content | thinking-ish verb (or keep requesting verb) | star set `·✢✳✶✻✽` | slow, ← |
| `responding` | `message_update`: assistant, last block `type:"text"` with content | text-ish verb (`Polishing the answer` etc.) | star set | slow, ← |
| `tool` | `tool_execution_start` | **inherited** (do not change) | tool frames `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` | slow, ← |

Transition rules:
- Verb is chosen **once per phase entry** and held until the next phase entry.
- `tool_execution_end` → revert to the phase that was active before the tool (`thinking`/`responding`/`requesting`). Verb is restored, not re-rolled.
- `turn_start`/`turn_end` do **not** change the verb (verb is scoped to the agent-loop, not the turn).
- On phase entry, reset per-phase timers (`phaseStart`), token baseline, glimmer phase.
- `done` is implicit at `message_end`/`agent_end`.

**`robotAvatar` (config) replaces the glyph sets.** All abstract sets above are
swapped for one 5-cell robot face per state: `requesting` blinks (`ROBOT_WAIT_`),
`thinking` rolls its eyes up with a slow brain pulse (`ROBOT_THINK_`),
`responding` smiles and blinks (`ROBOT_RESPOND_`), `tool` works with a fast
brain pulse (`ROBOT_TOOL_`), `done` is pleased (`ROBOT_DONE_`). Stalled: the
robot falls asleep (breathing `ROBOT_SLEEP_`, fading red). Right after the last
parallel tool ends, a 2s reaction overrides the phase face: `[◕‿◕]` on success,
`[◉⌓◉]` in `error` color on failure; a new `tool_execution_start` cancels it.
Each robot set carries its own Loader `intervalMs` (thinking slow, tools fast);
under `reducedMotion` a static `[◉_◉]` is shown.

## 5. Row rendering & width-gating

`composeRow(state, columns) → string` is a pure function:
```
<glyph> <verb-with-anim><optional suffix parts>
```
Suffix parts, in **priority order** (highest first), progressively dropped when they don't fit `availableSpace = columns - verbWidth - glyphWidth - 5`:
1. **phase/thought marker** — `(thought for Ns)` after thinking ends; `(thinking…)` while thinking (shimmered). Highest priority.
2. **timer** — `Ns` after `timerAfterMs`.
3. **tokens** — `↓ 1.2k` after `tokenAfterMs`; `· 42/s` rate appended if `tokenRate`.
4. **tool detail** — `(running bash)` while a tool is active; `(grep · 247 files)` if `toolDetail` and args carry a count.
5. **queue hint** — `(+ queued)` if `ctx.hasPendingMessages()` and `queueHint`. (The API exposes only a boolean, not a count — no number is shown.)

The verb and the phase marker (1) are never dropped. Anything below the cutoff is hidden entirely (no partial). This prevents line wrap → flicker.

**Restore the interrupt hint.** When the extension owns the row, append ` (<interrupt key> to interrupt)` to the suffix at lowest priority only when nothing else is shown (bug 6 fix). pi's `app.interrupt` defaults to **`escape`** (verified in `dist/core/keybindings.js`); hardcode `escape` — the keybinding registry is not exposed to extensions.

## 6. Stall model & liveliness

Two coupled signals derived from token flow:

**liveliness ∈ [0,1]** — continuous "is generation flowing" indicator:
- Compute `responseLength` (see §8) and track its delta over a rolling window.
- `liveliness` rises toward 1 while tokens flow, decays toward 0 when flow stops.
- Drives: glimmer/wave animation **speed & presence** (lively when high, dims/slows as it falls).

**stall** — discrete threshold:
- `stalled = (no new tokens for > stallAfterMs) && (no active tool)`.
- Active tool = `tool_execution_start` without matching `tool_execution_end` (closes bug 3; **do not** require `tool_execution_update`).
- `stallAfterMs` default **3000** (config).
- On stall: glyph **fades to red** over ~2s (`stalledIntensity 0→1`, exponential approach like the reference), glimmer **goes dark**, and a **tier word** appears in the suffix (bug 3/4 fix). Verb unchanged.
- Tier word rotates every 3s through 3 tiers (worried → desperate → existential) by elapsed stall time.

Color: base points from theme tokens (`accent`/`warning`/`error`); interpolate to `error` for the fade. Do not hardcode raw RGB constants — derive endpoints from the active theme (bug fix §11.5).

During `session_before_compact` … `session_compact`: **pause** stall detection (reset `lastActivity`) so we never falsely stall during compaction.

## 7. Text animations

Layered, all disabled under `reducedMotion` (static `●` glyph + plain text then):

1. **Glimmer (default, always on).** A soft 3-character light spot (`idx-1, idx, idx+1` in `shimmerColor`, rest in verb color) sweeps along the verb.
   - `requesting` phase: left→right, fast (50ms).
   - other phases: right→left, slow (200ms).
   - Goes dark when `stalled` or `liveliness ≈ 0`.
2. **Wave / Breath (probabilistic, overlay).** On each `agent_start`, with probability `animChance` (default `0.25`), pick one randomly to replace glimmer for that agent-loop:
   - **Wave:** brightness of each glyph position = `base + amp·sin(pos·k + t·speed)` — a traveling light wave along the verb.
   - **Breath:** the whole verb's brightness pulses as one sine (calmer).
   - Only active after `animAfterMs` (default `1500`) so short replies don't animate.
3. **Thinking shimmer (suffix only).** The `(thinking…)` suffix text pulses color via sine, period 2s, starting after 3s of thinking. Endpoints from theme.

**Robot avatar.** With `robotAvatar` (default on), the per-phase glyph sets are
replaced by a 5-cell animated robot face per state (see §4). All frames of all
sets are exactly 5 cells wide (enforced by selfcheck), so the row never jumps
when a set swaps. The robot is a character, not a spinner: blinking, thinking
and working reads are distinct, and the stall face (asleep) and tool-result
reactions (happy/sad, 2s) carry real state.

Animation clock: a single extension interval at ~50ms drives all text animation, calling `setWorkingMessage` each tick with the recomposed string. The glyph is animated by pi's own `Loader` interval (pass `frames`, leave `intervalMs` default unless configured).

## 8. Token counter (fixes bug 9)

**Correct accounting:** `message_update` carries the **full** content snapshot, not a delta. Recompute the current message total each update — do **not** accumulate within a message.

```
responseLength = sum over content blocks of (block.type === "thinking" ? block.thinking.length
                  : block.type === "text" ? block.text.length : 0)
```
- **Scoped to the agent-loop (§5):** `prevTurnLen` accumulates the length of
  each completed turn at `message_end`; `tokens = round((prevTurnLen +
  responseLength) / 4)`. The counter is monotonic across turns within one
  agent-loop — it does not reset to 0 between turns and does not disappear
  during inter-turn gaps (tools, `done`).
- Shown after `tokenAfterMs` (default `3000`, bug-flicker fix), gated on
  `tokens > 0` (not `responseLength`) so it persists through inter-turn gaps.
- **Smooth odometer:** `displayedTokens` eases toward `tokens` when rising
  (gap < 70 → +3; < 200 → +ceil(gap·0.15); else +50), snaps down instantly
  when the target drops (a new message shorter than the accumulated total).
- Rate `tok/s` (if `tokenRate`): delta of the loop total over the last ~1s
  window, `÷4`.
- **Final summary** (`summary` config, default on): at `agent_end`, fire
  `ctx.ui.notify("<tokens> tokens · <Ns>", "info")` with the loop total and
  wall time — a transient end-of-turn stat line like Claude Code's.

## 9. Easter eggs (seed the `requesting` verb)

Same probabilistic seeding as today, but only at `requesting` phase entry (not re-rolled mid-loop):
- **git** (`gitStatus`): `Pondering N uncommitted files` / `Reticulating on <branch>`. Async via `pi.exec`, 30s cache.
- **model** (`modelEggs`): substring match on current model id (from `ctx.model`, refreshed on `model_select`).
- **time** (`timeEggs`): time-of-day / day-of-week quip.
- **fun facts** (`funFacts`): appear in suffix after 60s of thinking.
- **anxiety gradient** (`anxietyGradient`): verb color warms gray→amber→orange after 60s.

## 10. Config schema (`settings.json` → `statusAnim`)

```jsonc
{
  "statusAnim": {
    "enabled": true,
    "words": [],              // extra verbs appended to defaults
    "intervalMs": 50,         // text-animation clock
    "showTimer": true,
    "timerAfterMs": 1000,
    "tokenCounter": true,
    "tokenAfterMs": 3000,     // when tokens appear (was 1000; bug-flicker fix)
    "tokenRate": true,        // show tok/s
    "effortSuffix": "with high effort",
    "stallAfterMs": 3000,
    "stallTiers": true,
    "modelEggs": true,
    "timeEggs": true,
    "gitStatus": true,
    "funFacts": true,
    "anxietyGradient": true,
    "reducedMotion": false,
    "robotAvatar": true,       // animated robot face across all phases
    "toolDetail": true,       // detailed tool suffix
    "queueHint": true,        // (+ queued) — bool API, no count
    "phaseGlyphs": true,      // per-phase glyph sets
    "animChance": 0.25,       // probability of wave/breath per agent-loop
    "animAfterMs": 1500,
    "labelActive": "∴ Thinking…",
    "labelDone": "∴ Thinking"
  }
}
```
- Config is loaded **once** at extension load. `/reload` recreates the extension and re-reads config. No hot-reload of config (out of scope).
- **TUI configuration** (official extension API: `pi.registerCommand` + `ctx.ui.select/input/notify`): the `/statusanim` command opens an interactive menu of every option (loop until Done/Esc) or sets one option directly (`/statusanim <key> <value>`, validated per type/range, Tab-completed). It writes through `updateConfig()` in config.ts — a merge into the `statusAnim` section of settings.json that preserves every other key — and tells the user to run `/reload`.
- `mode: "append"|"replace"` from the old config is **removed** — the FSM supersedes it. `words` always augments defaults.

## 11. pi events mapping

| Event | Action |
|---|---|
| `agent_start` | enter `requesting`; pick start egg/verb; start animation clock |
| `message_update` (assistant) | classify last block → set phase `thinking`/`responding`; update `responseLength`; feed liveliness |
| `tool_execution_start` | enter `tool` (inherit verb); set tool suffix; mark active tool |
| `tool_execution_end` | clear active tool; revert to prior phase |
| `message_end` (assistant) | finalize thought-for-Ns; enter `done` |
| `agent_end` | stop clock; clear timers; hide row |
| `model_select` | refresh current model for eggs |
| `session_before_compact` / `session_compact` | pause stall detection |
| `session_shutdown` | clear all timers |

Guard: every handler early-returns if `ctx.mode !== "tui"`.

## 12. Edge cases & technical fixes

1. **Mode guard** — no work outside TUI (§2).
2. **Model freshness** — use `ctx.model` in handlers + listen `model_select`; never cache model from settings file.
3. **Async git** — `pi.exec` instead of `execSync`; 30s cache; tolerate non-repo (return null).
4. **Theme tokens** — discrete colors via `ctx.ui.theme.fg(token, text)`; RGB interpolation endpoints (shimmer, anxiety, stall-fade) read from the theme, not hardcoded.
5. **reducedMotion** — static glyph + plain text, no clocks beyond the stall timer.
6. **Reload** — no special handling; `/reload` recreates the extension.
7. **Non-TTY** — `process.stdout.columns` undefined → fallback 80; consider disabling animation if not a TTY.

## 13. Bug ledger (all must be closed)

| # | Bug | Fix |
|---|---|---|
| 1 | Verb jumps on every tool start/end | FSM: verb changes only on phase entry (§4) |
| 2 | Flicker from `setWorkingMessage` per token | Text changes are animation-driven & predictable (§7); per-token handler only updates internal `responseLength`, not the message |
| 3 | False stall on long tools | Active-tool suppresses stall (§6) |
| 4 | Stall model mismatch | 3s threshold + fade + tiers (§6) |
| 5 | No width-gating | Progressive suffix drop (§5) |
| 6 | Lost interrupt hint | Restore hint in suffix (§5) |
| 7 | Model read once | `ctx.model` + `model_select` (§12.2) |
| 8 | Blocking `execSync` git | `pi.exec` async (§12.3) |
| 9 | Token counter shows ~100k (cumulative bug) | Recompute total per update (§8) |

## 14. Publication

- **Host:** GitHub. Install via `pi install <github-url>` (git).
- **License:** MIT.
- **README:** English primary (`README.md`) + `README_RU.md`.
- **No links/attribution to any other project's repository** in the published tree.

## 15. Acceptance criteria

Implementer must demonstrate (not just claim):
1. **No flicker** during a multi-tool turn: verb stable within a phase, layout never wraps.
2. **Token counter realistic**: a known ~4k-char thinking block shows ~1k tokens, not 100k+.
3. **No false stall**: a 20s `bash` with no output keeps the normal (non-stall) row.
4. **Stall works**: idle network for 4s → glyph begins fading red, tier word appears by 5s.
5. **Width-gating**: at `COLUMNS=40`, suffix parts drop cleanly; at `COLUMNS=120`, all shown.
6. **Animations**: glimmer visible by default; with `animChance=1`, wave/breath appears after `animAfterMs`; all off under `reducedMotion`.
7. **Mode guard**: in `pi -p` (print mode) the extension does no timer work (verify via logging or no-op behavior).
8. **Compaction pause**: triggering `/compact` mid-stream does not produce a false stall row.
9. **`pi install <url>`** from a clean clone loads the extension with zero runtime dependencies.
10. **Liveliness**: visibly faster animation while tokens stream vs. when flow pauses (pre-stall).
