# Direction C: retrieval-first

## The direction

Put TypeSafe on the read path, not the delete path. The memory pool is a
retrieval problem. The agent blocks on `recall`, gets five lexically ranked
entries per page out of a shortlist capped at fifty, and the entry that answers
the question is often not in those five. Dropping observations is a
symptom-level fix: it makes the pool smaller so that lexical ranking has fewer
ways to be wrong. This direction optimizes for the probability that the right
entry is on page one. It reranks the capped shortlist by judged relevance to
the actual query, and it scores every observation once at birth along
dimensions that code reuses in three places without new inference. If page one
is right, the pool can be allowed to grow, and dropping can relax to the point
where it stops being the interesting decision.

## What changes and where

### The fork, in new files

Everything new lives under `src/typesafe/` so that a rebase against upstream
never conflicts on new code.

- `src/typesafe/client.ts` - one `postSystemOne(state, questions, signal)`
  function over `POST https://api.typesafe.ai/v1/systemone`. Reads
  `TYPESAFE_API_KEY` from `process.env` once at module load. Returns
  `undefined` when the key is absent. No retry on the read path. Bounded by an
  `AbortController`.
- `src/typesafe/rerank.ts` - builds the rerank request from a `SearchHit[]`,
  parses the answers, and returns a reordered `SearchHit[]` plus a
  `{ used: boolean, reason, latencyMs }` receipt. Owns candidate text clipping
  against the documented 32k-token state ceiling.
- `src/typesafe/dimensions.ts` - the write-time judgment pass over a single new
  observation. Returns a `StoredJudgment`.
- `src/typesafe/composite.ts` - pure. Turns a `StoredJudgment` plus config
  weights into the three scalars the three consumers want. No network, no I/O.
- `src/core/search-observations.ts` - BM25 over observation content, reusing
  the existing scorer shape. Needed because the observation pool has no text
  search at all today (slice 7).

### The fork, in existing files

The diff into upstream files is deliberately tiny and sits only at named call
sites.

- `src/tools/recall.ts:193` - after `searchEntriesDetailed` returns, one
  `await rerankHits(...)` before pagination. This is forced anyway:
  `searchEntriesDetailed` is synchronous, so a network stage cannot live inside
  it. One header suffix, `(reranked)` or `(lexical)`.
- `src/commands/vcc-recall.ts:114` - the same two lines, for the operator-facing
  `/blackhole-recall` command.
- `src/om/ledger/render-summary.ts` - `scoreObservation` gains an optional
  third argument, the stored judgment. With no judgment it returns exactly
  today's value.
- `src/om/agents/dropper/agent.ts` - `selectDropCandidates` gains the composite
  as a sort key ahead of the existing timestamp tie-break, and finally excludes
  `critical` rather than only sorting it last. The hard cap and the
  fullness-to-ratio curve are untouched.
- `src/om/consolidation.ts` - one `pi.appendEntry("om.judgments.recorded", data)`
  in the observer stage, next to the existing `OM_OBSERVATIONS_RECORDED` append
  at line 858. This runs inside `runtime.launchConsolidationTask`, which is
  already fire and forget.
- `src/core/unified-config.ts` - new keys in `DEFAULTS` and in the parse
  whitelist. The whitelist matters: `parseUnifiedConfig` ignores unknown keys,
  so a seeded key that is not whitelisted would be read as absent.

### `dotfiles`

- `config/pi/blackhole-config.json` gains `typesafeRerankMode` (`off`),
  `typesafeJudgmentsMode` (`off`), `typesafeTimeoutMs` (1200),
  `typesafeCandidateMaxChars` (600), and a `typesafeWeights` object.
- `scripts/rollout-plan.ts` needs no code change. `mergeBlackholeConfig`
  computes `{ ...wanted, ...current }`, so a key the host has never set is
  seeded and a key the host has set wins. Two consequences are worth writing
  down. First, new keys do land on every host. Second, once a host holds a
  value for a key, the baseline can never change that key again through
  rollout. `ConfigManager.save` writes `{ ...existing, ...diff }`, so a
  `/blackhole configure` pass preserves these keys rather than stripping them,
  but it also freezes whatever the host has. Weight tuning after cutover is
  therefore a per-host edit, not a rollout.
- `ops/setup-api-key.sh` already writes `TYPESAFE_API_KEY` into
  `~/.config/shell/env.local.sh` at 0600. mini and mbp need a run.
- `docs/PI-BLACKHOLE.md` gains a section on the judgment layer, the key
  requirement, and the degradation posture. `docs/ROLLOUT.md` gains the host
  state for the key.

## The judgment design

### Read path: one request per `recall` call

State carries the query, the last user message for disambiguation, and the
clipped candidate list.

```json
{
  "query": "why is the dropper on high thinking",
  "latest_user_message": "remind me what we settled on for the dropper effort",
  "candidates": [
    { "ref": "c0", "kind": "transcript", "role": "assistant", "text": "..." },
    { "ref": "c1", "kind": "observation", "relevance": "high", "text": "..." }
  ]
}
```

One **Noul** per candidate, question id `c0` through `c49`:

- instructions: "The operator is searching their own coding-session history.
  The search phrase is in `query`. The phrase they most recently typed is in
  `latest_user_message`. Judge whether the passage in `candidates[0].text`
  contains the answer they are looking for, rather than merely containing the
  same words."
- criteria true: "The passage states the fact, decision, value, error text, or
  file content the query asks for, so that reading it would end the search."
- criteria false: "The passage mentions the same terms, restates the question,
  or sits next to the answer without stating it."

Plus one **Choice**, question id `intent`, over the same state:

- criteria: `{ "fact_lookup": "...", "decision_history": "...", "error_trace":
  "...", "file_content": "...", "orientation": "The operator wants a broad
  refresher on what happened, not one specific fact." }`

Code consumes `intent` to pick a weight vector, not to filter. On
`orientation` it keeps the lexical order, because a broad refresher wants
coverage rather than a sharp top five.

**Why Noul per candidate and not one Choice over fifty options.** Choice picks
a single winner and its probabilities are competitive, so it answers "which
one" and not "which five". Recall needs a ranking where several candidates can
be independently good, and it needs an absolute threshold so that code can tell
"nothing here is relevant" from "these five are all relevant". The skill states
this rule directly: use one Noul per label when several may apply. The TypeSafe
reranking cookbook uses Noul for exactly this shape.

**Why not Score per candidate.** Score gives graded relevance, which is
tempting for ranking. The Score page warns that a score of 1.0 can mean all
probability on level 1 or half on each of levels 0 and 2, so cross-item
comparison needs care. Noul answers the same yes-or-no question about every
candidate, so its probabilities are directly comparable across items by
construction.

**Everything on the read path runs in one request.** The candidate questions
and `intent` are independent over one state, so they go together. A second
request would need an earlier answer to build new state, and on a blocking tool
call a second round trip is the thing to avoid. The narrowing that
hierarchical classification would normally buy is taken as a re-weight after
the fact rather than a filter before the fact, precisely because filtering
first would serialize.

### Write path: one request per new observation, at consolidation

State is the observation and enough context to judge it.

```json
{
  "observation": "Dropper keeps thinking high because DeepSeek exposes no medium tier and routes that request onto high.",
  "observer_relevance": "high",
  "project": "dotfiles",
  "session_goal": "..."
}
```

Five questions over that one state, in one request.

1. `durability` (**Score**, 5 levels, "how long does this stay true"):
   - "Already stale: it describes a transient state such as a running process, a temporary path, or a number that has since changed."
   - "True for this session: it describes the current task's working state."
   - "True for this project until the code changes: it describes present code, configuration, or file layout."
   - "True until a deliberate decision reverses it: it records a ruling, a convention, or an agreement."
   - "True indefinitely: it records an identity, a credential location, a hardware fact, or an external constraint."

2. `answerability` (**Score**, 4 levels, "is this a self-contained answer"):
   - "Not an answer: narration of an action with no result."
   - "Partial: names an outcome but omits the value, path, or reason needed to act on it."
   - "Self-contained: reading this alone would answer the question it addresses."
   - "Self-contained and evidenced: carries the exact value, path, command, or error string."

3. `supersession_risk` (**Noul**): true when "it records a value, state, or plan
   that ordinary continued work in this project would change"; false when
   "ordinary continued work would leave it true".

4. `facet` (**Choice**): `decision`, `defect`, `environment_fact`,
   `command_recipe`, `preference`, `open_question`, `narration`. This is the
   level-one taxonomy. It exists for memory-mode narrowing in slice 7 and for
   the operator's own reading of the pool.

5. `reachability` (**Noul**): true when "the distinctive words a person would
   type months later appear in the text: file names, command names, error
   strings, proper nouns"; false when "it is phrased in generic words such as
   'the fix', 'that file', or 'the issue', so that a keyword search would miss
   it".

`reachability` is the dimension worth defending hardest. It is the only one
that measures the actual failure mode this direction exists to fix: the
observation is present, it is perfectly relevant, and BM25 cannot see it. Low
reachability tells code two things. It should boost that observation in the
rerank, because lexical scoring under-ranked it by construction. It should
never drop it for scoring low lexically, because the low score was never
evidence about its value.

**Why one request per observation rather than one request for the whole
batch.** The parallel-questions cookbook measures a batched call at 0.27s
against 2.71s for the same thirteen questions sent one at a time over a 54,000
character document, at 12.2x lower cost, and explains why: the document
dominates every request, so paying transmission once is the win. That argument
batches questions **about one document**. Here each observation is its own
document. Batching ten observations into one request would make every question
re-read the other nine, which costs nothing extra in tokens but invites the
judgments to contaminate each other. One document per request, all five
questions about it, ten requests concurrent.

**No second request anywhere, on either path.**

### The composite

One stored record per observation, in a new `om.judgments.recorded` ledger
entry keyed by observation id:

```
{ durability: 0..4, answerability: 0..3, supersessionRisk: 0..1,
  facet: string, facetConfidence: 0..1, reachability: 0..1,
  model: "jev-1.13.0", at: "<iso>" }
```

Normalized in code by dividing by the top level, as the Score page directs:
`dur = durability / 4`, `ans = answerability / 3`.

That single record feeds three ranking surfaces that today each use a different
hand-tuned formula:

1. **What enters the compacted summary.** `selectPriorObservations` already
   ranks by `scoreObservation`, which is `base(relevance) + recency`, two
   signals. The composite becomes
   `base(relevance) + w_dur*dur + w_ans*ans - w_sup*supersessionRisk + w_rec*recency`.
   `base` is unchanged, so the relevance tier still dominates and the blast
   radius is bounded. The source comment already says the quiet part: "Observations
   stay in the branch either way; this only caps what is rendered in the
   compaction summary output." The fold is already a selection problem.

2. **What leaves the pool.** `selectDropCandidates` sorts by coverage tier,
   then relevance rank, then age. The composite slots in ahead of age. The
   dropper gets better without a second model call and without the DeepSeek
   worker changing at all.

3. **What the agent sees on page one.** `0.7 * relevance + 0.2 * dur + 0.1 * (1 - reachability)`
   for candidates that have a stored judgment. Transcript candidates have no
   stored judgment and use `relevance` alone.

Weights live in `blackhole-config.json`. Changing a weight, a threshold, or a
display filter reruns zero inference, because neither the evidence nor the
question meaning changed. The acceptance check for that slice is literally a
request counter that stays at zero across a re-weighted bench run.

**What precomputing costs in freshness.** `durability`, `answerability`,
`facet`, and `reachability` are properties of the observation text, and the
text never changes, so they do not go stale. `supersession_risk` is a
prediction, and it does go stale: once later work actually contradicts the
observation, the stored number is a guess about a settled question. The
deliberate answer is to re-judge nothing. A re-judgment sweep would reintroduce
write amplification that the retired design already paid for once. The update
arrives instead through the mechanism that already exists: the observer records
a later, contradicting observation, and the fold's recency term ranks it
higher.

## What stays in code

- **The hard drop cap and the fullness curve.** `maxDropCountForPool`,
  `DROP_MIN_RATIO` 0.1, `DROP_MAX_RATIO` 0.5. A model never decides how many
  memories die. Jev orders candidates; code decides how many get taken.
- **The critical exclusion.** `selectDropCandidates` sorting `critical` last
  without excluding it is a real preservation gap, and the fix is a filter in
  code. Asking a model whether a critical observation is safe to drop would put
  a policy in a place where it cannot be reviewed.
- **Candidate generation.** BM25, `BM25_RELATIVE_FLOOR` 0.2, and
  `SEARCH_RESULT_CAP` 50 stay exactly as they are. Jev reranks a shortlist. It
  never scans the corpus. Both cost and the documented 32k-token state ceiling
  forbid the alternative.
- **`PAGE_SIZE` 5 and `DEFAULT_RECALL_RESPONSE_MAX_CHARS` 48,000.** These are
  context-economy decisions about the agent's budget, not semantic ones.
- **The weights and thresholds themselves.** They are config, versioned and
  reviewable, and they are the reason the judgments are worth storing.
- **A relevance floor on the composite.** The prototype found this one in my own
  design. Weighted averaging assumes the dimensions are independent, and they
  are not: push the durability weight far enough and a maximally durable but
  completely irrelevant observation overtakes the entry that actually answers
  the query. A candidate whose relevance probability is below a floor is never
  eligible for page one, whatever its stored dimensions say. The floor is a
  constant in code, not a slider.
- **The tie-break.** When the rerank signal is flat or missing, lexical order
  wins. That rule is in code and it is never a judgment.
- **Everything about when to compact.** `compactAfterRatio` 0.5, the resolution
  order, `tailBehavior`, `midRunCompaction`.

## Failure and degradation

The rule is one sentence: when the rerank does not happen, `recall` returns
exactly what it returns today, in exactly today's order.

| Condition | Behaviour | What the agent sees |
| --- | --- | --- |
| `TYPESAFE_API_KEY` absent | Layer never initializes. Zero requests. | Today's response with a `(lexical)` header suffix. |
| 401 | Disable for the rest of the session after the first one. Notify the operator once through `ctx.ui`. No retry. | `(lexical)` |
| 429 or 529 | No retry on the read path. Backoff and up to three attempts on the write path, which is off the critical path. | `(lexical)` |
| Timeout at `typesafeTimeoutMs` | `AbortController` fires, the promise is discarded. | `(lexical)` |
| Malformed response | Parse failure is caught, treated as absent. | `(lexical)` |
| Flat signal | Every candidate Noul falls inside [0.35, 0.65]. Code keeps lexical order. | `(lexical, flat)` |

Noul returns no `confidence` field, only a probability, so "low confidence" on
the read path has to mean the flat-signal rule above rather than a field read.
`facet` is a Choice and does carry confidence; a facet below 0.5 is stored but
not used for narrowing.

The key-absent case is the one that needs care in practice. The key sits in
`~/.config/shell/env.local.sh`, which a login shell sources. A Pi started by
Paseo or by a launch agent may not carry it. That is not an error condition to
warn about on every call; it is the normal state on two of three hosts today.
`/blackhole status` reports it once, and nothing else mentions it.

The `(lexical)` suffix is deliberately visible to the model. It tells the agent
whether the ordering it is looking at means anything, which changes whether
paging further is worth it.

## Cost and latency

**Request counts.** Per `recall` call: exactly one request, always, regardless
of pool size. Per compaction: one request per newly recorded observation,
concurrent. Nothing scales with pool size on either path. The read path is
bounded by `SEARCH_RESULT_CAP` 50, a constant the repo already sets. The write
path is bounded by the observer's output per compaction, which is a function of
compaction frequency, not of how many observations are retained. That is the
structural argument for letting the pool grow: **every cost here is capped by a
constant that already exists.**

**Prices, from the published model card.** Jev 1.13 input is $0.042 per million
tokens. Output tokens are free. Rate limits are 250,000 tokens per second and
1,200 requests per minute. Context is 64k total per request with 32k for state
plus the longest question.

**Derived estimates, and they are derived, not measured.** A rerank request
carrying fifty candidates clipped to 600 characters is roughly 30,000
characters of state, call it 8,000 tokens, plus fifty questions at roughly 40
tokens each. About 10,000 input tokens, so about $0.0004 per recall. At one
hundred recalls a day that is about four cents a day. A write-time request is
one observation plus five questions, roughly 500 input tokens, so about
$0.00002. Ten observations per compaction is $0.0002 per compaction. Every
number in this paragraph is arithmetic over the published price, not a
measurement.

**Comparison to the DeepSeek dropper.** `dropperInputMaxTokens` is 80,000 and
the dropper runs with thinking `high` through an agent loop bounded by
`agentMaxTurns` 16. Its input volume per firing is one to two orders of
magnitude above the entire write-time judgment pass for the same compaction,
and DeepSeek bills reasoning tokens as output, which is its expensive side. The
TypeSafe layer is cheap next to a worker the estate already runs.

**Latency, honestly.** The only published latency figure is from the
parallel-questions cookbook: 0.27s for a thirteen-question batched call over a
54,000 character document, against 2.71s for the same questions sent
individually. It also states that latency grows with document size rather than
with question count. Our rerank request is a smaller document with more
questions, so that figure is suggestive and nothing more. It is not a
measurement of our shape and I am not going to treat it as one.

**Measurement method.** Slice 1 lands before any of this is built.

1. Wrap `searchEntriesDetailed` at `src/tools/recall.ts:193` in a timer and
   emit `debugLog("recall.timing", { ms, entryCount, totalBeforeCap, hits, page })`.
   Turn `debugLog` on for one host for a week of ordinary work.
2. From that log, report p50 and p95 of today's blocking recall latency, the
   distribution of `totalBeforeCap`, and the rate at which the agent requests
   `page >= 2`.
3. In slice 3, run the rerank in shadow after the response is returned and log
   its own wall clock over the same corpus of real queries. That gives p50 and
   p95 of the added latency against the real candidate sets, with zero risk to
   the session.

**The budget, stated in advance so that the measurement can fail.** A frontier
model turn already costs several seconds, so a few hundred milliseconds on a
tool call made a handful of times per session is noise. Recall is often called
two or three times in a row while the agent narrows, so the cost compounds.
Acceptance for cutover is **p95 added latency at or below 1.0s**, with a hard
timeout at 1,200 ms. **At p95 above 1.5s the inline rerank is dead.** The
precomputed half of this direction, slices 5, 6, and 8, survives that verdict,
because none of it is on the critical path. The headline read-path win does
not.

## Shadow mode

`typesafeRerankMode` takes `off`, `shadow`, or `on`.

In `shadow`, the recall tool returns the lexical response first and then fires
the rerank without awaiting it, the same fire-and-forget shape the consolidation
task already uses. Latency cost to the session is zero and the returned text is
byte-identical to today. A `debugLog("typesafe.rerank.shadow", ...)` record
carries the query, both orderings, every candidate probability, the `intent`
answer, the request latency, and the token usage the API returns.

Three things come out of that log.

- **Disagreement rate.** How often the reranked top five differs from the
  lexical top five at all. If that is near zero, the direction buys nothing and
  should stop.
- **Promotion events.** How often an entry that BM25 ranked 6 through 50 lands
  in the reranked top five. Those are exactly the page-three cases this
  direction exists to fix, and counting them is the closest thing to a direct
  measurement of the premise.
- **A weak outcome label.** There are no relevance labels for this corpus and
  there is no honest way to manufacture them. What is available is the agent's
  own subsequent behaviour. A request for `page >= 2`, a re-query inside the
  same turn, or a follow-up `recall <12-hex-id>` all indicate that page one was
  not sufficient. Compare the page-2 rate before and after cutover on the same
  host. This proxy is weak and I am not going to pretend otherwise, but it is
  real, it is free, and it is already in the session record.

Cutover is per host, one key flip in `blackhole-config.json`, reversible in one
edit. Rollback needs no rebuild because the fork reads the config live.

## Staged plan

Each slice lands on its own and each has a gate that can fail.

**Slice 1: measure, build nothing.** Timing and shortlist instrumentation in
`src/tools/recall.ts`. No TypeSafe, no config, no dotfiles change.
*Acceptance:* one week of real sessions produces p50 and p95 recall latency,
the `totalBeforeCap` distribution, and the page-2 rate. *Kill gate:* if
`totalBeforeCap` is usually five or fewer, there is no page-three problem and
this whole direction stops here.

**Slice 2: client and key seam, no behaviour.** `src/typesafe/client.ts` and
the config keys. Dotfiles: seed the keys, run `ops/setup-api-key.sh` on mini
and mbp, document the seam. *Acceptance:* `/blackhole status` reports key
presence correctly on a host with the key and on a host without it; one smoke
request returns a parsed answer; with the key removed, recall output is
byte-identical to slice 1.

**Slice 3: shadow rerank.** `src/typesafe/rerank.ts` plus the fire-and-forget
call after the response is returned. *Acceptance:* shadow records carry both
orderings and a measured latency; a diff of recall responses with the layer on
and off is empty.

**Slice 4: cut the read path over.** Flip to `on`. *Acceptance:* p95 added
latency at or below 1.0s on the slice 3 data; `(reranked)` and `(lexical)`
suffixes appear correctly; every degradation row in the table above is
exercised once by hand.

**Slice 5: write-time dimensions into the ledger.**
`src/typesafe/dimensions.ts` and one `appendEntry` in the observer stage.
*Acceptance:* after a compaction the ledger carries one judgment record per new
observation; the rerank consumes stored `durability` and `reachability`; a
bench run repeated with different weights produces a different ordering and a
request count of zero.

**Slice 6: composite into the fold.** `scoreObservation` takes the stored
judgment. *Acceptance:* with no stored judgment the fold is byte-identical to
today; with judgments, the selected observation set changes in the predicted
direction on a recorded session.

**Slice 7: memory-mode recall.** `src/core/search-observations.ts` and
`mode:"memory"`. This closes a gap that exists today independently of TypeSafe:
free-text recall searches only rendered transcript entries, and an observation
is reachable only through the transcript entry that spawned it or through a
12-hex id the agent must already know. *Acceptance:* a query naming a fact
recorded three compactions earlier returns that observation directly.

**Slice 8: relax dropping.** Introduce `observationsRetainedMaxTokens`, read
only by the dropper's fullness calculation, and leave
`observationsPoolMaxTokens` at 20,000 as the projection ceiling. Exclude
`critical` in `selectDropCandidates`. *Acceptance:* pool token count grows past
20,000 while fold token count stays pinned at the projection ceiling, and a
retained-but-unfolded observation is still found by slice 7.

**The order is load-bearing.** Slice 8 must not land before slice 6. A larger
pool means more observations competing for the same 20,000-token fold, which
makes `selectPriorObservations` matter more than it does today. Relaxing
dropping while the fold still ranks on `base(relevance) + recency` would make
the compacted summary worse, not better.

## What happens to compaction policy

`compactAfterRatio` stays at 0.5 and nothing about the trigger changes. The
important move is to split two numbers that are currently the same number.
`observationsPoolMaxTokens` 20,000 is today both the retention ceiling that
drives dropper fullness and the projection ceiling that caps what
`selectPriorObservations` renders into the summary. Splitting them means
retention can grow while the fold cannot.

This matters because the naive version of "let the pool grow" is wrong, and it
is worth being explicit about why. With `fullFoldAlways` true, the fold carries
up to 20,000 observation tokens plus 8,000 reflection tokens. On a 200k window
the compaction threshold is 100k, so the post-compaction floor is already about
28k of it. Doubling `observationsPoolMaxTokens` would push that floor to about
48k out of 100k and halve the usable working space after every compaction. So
the pool grows in the ledger and in the rerank shortlist, where growth is paid
for in disk and in one capped request, and it does not grow in context.

## Risks, and what would kill this

- **The premise is a hypothesis.** I have read the code and I can see that the
  shortlist caps at 50 and pages at 5. I have not measured how often
  `totalBeforeCap` exceeds 5 in real sessions. Slice 1 exists to answer that
  before anything is built, and a low answer kills the direction outright.
- **Latency.** This is the only direction of the three that puts a network call
  on a blocking tool call. Measured p95 above 1.5s kills the read-path half.
- **Calibration does not transfer.** The published rerank gains, top-1 from 5%
  to 18% and top-10 from 38% to 62%, are on CLERC, a corpus of US federal court
  opinions: long, formal, lexically rich passages. Coding-session transcripts
  are short, noisy, and full of near-duplicate tool output. The gain on this
  domain is unknown and could be much smaller. The docs say to treat cookbook
  results as examples to evaluate, and that applies here.
- **The 32k state ceiling.** A search snippet can reach roughly 5,000
  characters, because `SNIPPET_LINE_MAX` is 1,000 and a snippet carries up to
  five lines. Fifty of those would be about 62k tokens of state, which does not
  fit. Candidates must be clipped to roughly 600 characters. If that clip
  removes the text that distinguishes candidates, the rerank degrades toward
  noise. Kill signal in shadow: Spearman correlation between the two orderings
  above about 0.95.
- **Rebase drift.** Blackhole is pre-1.0 with a single maintainer. All new code
  is in new files, but the insertion points in `recall.ts`, `render-summary.ts`,
  and `consolidation.ts` can move under an upstream refactor. The mitigation is
  to keep those edits to a handful of lines each, which the plan does.
- **Upstream overlap.** `src/project-recall/corpus.ts` says in its own header
  that it exists for "export now, project recall later". Slice 7 may collide
  with upstream's own plan for that surface. That is the slice most likely to
  produce a painful rebase, and it is deliberately last but one.
- **A second credential seam.** The three workers authenticate through
  `~/.pi/agent/auth.json`, which is Pi's own store. TypeSafe needs an
  environment variable from a different file. Two seams for one extension is a
  real complexity cost and it is the price of this direction.
- **This direction does not shrink the pool.** If the operator's actual pain is
  worker spend or compaction frequency, retrieval-first does nothing for either.

## Open questions for the operator

1. Is the page-three problem something you have actually hit, or is it my
   inference from reading the constants? Slice 1 will answer it, but your
   answer is cheaper.
2. Transcript, observation pool, or both? I propose both, transcript first,
   because that is the surface that already blocks the agent.
3. Is 1.0s p95 added latency the right budget for a blocking tool call, or is
   anything above 300 ms unacceptable to you?
4. Put `TYPESAFE_API_KEY` on mini and mbp now, or keep this mba-only until it
   proves out? The degradation path makes mba-only safe.
5. Does Pi on this host actually inherit `~/.config/shell/env.local.sh`? If
   Paseo starts Pi outside a login shell, the key is absent on the one machine
   that has it. That is a one-line check worth running before slice 2.
6. The `(reranked)` and `(lexical)` suffix is visible to the model. Is that
   acceptable, or does recall output need to stay byte-identical to today?
7. Given upstream's stated plan for project recall, should slice 7 be built in
   the fork at all, or should it be proposed upstream instead?
