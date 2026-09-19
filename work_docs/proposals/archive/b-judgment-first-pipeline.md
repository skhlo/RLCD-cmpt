# Direction B: judgment-first pipeline

## The direction

Keep DeepSeek for everything that produces text and move every selective decision
onto calibrated TypeSafe judgments that code composes. The central move is grading
at write time: the `relevance` label that the whole retention system rests on is
today assigned by the observer model to its own output, inside the same generated
structured payload, and it is the primary semantic key for three separate
consumers. Replace it with a Score computed per observation at the moment its
evidence is freshest, store the raw judgment vector alongside the observation, and
let code own every threshold, floor and ordering that follows. This optimizes for
determinism, calibration, and moving judgment earlier where it is cheap and
parallel. Its consequence, followed honestly, is that the dropper stops being a
model role at all.

## The actual defect is not the dropper's model choice

Three findings from reading the installed fork at
`~/.pi/agent/git/github.com/skhlo/pi-blackhole`.

**One. `relevance` has three consumers, and the dropper is the least frequent.**

- `src/om/ledger/render-summary.ts` `scoreObservation` collapses the four-level
  enum into three weights (`high`/`critical` → 10, `medium` → 5, `low` → 1) and
  adds a recency term in `[0, 1]`. Recency can never cross a tier gap.
  `selectPriorObservations` uses that score to decide which observations survive
  into the compaction summary. This runs on every fold, through
  `src/om/ledger/projection.ts` line 239, with no model call.
- `src/om/consolidation.ts` line 739 uses the same function to cap the observer's
  own preamble in manual mode.
- `src/om/agents/dropper/agent.ts` `selectDropCandidates` uses
  `RELEVANCE_DROP_RANK` as its secondary sort key.

Note that `scoreObservation` treats `critical` and `high` as identical. The
distinction the observer was asked to make does not reach the surface that
actually decides what the agent sees after compaction.

**Two. The primary drop key is also generated, and it inverts the preservation
intent.** `selectDropCandidates` sorts lexicographically:
`coverageDelta || relevanceDelta || ageDelta || index`. Coverage comes first, and
`REFLECTION_COVERAGE_DROP_RANK` puts `strong` at 0 and `none` at 2. So among
proposed candidates, a `critical` observation cited by two reflections sorts ahead
of an uncited `low` observation and is dropped first. Coverage is derived from
`reflection.supportingObservationIds`, which the reflector model generates. The
primary key is a generated citation list. The secondary key is a generated label.

**Three. The preservation floor lives in a prompt.** `DROPPER_SYSTEM` in
`src/om/agents/dropper/prompts.ts` states an eight-bullet preservation floor as
prose to a text model: user preferences and corrections, concrete completions,
named identifiers, exact error messages, architectural decisions, dates, open
blockers, non-standard terminology. Nothing enforces it. `maxDropCountForPool`
excludes criticals only from the count it sizes the cap against, and
`selectDropCandidates` never excludes them from the slice. A run that proposes one
critical and no non-criticals, with at least one non-critical anywhere in the pool,
drops that critical.

Swapping the dropper's model changes who proposes ids. It does not touch the fold
trim, does not touch the observer preamble, does not make the floor enforceable,
and does not fix a comparator whose primary key is generated text. Grading at write
time touches all of it through one call site.

## What changes and where

### In the fork

New directory, no upstream counterpart, so it never conflicts on rebase:

- `src/om/judgment/client.ts` — a `fetch` wrapper for
  `POST https://api.typesafe.ai/v1/systemone`. Resolves the key, sets a hard
  timeout, retries `429` and `529` with exponential backoff, and returns
  `undefined` on every other failure. It never throws into the pipeline.
- `src/om/judgment/questions.ts` — pure question builders. No I/O.
- `src/om/judgment/evidence.ts` — groups observations by their cited source
  entries and assembles one request state per group, under a token budget.
- `src/om/judgment/grade.ts` — `gradeObservations(observations, chunkEntries,
  reflections, config)` returns the same `Observation[]`, each carrying a
  `judgment` field, or the input unchanged when grading is unavailable.
- `src/om/judgment/policy.ts` — tier mapping, floor enforcement, and the code-only
  drop selection. This is the file the operator tunes.

Edited, three small hunks:

- `src/om/consolidation.ts`, `runObserverStage` at the `if (result.observations &&
  result.observations.length > 0)` branch. One inserted `await
  gradeObservations(...)` and one changed argument to
  `buildObservationsRecordedData`. The evidence grouper needs `chunkEntries`, which
  is already in scope from line 695.
- `src/om/consolidation.ts`, `runDropperStage`, one branch that calls
  `selectDropsFromJudgments(...)` instead of `runDropper(...)` when the judgment
  path is on. `src/om/agents/dropper/agent.ts` stays untouched.
- `src/om/ledger/types.ts`, one optional field on `Observation`. `isObservation`
  checks only required fields, so the validator and every call site are unchanged,
  and the extra field survives JSON round-trip into the session file and into
  `MemoryDetails` on the compaction entry.
- `src/core/unified-config.ts`, the new keys, defaults and validation, following
  the existing pattern.

Slice 1 requires no edit to any ranking code. Grading overwrites `relevance` with
the calibrated tier, so `scoreObservation`, `selectPriorObservations`,
`selectDropCandidates`, the dropper prompt and the progress display all inherit
calibration with zero further changes. Slice 2 is where `scoreObservation` learns
to read the continuous value.

### Explicitly untouched

`src/tools/recall.ts` and `src/core/search-entries.ts`. Recall is on the critical
path: the agent blocks on the tool, `searchEntriesDetailed` is synchronous BM25+
capped at 50 hits, `PAGE_SIZE` is 5. No network judgment goes there. The write-time
scores are already stored, so recall can use them as a free tiebreak with zero
requests, which is a slice-2 option, not a requirement. Also untouched: the
observer and reflector agents and prompts, the dropper agent and its coverage
module, `src/hooks/before-compact.ts`, `src/om/inline-compaction.ts`, the trigger,
the pending and manual-mode machinery, and `src/project-recall/`.

### In dotfiles

- `config/pi/settings.json` — bump the pinned commit to the fork commit carrying
  the layer.
- `config/pi/blackhole-config.json` — new keys, all flat scalars:
  `judgmentMode` (`off` | `shadow` | `on`), `judgmentModel` (`jev-1.13.0`),
  `judgmentApiKeyEnv` (`TYPESAFE_API_KEY`), `judgmentTimeoutMs`,
  `judgmentMaxRequestsPerCompaction`, `judgmentEvidenceMaxTokens`,
  `judgmentScoreConfidenceFloor`, `judgmentFloorProbability`,
  `judgmentTierMedium`, `judgmentTierHigh`, `judgmentTierCritical`.
- `scripts/rollout-plan.ts` — no change needed. `mergeBlackholeConfig` already
  merges top-level keys host-wins, so new scalars seed onto hosts that lack them
  and never overwrite a `/blackhole configure` edit. Keep the thresholds flat for
  exactly this reason: `BLACKHOLE_MODEL_KEYS` is the only per-entry merge list, so
  a nested `judgmentThresholds` object set on a host would freeze whole and a later
  added sub-key would never reach it.
- `ops/setup-api-key.sh` — no change. Step 1 already writes `TYPESAFE_API_KEY` to
  the `0600` seam. It has to be run on mini and mbp.
- `docs/PI-BLACKHOLE.md` — a judgment-layer section covering the write-time grade,
  what stays in code, and the degradation posture. `docs/ROLLOUT.md` — host state
  for the key.

## The judgment design

State is shared, questions carry their own subject. Observations from one chunk
cite source entries through `sourceEntryIds`, which the observer is forced to
supply and `normalizeSourceEntryIds` validates. Code groups observations by
overlapping cited-entry sets, renders only those entries, and sends one request per
group under `judgmentEvidenceMaxTokens`. The chunk cap is 40,000 tokens, and
`docs.typesafe.ai/model-jaggedness/jev-1.13.md` names "Large State with Irrelevant
Detail" as a documented failure mode, so sending the whole chunk would be a design
error, not just a cost one. Cited evidence is the correct state because blackhole
already maintains it.

Question ids are not sent to the model, so each observation's text goes into its
own question `instructions` as a structured object. That also avoids the
documented "Indirection" failure mode, since no question has to resolve a
backticked path into an array.

**State shape, per group:**

```json
{
  "session_goal": "Make the rollout planner merge blackhole config host-wins.",
  "current_understanding": [
    "[a1b2c3] The planner copies files verbatim, which discards host edits.",
    "[d4e5f6] /blackhole configure writes the same file the planner owns."
  ],
  "evidence": {
    "entry-8812": "user: the mini lost its dropper model after the last rollout",
    "entry-8815": "assistant: rollout-plan.ts copies pi-blackhole-config.json ...",
    "entry-8817": "tool bash: git log -1 --format=%H scripts/rollout-plan.ts ..."
  }
}
```

**Question 1, retention value. Score, one per observation.** Five ordered levels,
each describing a concrete situation, no numbers in the descriptions, one dimension.

```json
{
  "type": "score",
  "instructions": {
    "judge": "The observation below is the only record that will survive once the raw conversation is compacted away. Judge what it costs the assistant to forget it, using the evidence and the current understanding as context.",
    "observation": "The rollout planner copies pi-blackhole-config.json verbatim, so a host's /blackhole configure edits are discarded on the next rollout."
  },
  "criteria": [
    "Routine progress or a tool acknowledgement. A later run reaches the same place without it, and nothing in it constrains future work.",
    "Background that makes a past step easier to follow but does not change what a future run would do.",
    "Working state a future run would otherwise re-derive, such as an intermediate finding, a file's current shape, or a partial result.",
    "A decision, a constraint, or a piece of finished work. Forgetting it makes a future run redo work, contradict a settled choice, or re-open a closed question.",
    "A standing rule, a correction the user issued, or an irreversible fact about the world. Forgetting it makes the assistant act against an explicit instruction or damage something."
  ]
}
```

Score rather than Choice over `{low, medium, high, critical}`. The decision is
graded ranking across items, and the primitives page says to use comparable
per-item Scores for exactly that. A Choice returns one label plus a distribution
over unordered options, which leaves code unable to compare two observations that
both land on `high`. That inability is the current defect: `scoreObservation`
cannot separate two `high` items except by array position. The Score returns a
probability-weighted position on an ordered array, which is the sortable quantity
the ranking code has always needed and never had.

**Questions 2 to 4, the preservation floor. Noul, three per observation.** The
eight prompt bullets collapse into three kinds of loss, because one Noul per bullet
is question sprawl and the bullets are not independent.

```json
{
  "carries_user_commitment": {
    "type": "noul",
    "instructions": { "judge": "Does the observation record something the user asserted that binds future work: a preference, a constraint, a correction, a role or identity fact, a stated deadline, or a decision the user made?", "observation": "..." },
    "criteria": { "true": "The observation records a user assertion that future work must respect.", "false": "The observation records the assistant's own work, a tool result, or context that no user assertion depends on." }
  },
  "carries_exact_token": {
    "type": "noul",
    "instructions": { "judge": "Does the observation carry a literal string that a paraphrase would destroy: a file path, an identifier, a command, a commit hash, a package or ticket name, an error message, or a failing test name?", "observation": "..." },
    "criteria": { "true": "The observation contains at least one literal string that must be reproduced character for character to stay useful.", "false": "The observation's meaning survives being restated in different words." }
  },
  "carries_open_thread": {
    "type": "noul",
    "instructions": { "judge": "Does the observation describe work that is unfinished right now: an unresolved blocker, a to-do, partial work, or something waiting on the user?", "observation": "..." },
    "criteria": { "true": "The observation describes a state that is still open and needs later action.", "false": "The observation describes something settled, finished, or purely informational." }
  }
}
```

Noul rather than a Choice over the eight categories, because several apply at once.
The primitives page is explicit: use one Noul per label when several may apply.
Noul returns no confidence, only a probability, which is the right shape here
because the floor is an asymmetric decision and code should threshold the
probability directly.

**Questions 5 and 6, supersession and duplication. Noul, per candidate pair.**
This is the honest hard part. Supersession cannot be judged at write time in the
forward direction, because the superseding evidence does not exist yet. It can be
judged in the reverse direction. When observation `i` is written, code picks up to
two prior pool observations by cheap lexical overlap, and asks, in the same batched
request:

```json
{
  "same_fact_i_j": {
    "type": "noul",
    "instructions": { "judge": "Do these two records state the same fact, differing only in wording?", "new": "...", "existing": "..." },
    "criteria": { "true": "Both records assert the same fact about the same subject.", "false": "The records assert different facts, or the same subject in a different respect." }
  },
  "replaces_i_j": {
    "type": "noul",
    "instructions": { "judge": "Does the new record describe a later state of the same thing that the existing record describes, making the existing record's description out of date?", "new": "...", "existing": "..." },
    "criteria": { "true": "The new record describes the same thing at a later point, and the existing record's description is no longer current.", "false": "Both records remain accurate, or they describe different things." }
  }
}
```

Code stores the result as edges on the new observation: `duplicateOf` and
`supersedes`. Candidate selection stays in code, which is the skill's "select
instead of generate": retrieval by lexical overlap, judgment on the shortlist.
The model cannot choose a candidate that code omitted, so the shortlist cap is a
policy knob with a real recall cost, stated plainly.

**Parallelism.** All of the above run in one request per evidence group. The
parallel-questions cookbook states that each question is scored on its own against
the state, and its worked example batches thirteen questions of mixed type in a
single call. A group of six observations with two dedup candidates each is
6 × 4 + 6 × 2 × 2 = 48 questions over one shared state. The models page states
64k tokens per request with 32k for state plus the longest question, which the
evidence budget keeps well inside.

**Second requests.** Only two cases need one. The lazy boundary rescore, because
the state changed. And a group whose evidence exceeds the budget, which code splits
rather than truncates.

**Stored shape.** One optional field on `Observation`:

```ts
judgment?: {
  v: 1;
  model: string;              // "jev-1.13.0"
  retention: number;          // 0..4, the probability-weighted Score
  retentionConfidence: number;
  floor: { user: number; exact: number; open: number };  // Noul probabilities
  duplicateOf?: string;
  supersedes?: string[];
  gradedAtEntryId: string;
  reflectionDigest: string;   // hash of reflection ids at grading time
};
```

## What stays in code

Nothing below moves to a model, because each one has an unbounded failure if a
model gets it wrong.

- **The drop cap.** `maxDropCountForPool` and its fullness-to-ratio curve stay
  exactly as upstream wrote them. A model that misjudges one observation loses one
  observation. A model that sets the cap loses the pool.
- **The preservation floor, as a hard exclusion.** If any floor probability clears
  `judgmentFloorProbability`, the observation is removed from the candidate set
  before ranking. This is the fix for the critical-can-still-be-dropped gap, and it
  is a stronger guarantee than the current one because it does not depend on the
  generated `relevance` label at all. The threshold is deliberately low, because a
  false positive costs one retained observation and a false negative costs a user
  commitment.
- **The age floor.** The dropper prompt's age gradient becomes a rule: observations
  newer than the current observer cursor window are never candidates.
- **All thresholds.** The tier cut points, the confidence floor, the floor
  probability, the dedup shortlist size. These are policy, they are tuned on the
  operator's own data, and changing one must never require re-running inference.
  That is the composite-scoring pattern's whole point: raw judgments are reusable,
  weights are not.
- **The ordering.** Coverage tier, retention score, age, proposal order. Code sorts.
- **Grouping, budgets, and the request ceiling.** Which observations get graded,
  how evidence is assembled, and the per-compaction request cap.
- **The fold trim budget.** `observationsPoolMaxTokens` stays a number in a config
  file.

## Failure and degradation

The rule is one line: grading returns the input observations unchanged, and every
downstream consumer keeps working on the observer's own label exactly as it does
today. There is no state in which the memory pipeline is worse off than the current
shipped behaviour, because the current shipped behaviour is the fallback.

| Failure | What happens | What the user sees | Pool afterwards |
| --- | --- | --- | --- |
| `TYPESAFE_API_KEY` absent | `client.ts` returns `undefined` before any network call. Grading is skipped for the session. | Nothing in the UI. One `judgment.skipped` line with `reason: "no_key"` in the debug log. | Identical to today. |
| `401` invalid key | Same as absent, plus a one-time UI info line, since this is a misconfiguration the operator can fix. | One info line per session, using the existing `tryEmitInfo` channel the workers already use. | Identical to today. |
| `429` or `529` | Exponential backoff inside the timeout budget, as the API page directs. Exhausted retries degrade. | Nothing. | Identical to today. |
| Timeout | Hard `AbortController` at `judgmentTimeoutMs`. Consolidation already runs off the critical path through `maybeLaunchConsolidation` and `runtime.launchConsolidationTask`, fire and forget, so the wall time is not user visible. | Nothing. | Identical to today. |
| `422` validation | Log the failing question ids and degrade. This is a code bug, and it should be loud in the log and silent in the UI. | Nothing. | Identical to today. |
| One group fails, others succeed | Per-group degradation. Graded groups keep their judgments, the failed group keeps observer labels. | Nothing. | Mixed pool. Ranking code handles both, because ungraded observations fall back to the tier weights. |
| Score confidence below floor | Per-observation fallback to the observer label. The Nouls in the same response are still used for the floor, since Noul carries no confidence and the floor is asymmetric. | Nothing. | Mixed pool. |
| Sustained outage across a session | Every observation written during it carries no judgment. | Nothing. | A pool with a graded prefix and an ungraded suffix. Ranking is tier-based for the suffix. This is the shipped behaviour, so it is acceptable, not merely survivable. |

The mixed pool is the case worth stating plainly: `policy.ts` must never assume a
judgment exists. Its comparator reads `judgment.retention` when present and
`RELEVANCE_DROP_RANK` scaled onto the same range when absent. The prototype pushes
that case through the walkthroughs.

## Cost and latency

**Requests per compaction.** One to three, one per evidence group, issued
concurrently, off the critical path. Capped by
`judgmentMaxRequestsPerCompaction`, default 3.

**Requests per recall.** Zero. Unchanged.

**What scales.** Questions scale with the number of new observations in the chunk
and the dedup shortlist size, both linear and both small. State scales with the
union of cited source entries, not with the chunk and not with the pool. Pool size
enters only through the dedup shortlist, which code caps.

**Confronting the frequency change honestly.** This is the real cost argument and
it cuts against me. Grading fires on every observer stage, which is due every
`observeAfterTokens` of raw conversation, default 15,000. The dropper fires on the
narrower gate in `anyStageDue`: pool fullness at or above
`dropperPoolFullnessThreshold` (0.1, so 2,000 tokens of a 20,000 budget), plus
`reflectAfterTokens` (25,000) of new material since the dropper cursor. Note also
that the pressure short-circuit in that gate compares `poolTokens` against
`dropperPressureThreshold × reflectorInputMaxTokens`, which is 0.7 × 80,000 =
56,000, while `observationsPoolMaxTokens` is 20,000. Under the shipped defaults
that branch cannot fire, so the dropper is purely batch-driven. Net: grading runs
roughly 1.7 times as often as the dropper does, and it runs even when the pool is
nowhere near pressure. That is the price of moving judgment to where the evidence
is fresh, and it is a real price.

The bet is that it is still cheaper. A grading request is stateless, its state is a
few thousand tokens of cited evidence, and output tokens are free. A dropper run is
an `agentLoop` with `agentMaxTurns` 16, `thinking: "high"` on a reasoning model, and
a `dropperInputMaxTokens` budget of 80,000, where the estate doc records that
reasoning tokens bill as output and output is DeepSeek's expensive side. I do not
know the ratio, and I will not invent one.

**Measurement method, not figures.** The API response carries
`usage.input_tokens` per request. Add one `judgment.request` debug event emitting
`{ groupSize, questionCount, stateTokens, usage.input_tokens, wallMs, status }`
through the existing `debugLog` channel. For the incumbent, the `dropper.result`
event already exists; extend the same run with provider usage from the stream so
both sides are logged in the same sessions. Then run both paths in shadow mode over
ten real sessions and sum. That gives cost per session and per compaction for both
paths from the same workload, which is the only comparison that means anything.

**The one number with provenance.** `https://docs.typesafe.ai/models.md` states
Jev pricing as "$42 / $0.042" per billion and per million tokens, with input
charged and output free, and rate limits of "250,000 tokens per second / 1,200
requests per minute". By arithmetic on that published rate, a 10,000-input-token
grading request costs about $0.00042. That is a consequence of a published price,
not a measurement, and the price should be re-read before anyone relies on it.

**Latency.** The parallel-questions cookbook reports 0.27 seconds for one batched
call of thirteen questions against a roughly 54KB document. That is their example,
not this workload, and a 48-question request is larger. It is also off the critical
path, so the number that matters is whether grading delays the next consolidation
cycle, which the timeout bounds by construction.

## Shadow mode

Three stages, each usable on its own.

**Offline replay, before any runtime change.** Finished session files already carry
every observation with its `relevance`, its `sourceEntryIds`, and the raw entries
those ids point at. A standalone script reconstructs the exact grading request for
each historical observation batch, calls TypeSafe, and writes a comparison table:
observer label, mapped tier, continuous score, confidence, floor probabilities. No
fork change, no Pi involvement, no risk. This is where calibration is proven or
disproven.

**In-session shadow.** `judgmentMode: "shadow"`. Grading runs and the judgment is
stored on the observation, but `relevance` is not overwritten and drop selection
still goes through `runDropper`. Each consolidation logs both drop sets, the
model's and the code path's, plus the symmetric difference. Behaviour is byte
identical to today except for the extra field and the extra requests.

**Cutover.** `judgmentMode: "on"` on mba first, mini and mbp after their keys land.
The mode key is a flat scalar, so the rollout merge seeds it and a host can hold
its own value.

**Comparison criteria for the cutover decision.** Agreement rate between the mapped
tier and the observer label, with the disagreements sampled and adjudicated by the
operator rather than assumed to favour either side. Zero floor violations in the
code path on a replay of every historical drop decision. Drop-set overlap between
the two paths, where a low overlap is informative in either direction and needs
reading, not a pass mark.

## Staged plan

**Slice 0. Offline replay harness.** A script in dotfiles, outside the fork, that
replays finished session files against TypeSafe and emits the comparison table.
*Acceptance:* runs on at least ten archived sessions, produces per-observation rows,
and degrades to a clear message when the key is absent. No fork file changed.

**Slice 1. Grading at write time, shadow only.** The `src/om/judgment/` module, the
one call site in `runObserverStage`, the optional field on `Observation`, the config
keys, `judgmentMode` defaulting to `off`. Grading stores the judgment and changes
nothing else.
*Acceptance:* with the mode off, the session files are byte identical to a run on
the current pin. With the mode on shadow, every observation in a new session carries
a `judgment` field, and killing the network mid-session produces observations
without the field and no UI change.

**Slice 2. Calibrated tier drives the existing ranking.** Grading overwrites
`relevance` from the Score through the code-owned thresholds, with a per-observation
fallback on low confidence. No ranking code changes.
*Acceptance:* a fold on a pool of graded observations selects a different, and
operator-agreed better, set than the same pool with observer labels. The fallback
path reproduces the observer label exactly when confidence is below the floor.

**Slice 3. Floor enforcement in code.** `policy.ts` removes floor-clearing
observations from the drop candidate set before ranking, inside the existing
`runDropper` path.
*Acceptance:* a constructed pool where the current code drops a strongly-covered
critical now cannot. Break the guard by lowering `judgmentFloorProbability` to 1.0
and confirm the old behaviour returns, which proves the guard is the thing doing the
work.

**Slice 4. Retire the dropper model call.** `selectDropsFromJudgments` replaces
`runDropper` when the mode is on. `dropperModel` becomes unused and its config keys
stay for the fallback path.
*Acceptance:* a compaction cycle that drops observations with zero DeepSeek dropper
requests in the debug log, and a drop set that is deterministic across two runs on
the same pool. Determinism is the point: the current path is not reproducible.

**Slice 5. Freshness.** Supersession edges clear `carries_open_thread` with no new
request. Boundary rescore for observations near the trim cut whose
`reflectionDigest` is stale.
*Acceptance:* closing a thread through a later observation demotes the older one
without a network call. A boundary rescore issues exactly one request and touches
only observations within the configured band of the cut line.

**Slice 6, optional.** Recall reads `judgment.retention` as a tiebreak inside the
existing synchronous BM25 ranking. Still zero requests on the critical path.

## Freshness, stated directly

Judgments are a cache and the cache is invalidated by evidence change, never by a
clock. Three rules.

`carries_open_thread` is the one field that goes stale by design, because the world
moves. It is cleared by code when a later observation records a `supersedes` edge to
it, with no new request. That is why supersession is a write-time edge rather than a
drop-time question.

Retention value is conditioned on the session goal, which drifts. Each judgment
stores `reflectionDigest`, a hash of the reflection ids current at grading time.
Staleness is defined as that digest no longer matching. Nothing is rescored because
it is stale. Rescoring happens only when a decision needs the score and the decision
is close: when the fold trim or the drop selection has to cut, code rescores only
observations within a configured band of the cut line whose digest is stale. The
band is a policy knob. This bounds rescoring to the boundary, not the pool, and it
means a long session does not accumulate a rescore debt proportional to its length.

Nothing is ever rescored on a schedule, on session resume, or in the background.

## Risks, and what kills this

**Jev is not calibrated for this domain.** The entire thesis is that a calibrated
Score beats a generated label. If slice 0's replay shows the Score disagreeing with
operator judgment more often than the observer's own label does, the direction is
dead and slice 0 is where that becomes visible, before any fork change. This is the
risk I would spend the most effort on first.

**Write time may be the wrong time for a real class of observations.** Some facts
only become load-bearing later. A file path is routine until the file turns out to
be the one that breaks. The boundary rescore is a partial answer, not a complete
one, and I am conceding that the premise has a genuine hole. The counter is that the
current design has the same hole and a worse grader.

**Evidence may be too thin.** If an observation cites one tool-result entry, the
state may not show why the fact matters. Including the reflection digest and the
adjacent user message helps and does not close it. Watch for this as low confidence
concentrated in specific observation shapes rather than spread evenly.

**State bloat defeats the point.** The jaggedness page is explicit that accuracy
falls as state grows with irrelevant content. If cited-entry groups routinely exceed
the evidence budget and have to be split, request counts rise and the cost argument
weakens.

**Version coupling.** The tier thresholds and the floor probability are tuned
against a specific model version. `jev-latest` currently aliases `jev-1.13.0`, and
an alias move would silently invalidate the calibration. Pin the version.

**Single external dependency with no offline mode.** DeepSeek has a configured
fallback ladder. TypeSafe has none. The mitigation is that its absence is the
current behaviour, which is a real mitigation and also an admission that the value
of this layer is exactly the delta it adds, not something the estate can come to
depend on.

**Rebase cost.** Three hunks in two files plus one config file. Small, but the
`runObserverStage` hunk sits in a function that upstream does change. A pre-1.0
single-maintainer package makes this a live cost every upstream review.

## Open questions for the operator

1. May grading overwrite `relevance` in place, or must the calibrated tier live in a
   parallel field? Overwriting is what makes slice 2 cost zero ranking edits.
   `src/project-recall/format-export.ts` describes the field to readers as an
   "LLM-assigned relevance tier", which stays true either way but means something
   different.
2. Pin `jev-1.13.0`, or track `jev-latest` and accept that an alias move
   invalidates the thresholds?
3. Do mini and mbp get `TYPESAFE_API_KEY` before cutover, or does the estate accept
   split behaviour across hosts for a period?
4. Should the fold trim keep treating `critical` and `high` as identical?
   `scoreObservation` collapses them today. A continuous score makes the collapse
   unnecessary, but removing it changes what reaches context on every compaction and
   is a behaviour change independent of TypeSafe.
5. How much operator labelling time is available? Slice 0 needs adjudicated ground
   truth on something like 100 to 200 observations to say anything about calibration.
6. Is the shipped `dropperPressureThreshold` behaviour, where 0.7 × 80,000 exceeds
   the 20,000 pool cap so the pressure branch cannot fire, intentional or worth
   raising upstream independently of this work?
