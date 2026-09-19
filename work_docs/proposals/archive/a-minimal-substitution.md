# Minimal substitution: swap the dropper's model call for Jev at the existing seam

## The direction

Put TypeSafe behind the one function the dropper already calls, change nothing
else, and make the fork diff against `k0valik/pi-blackhole` one line plus new
files. The dropper is the right first target because the model's entire
contribution there is already a set of ids: code owns the cap, code owns the
ordering, code owns what happens with the result. Substituting a typed judgment
for a text-and-tool-call judgment at that boundary is a pure swap of how the set
is produced, not a change to what the set means. This optimises for four things
in order: a fork that still rebases cleanly on the weekly upstream review, a
revert that is a config key rather than a code change, a shadow window that can
prove the new path before it owns anything, and a recall reranker that lands
separately or never. It deliberately does not optimise for how much of Jev it
uses. Reranking recall, rewriting the observer, and scoring the reflector are
all better ideas after the first one has run for a week.

## What changes and where

### The fork, in order of liability

One upstream line changes. `src/om/consolidation.ts:1371` currently reads:

```ts
const { runDropper } = await import("./agents/dropper/agent.js");
```

It becomes an import of a new sibling module:

```ts
const { runDropper } = await import("./agents/dropper/judge-entry.js");
```

Nothing else in `consolidation.ts` moves. The call at 1372 keeps its argument
object, the `droppedIds` handling at 1400 keeps its shape, and the retry and
fallback machinery around it never learns that a second judge exists.

That works because `judge-entry.ts` exports `runDropper` with the identical
signature, `RunDropperArgs` in and `Promise<string[] | undefined>` out. It reads
its own configuration, routes, and on every path that is not a live TypeSafe
call it does `return (await import("./agent.js")).runDropper(args)`.

The delegation preserves the fork's own test suite without editing it.
`tests/lazy-workers.test.ts` mocks the module path
`../src/om/agents/dropper/agent.js` and asserts on import order, and
`tests/consolidation.test.ts` mocks the same path and asserts on the args object.
Both keep working, because `judge-entry.ts` imports that exact specifier lazily
and forwards the same object reference. The default route is the upstream one, so
tests never reach the network even on a host where `TYPESAFE_API_KEY` is
exported, which is the case on mba today.

New files, all additions, none of them upstream's:

- `src/om/agents/dropper/judge-entry.ts` - the router. Reads config, picks a
  route, delegates or calls the TypeSafe path, writes one debug line.
- `src/om/agents/dropper/typesafe-dropper.ts` - builds state and questions from
  `RunDropperArgs`, batches, maps answers back to ids, applies the code policy,
  returns ids. Imports `maxDropCountForPool` and `selectDropCandidates` from
  `./agent.js` rather than reimplementing them.
- `src/om/judge/typesafe-client.ts` - one `fetch` against
  `POST https://api.typesafe.ai/v1/systemone`, an abort timeout, one retry on
  429 and 529, typed errors, and the key read.
- `src/om/judge/estate-config.ts` - reads the fork's own config block. It must
  not go through `loadUnifiedConfig`: `parseConfig` in
  `src/core/unified-config.ts:505` is a key allowlist, so an unknown key never
  reaches `runtime.config`. The new module calls the already-exported
  `configPath()` and parses the JSON itself. That is why no part of the 941-line
  config file needs editing.
- `src/om/judge/shadow-log.ts` - appends JSONL next to the existing debug log.

One further upstream line changes, and it ships before any of this. See the
preservation floor below.

### The fork's config block

`saveUnifiedConfig` documents that it preserves unknown keys, so
`/blackhole configure` will not strip a block it does not know. The block is
namespaced `estate` so upstream can never collide with it:

```json
"estate": {
  "dropperJudge": "model",
  "typesafeModel": "jev-1.13.0",
  "typesafeApiKeyEnv": "TYPESAFE_API_KEY",
  "typesafeTimeoutMs": 8000,
  "typesafeMaxAttempts": 2,
  "judgeStateMaxTokens": 20000,
  "dropProposeScore": 2.5,
  "dropMinConfidence": 0.5,
  "preservationFloorNoul": 0.25,
  "shadowLogPath": "pi-blackhole/estate-judge.ndjson"
}
```

`dropperJudge` takes `model`, `shadow`, or `typesafe`. It defaults to `model`.
`PI_BLACKHOLE_ESTATE_DROPPER_JUDGE` overrides it for one session, which is how
a single session gets tested without touching a host's file.

The model id is pinned to `jev-1.13.0` rather than `jev-latest`. TypeSafe's own
model page says aliases move when a release ships, and this estate pins the Pi
packages, the fork commit, and the peer range already.

### dotfiles

- `config/pi/blackhole-config.json` gains the `estate` block, seeded with
  `dropperJudge: "model"`. Adopting the seed changes no behaviour.
- `scripts/rollout-plan.ts` gains `"estate"` in a nested-merge list beside
  `BLACKHOLE_MODEL_KEYS` at line 136. Without it, the top-level
  `{ ...wanted, ...current }` at line 147 means a host that already has an
  `estate` object never receives a newly seeded sub-key. With it, host values
  win per sub-key and the seed fills gaps, matching how worker models behave.
- `config/pi/settings.json` gains a new fork commit in the pin when the fork
  lands. That is the only place the fork version is recorded.
- `docs/PI-BLACKHOLE.md` gains a section on the judge layer: the route table,
  the degradation path, and the sentence that the fork is now genuinely ahead of
  upstream, which the current document says it is not.
- `ops/setup-api-key.sh` needs nothing. It already writes `TYPESAFE_API_KEY`
  into `~/.config/shell/env.local.sh` as option 1.

## The judgment design

The state is built once per request and shared by every question in it. Names
are chosen so the questions can point at them.

```json
{
  "situation": "A coding agent is about to forget part of a work session. The records below are the only memory it will keep of that session once the raw transcript is gone.",
  "alreadyRemembered": {
    "conclusions": [
      "The estate runs its CI on self-hosted VPS runners rather than GitHub-hosted ones.",
      "The operator wants the dropper on a judgment model and the observer on a cheap one."
    ],
    "olderRecords": [
      "Operator said never to arm auto-merge on dotfiles.",
      "The rollout merges the blackhole config per key instead of copying it."
    ]
  },
  "candidates": [
    {
      "text": "Operator ruled that the critical-preservation fix ships as its own commit before the judge layer.",
      "importanceLabel": "high",
      "coveredByConclusions": "partial",
      "age": "earlier in this session"
    },
    {
      "text": "Ran the test suite again; still green.",
      "importanceLabel": "low",
      "coveredByConclusions": "none",
      "age": "a few minutes ago"
    }
  ]
}
```

`candidates` is the `observations` array the dropper already receives, which is
only the observations recorded since the last drop pass. The existing active
pool arrives as `args.existingObservationsSummary` and becomes
`alreadyRemembered.olderRecords`; the fork already treats it as context that is
not droppable, and this keeps that true by construction, since no question ever
points at it.

`age` is a named bucket computed in code from `observation.timestamp`, never a
raw ISO string. TypeSafe publishes that Jev reads dates as text rather than as
ordered quantities. Turning the timestamp into `this session`, `earlier today`,
`yesterday`, or `older than a week` before it leaves the process removes the
model from a comparison it is documented to be bad at.

### Two questions per candidate, one request

For candidate index `i`, a Score:

```json
"safety_3": {
  "type": "score",
  "instructions": "Consider only the record at `candidates[3]`. If that record were deleted from the agent's memory right now, how much would be lost? Compare it against `alreadyRemembered` and against the other entries in `candidates`. Do not consider how full the memory is or how many records should go.",
  "criteria": [
    "This record is the only written source of a user preference, a correction, a decision, an identifier, an exact error, a deadline, or an open blocker. Deleting it loses that fact outright.",
    "This record describes work the agent is still in the middle of, and nothing in `alreadyRemembered` describes that work yet.",
    "Something in `alreadyRemembered` or another entry in `candidates` covers the same subject, but this record still carries a detail the others leave out, such as an exact value, a name, or the user's own wording.",
    "Another entry in `alreadyRemembered` or `candidates` already states the same fact at the same level of detail. Deleting this record loses nothing.",
    "This record is a routine progress note or a tool acknowledgement. It carries no decision, constraint, identifier, error message, or fact about the user."
  ]
}
```

And a Noul:

```json
"floor_3": {
  "type": "noul",
  "instructions": "Consider only the record at `candidates[3]`. Is this record the only place, across `candidates` and `alreadyRemembered`, where at least one of the things listed in the criteria is written down?",
  "criteria": {
    "true": "This record is the sole written source of at least one of: a user preference, constraint, or correction; a task the user said is finished and must not be repeated; a named file path, function, package, ticket, commit hash, handle, or exact command; an exact error message or failing test name; a technical decision together with its reason; a specific date, deadline, or incident; an open blocker or a decision waiting on the user; an unusual term the user coined.",
    "false": "Everything this record carries from that list also appears somewhere else in `candidates` or `alreadyRemembered`, or this record carries none of those things at all."
  }
}
```

All `2 * N` questions go in one request and evaluate in parallel. TypeSafe's
primitives page states that every question in a request is evaluated in
parallel, that adding questions barely changes response time, and that the
constraint is a shared token budget rather than a question count. Nothing in
this design needs a second round: no question depends on another question's
answer, so there is no chained latency and no dependent request. A second
request appears only when the pool exceeds the state budget, and those batches
fire concurrently, not in sequence.

### Why this decomposition

The obvious alternative is one Noul per candidate: "is it safe to drop this?",
threshold, rank by probability. It is half the questions. I reject it for three
reasons.

A Noul returns no confidence. TypeSafe's confidence page says so directly. The
dropper's existing policy is "default action is KEEP, when uncertain keep", and
confidence is the only calibrated way to express uncertainty as a rule. With a
Score I can say "do not propose below confidence 0.5" and have that mean
something. With a Noul I would have to fake it from the probability's distance
from 0.5, which is a different quantity.

"Safe to drop" bundles three unlike situations: covered elsewhere, still in use,
and pure noise. Jev's published jagged edges include literal reading of scoping
words and confusion when instructions and criteria ask different things. Five
ordered levels let each situation be a concrete description that stands alone,
which is what the Score page asks for.

The preservation floor is an OR over nine categories, and the TypeSafe skill is
explicit that an "any serious violation" rule needs separate conditions rather
than a weighted score. Folding the floor into the Score would make a record with
one floor item and four reasons to drop average out to droppable. A separate
Noul with a veto in code cannot average.

I also reject a Choice. A two-option `keep`/`drop` Choice throws away the
gradation the ranking needs. A Choice over the whole pool picking the single
safest record to drop would need one round per drop, which is the one shape that
does introduce chained latency.

The honest weak point is the uniqueness clause in the Noul. "Is this the only
place" asks Jev to scan the whole state, and large irrelevant state is a
published distractor. That is the single most important thing the shadow window
has to answer. The pre-planned repair, if the data says the clause fails, is to
drop uniqueness from the Noul so it asks presence only, and to let the Score's
levels 2 and 3 carry the "captured elsewhere" half. That repair is a change to
two strings in one new file.

## What stays in code

Everything that is policy. The model supplies two numbers per record and nothing
else.

- The cap. `maxDropCountForPool` keeps the fullness curve, `DROP_MIN_RATIO` 0.1
  to `DROP_MAX_RATIO` 0.5, and the exclusion of criticals from the count it
  sizes against. Jev is never told how many records may go, never sees the
  fullness percentage, and is never told that dropping is desirable. Jev is
  documented not to count reliably and not to interpolate scores into exact
  magnitudes. Both are reasons the arithmetic must not move.
- The ordering. `selectDropCandidates` keeps coverage tier, then relevance, then
  age, then proposal order. Jev's safety score enters only as the proposal
  order, which is the same contribution DeepSeek made. This is the load-bearing
  minimalism claim: the ranking function does not learn a new input in this
  slice. Making the safety score the primary sort key is a later slice with its
  own switch, so a regression in ordering can be isolated to the change that
  caused it.
- The floor veto. `floorNoul >= preservationFloorNoul` removes a record from the
  proposal set before ranking. That threshold lives in config, not in a prompt.
- The uncertainty rule. `confidence < dropMinConfidence` keeps the record. A
  drop is not reversible inside active memory, so this is the asymmetric-cost
  gate TypeSafe's confidence page describes.
- Batching and budget. Code decides how many records fit in a request, against
  the published 64k total and 32k state-plus-longest-question limits.
- Age. Buckets are computed from timestamps in code.
- Which records are even candidates. Already true upstream, and unchanged.

One upstream quirk stays untouched on purpose. `runDropper` computes
`observationTokens` over the new observations only, then divides by
`observationsPoolMaxTokens`, so the "pool fullness" that sizes the cap is really
new-observation fullness against the whole-pool budget. The cap is therefore
smaller than its name suggests. That is worth an upstream issue and it is not
worth touching in a slice whose whole argument is that drop volume does not
change.

## The preservation floor ships first, on its own

`selectDropCandidates` sorts `critical` records last but never removes them, and
`maxDropCountForPool` only excludes criticals from the count it sizes against.
When few non-criticals are proposed, a critical record can sit inside the cap
and be dropped. That is a live defect on the DeepSeek path today.

It is worse than "few non-criticals proposed", and the prototype makes this
visible. The comparator is `coverageDelta || relevanceDelta || ageDelta ||
index`, so reflection coverage outranks relevance. A critical record with
`strong` coverage sorts ahead of an uncovered `low` record. With a cap of one and
three proposals, the critical is the record that gets dropped.

It ships as slice 0, before any TypeSafe code, as its own commit: one filter in
`selectDropCandidates`. It belongs there and not in the judge slice for three
reasons. It is upstream-worthy, because it makes the two functions agree with
each other rather than changing anybody's policy, and it should be offered to
`k0valik` as a pull request so the fork can shed it on the next rebase. It is
testable on its own, with a unit test that proposes a single critical id and
expects nothing back. And landing it first means that when the pool shape
changes during the shadow window, the change cannot be blamed on the judge.

If upstream declines it, because the dropper prompt does say criticals may be
dropped with strong evidence, it stays as a one-line fork patch and becomes the
only edit inside `agent.ts`. That is an acceptable permanent cost. The
alternative, enforcing criticals only inside the new TypeSafe layer, leaves the
defect live on the fallback path, which is the path that runs whenever the key
is missing.

## Failure and degradation

The rule is one sentence: the TypeSafe path contributes nothing on any failure,
and the router then runs the upstream dropper exactly as it runs today.

- Key absent. `process.env[typesafeApiKeyEnv]` is empty. The router logs
  `estate.judge.route` with `reason: "no_key"` and delegates to `agent.js`.
  Behaviour is today's behaviour, exactly. This is not hypothetical: `zshenv`
  sources `config/shell/env.sh`, which sources the seam, so a Pi started from
  any zsh carries the key, and a Pi started from a GUI bundle or launchd does
  not. mbp and mini have no key in their seams at all, so they run this path
  until the wizard is run on them.
- HTTP 401 or 422. Deterministic. The router records a process-lifetime
  suppression so the rest of the session does not retry, logs the status, and
  delegates to `agent.js`. A malformed question body should be loud once, not
  every compaction.
- HTTP 429 or 529. One retry after a short backoff, per TypeSafe's own
  guidance, then delegate to `agent.js`.
- Timeout. `typesafeTimeoutMs`, default 8000, on an `AbortController`. On expiry
  the layer delegates to `agent.js`. Consolidation already runs off the session
  critical path through `maybeLaunchConsolidation` and
  `runtime.launchConsolidationTask`, so this costs nobody a keystroke.
- Partial batch failure. If the pool needed more than one request and any
  request fails, the TypeSafe path returns nothing and the router delegates.
  Selecting from a partial view would let the cap fall entirely on whichever
  batch happened to succeed.
- Abort. `args.signal` is passed into `fetch`. Runtime generation changes already
  abort consolidation, and this keeps that true.
- Low confidence or a high floor probability. Not a failure. The record is kept
  and the reason is logged. If every candidate is kept, `runDropper` returns
  `undefined` and consolidation advances the cursor with reason `empty`, which
  is an existing, exercised path.

What the user sees: nothing, on every branch. The dropper emits no UI message of
its own on success, and none of these branches raise. What the pool looks like
afterwards: on the delegate branches, whatever DeepSeek would have done. On the
drop-nothing branches, unchanged, with the cursor advanced so the next
compaction reconsiders the same records rather than skipping them forever.

The one thing this design refuses to do is let a TypeSafe failure cancel a
compaction. `docs/PI-BLACKHOLE.md` records that blackhole degrades rather than
cancelling, and that the estate accepted that posture deliberately. A judge layer
that cancelled would quietly restore the retired package's behaviour.

## Cost and latency

Request counts. One request per compaction in the normal case, because
`candidates` is only the observations recorded since the last drop pass and the
whole active pool is bounded by `observationsPoolMaxTokens` at 20,000. A second
request appears only when candidates plus questions exceed the state budget.
Recall reranking, if slice 5 lands, is one request per recall call that carries a
query, and zero for the expand-only path.

What scales with pool size. Tokens, not requests, until the state budget is hit.
Each candidate contributes its own text to the state once and two questions whose
text is mostly fixed. Question text does not deduplicate, so `2 * N` question
bodies are billed. Above the budget the scaling turns into
`ceil(tokens / budget)` concurrent requests.

Published vendor numbers, which are facts from `docs.typesafe.ai/models.md` and
not measurements of this system: input tokens cost $42 per billion, which is
$0.042 per million; output tokens are not charged; the window is 64k total with
32k for state plus the longest single question; throughput is 250,000 tokens per
second and 1,200 requests per minute. The rerank cookbook reports 1,200 requests
consuming 1,536,002 input tokens for $0.0645 on jev-1.12, which works out to
about 1,280 input tokens and $0.0000538 per request.

My own arithmetic, clearly labelled as an estimate and not a measurement: 20
candidates at roughly 60 tokens each, plus about 1,200 tokens of
`alreadyRemembered`, is about 2,400 tokens of state; 40 questions at roughly 110
tokens each is about 4,400; call it 7,000 input tokens, about $0.0003 per
compaction at the published rate. I have not run a single request, so treat the
per-question token figure as the weakest number here.

Measurement method rather than more invented figures. The TypeSafe side measures
itself: every response carries `usage.input_tokens`, and the shadow log records
it alongside a wall-clock duration taken around the `fetch`. After a week of
shadow records, cost per compaction and p50/p95 latency are arithmetic over that
file. No instrumentation is needed beyond the shadow log that slice 2 adds
anyway.

The DeepSeek side does not measure itself. `runDropper` logs
`dropper.agent_start` and `dropper.result` to `~/.pi/agent/pi-blackhole/debug.ndjson`
with counts but no token usage, so the comparison has to come from the DeepSeek
console's spend over a fixed window, divided by the number of `dropper.result`
lines in the same window. One recorded measurement already exists in
`docs/PI-BLACKHOLE.md`: on a mechanical prompt, disabling DeepSeek thinking took
completion tokens from 45 to 5, and 39 of those 45 were reasoning. The dropper
runs at `high` thinking, and reasoning tokens bill as output on that provider,
so the dropper is the one worker whose output side is expensive. That is the
comparison worth making, and it is the reason to expect the swap to be cheaper
rather than an assertion that it is.

Latency is not published per request and must be measured the same way. The
number that matters is not the mean but whether a slow request outlives the
consolidation task, and the timeout bounds that at `typesafeTimeoutMs`.

## Shadow mode

`dropperJudge: "shadow"` runs both paths on the same input and lets the upstream
path own the outcome.

The router calls `typesafe-dropper.ts` first, catches everything, then calls
`agent.js` and returns whatever it returns. The pool follows DeepSeek. Jev's
answer is only written down. For every pass the shadow log records: the session
id, the candidate ids with their relevance, coverage tier, age bucket and token
count, the DeepSeek proposal set and final selection, Jev's per-candidate safety
score, confidence, floor probability, the ids the code policy would have
proposed, the ids the cap would have selected, `maxDropsAllowed`, the request
token usage, and the elapsed milliseconds.

That file answers the questions a cutover needs to answer, none of which can be
reasoned out on paper. How often the two paths select the same ids. Whether the
disagreements are Jev keeping things DeepSeek dropped, which is cheap, or Jev
dropping things DeepSeek kept, which is the expensive direction and the one that
needs a human to read the text. Whether the floor Noul ever fires on a record
whose safety score was high, which is the case that proves the second question is
earning its tokens. Where the score distribution actually sits, so
`dropProposeScore` is calibrated on real data instead of the 2.5 placeholder.
Whether confidence is bimodal enough for `dropMinConfidence` to mean anything.

Shadow mode also carries the A/B against the cheaper decomposition. A second
question set, one Noul per candidate with no Score, can be sent in the same
request for a few hundred extra tokens, and its selections logged beside the
others. If the single-Noul arm agrees with the two-question arm on real data,
the two-question design loses its justification and should be dropped.

Cutting over is `dropperJudge: "typesafe"` on mba only. mbp and mini stay on
`model` until their seams have a key and their own shadow window has run, since
their sessions look nothing like mba's.

## Staged plan

Each slice lands on its own and is useful or harmless on its own. Work happens
in a clone of `skhlo/pi-blackhole`, never in `~/.pi/agent/git/`, which is the
live runtime.

Slice 0. The critical-preservation filter in `selectDropCandidates`, plus a unit
test. Offered upstream as a pull request. Acceptance: a test that proposes one
critical id and expects `[]`; the existing dropper and coverage tests still pass;
the fork pin moves in `config/pi/settings.json` and `pnpm rollout --check` shows
only that change.

Slice 1. `judge-entry.ts`, `estate-config.ts`, `typesafe-client.ts`, and the
`estate` block with `dropperJudge: "model"`. No judgment yet. Acceptance: the
whole fork suite passes unmodified, including `lazy-workers` and `consolidation`;
a real session compacts on mba and `debug.ndjson` shows
`estate.judge.route` with `route: "model"`; the rollout diff on mba is the config
block and nothing else.

Slice 2. `typesafe-dropper.ts` and `shadow-log.ts`, with `dropperJudge: "shadow"`
on mba. Acceptance: at least twenty logged passes across real work; the pool is
provably unchanged, because the shadow path never returns ids; a short script
over the JSONL reports agreement rate, disagreement direction, score and
confidence distributions, floor-veto count, tokens and latency per pass.

Slice 3. Threshold calibration from slice 2 data, then `dropperJudge: "typesafe"`
on mba. Acceptance: for one week, drop counts and pool token totals stay inside
the band the shadow window observed, and no manual `/blackhole` inspection finds
a dropped record that carried a floor item. A regression is one config key back.

Slice 4. mbp and mini. Acceptance: `ops/setup-api-key.sh` has run on each host,
each gets its own shadow window, and `docs/ROLLOUT.md` records the per-host
route.

Slice 5, independent of 1 through 4. Recall reranking. `src/tools/recall.ts:193`
already sits in an async function, and `searchEntriesDetailed` is synchronous, so
the rerank goes outside it: take the hits, keep the top 30, send one request with
the query as state and one Noul per candidate, reorder, and let the existing
`PAGE_SIZE` of 5 do the rest. Three lines and an import in `recall.ts`, plus a
new `recall-rerank.ts`. This one is on the critical path, so its timeout is
tighter and its failure is "return the BM25 order". TypeSafe's rerank cookbook
reports top-1 accuracy moving from 5 percent to 18 percent and top-10 from 38 to
62 on CLERC, which is why it is worth doing and not evidence about session
transcripts. Acceptance: shadow first, logging both orderings for real recall
calls, then a cutover behind its own config key.

## Risks, and what kills this

The uniqueness clause fails. If Jev cannot reliably judge "the only place this
appears" across a twenty-record state, the floor Noul is noise and the whole
preservation story rests on the critical filter alone. Detected in shadow mode.
Repaired by splitting presence from uniqueness. This is the most likely thing to
go wrong.

Jev's answers carry less signal than DeepSeek's chain of thought. The dropper is
the one worker the estate deliberately left at `high` thinking because it makes a
judgment rather than text. A System One model is a different trade: calibrated
and fast, with no reasoning chain. If shadow data shows Jev dropping records a
reader judges load-bearing, the direction is dead for the dropper and should move
to recall reranking, where a wrong rank costs a page position rather than a fact.

Upstream moves the dynamic import. Then the rebase conflicts on exactly one line
and takes a minute. Upstream restructures the dropper stage, and the conflict is
still one line, in a function that has moved. This is the risk the direction is
built to minimise, and it does.

The token estimate is wrong by an order of magnitude. Question text is billed per
question and the question bodies here are long. If the real figure is 30,000
input tokens per compaction rather than 7,000, cost is still around $0.0013 per
compaction, so this risk is real for the estimate and not for the decision.

Prompt injection through observation text. Observations are derived from session
content, which includes files and web pages the agent read. Jev is documented not
to treat data as hostile. The exposure is not new, because the DeepSeek dropper
reads the same text, but a typed interface can look safer than it is. The code
floor, the cap, and the fact that dropping does not erase the ledger are the
mitigations.

Two judges to reason about. Until the cutover completes on all three hosts, the
estate has two dropper implementations and a host-dependent answer to "why did
that get dropped". The shadow log and a route line in the debug log are the
answer, and `docs/PI-BLACKHOLE.md` has to carry the route table.

What kills the direction outright: shadow data showing Jev dropping load-bearing
records at a materially higher rate than DeepSeek, or TypeSafe latency routinely
outliving the consolidation task. Either verdict is available after slice 2,
before anything owns a decision.

## Open questions

1. Key delivery to a Pi that is not started from a zsh. The current answer is to
   degrade to DeepSeek. The alternative is a 0600 key file under
   `~/.pi/agent/pi-blackhole/` named by `typesafeApiKeyFile`, which duplicates a
   secret into a second place. Is silent degradation acceptable, or is the
   duplicate file the lesser cost?
2. Slice 0 upstream. Offer the critical filter to `k0valik` as a pull request, or
   keep it local and say nothing? Upstream's prompt does allow dropping a
   critical with strong evidence, so the fix is arguably a policy change and may
   be rejected.
3. Does the fork remain identical to upstream anywhere it matters? After slice 1
   the fork is genuinely ahead, and `docs/PI-BLACKHOLE.md` currently states the
   opposite as a reassurance. Does the weekly upstream review change shape, or
   does the sentence just get updated?
4. Model pin policy. `jev-1.13.0` pinned, or `jev-latest` and accept that the
   estate's judgments move when TypeSafe ships? Everything else here is pinned,
   so the default answer is pin, but a judge model that never improves is also a
   cost.
5. How many shadow passes before a cutover is honest? Twenty is my proposal. It
   is a guess about how much real compaction happens in a week on mba.
6. Slice 5 ordering. Recall reranking is on the user's critical path and gives a
   visible improvement, while the dropper is invisible and safe. If the point is
   to learn what Jev is worth, reranking teaches more per week. Should it go
   first instead?
