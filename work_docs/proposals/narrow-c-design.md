# Narrow C: cache-first recall design

**Status: reviewed design, approved for ticketing; not implemented.** Builds on the
[selected retrieval-first proposal](retrieval-first-final.md), with runtime source
still at `51e4cfea744f5b54ed851a45359f2cafe91e205b` and Pi `0.85.1`. The selected
proposal owns scope, privacy requirements, and evaluation gates. This document owns
the proposed implementation contracts. [CONTEXT.md](../../CONTEXT.md) owns terms.

## 1. Decision and alternatives

Use one session-owned **RecallSearch module** for eligible text queries on both
recall surfaces. Keep separate internal stores for complete judgments and result
snapshots. The objective is to avoid inference when its exact input has already
been judged, not merely seek discounted provider inference.

Three interfaces were considered:

1. **Ordinary-search module:** owns loading, lexical selection, optional judgment,
   and continuation lookup. Most leverage for callers, but must not grow into a
   replacement for every recall route.
2. **Scorer plus caller-owned coordinator:** exposes snapshot construction,
   judgment stores, ranking, and paging separately. Flexible, but makes each caller
   understand the ordering and lifecycle rules. Keep this separation internal.
3. **Downstream rank-and-freeze hook:** accepts an already-computed `SearchResult`.
   Smallest integration diff, but both callers still load/search before a
   continuation and coordinate snapshot lookup and eligibility.

Choose 1 with a narrow entry point. Reuse the existing local loader and search
functions; do not introduce a general corpus port or change their ranking rules.
The third-party TypeSafe transport has a private, injected adapter with production
and test implementations. Formatting and observation augmentation stay in the
callers. A small diff is useful; one owner for stateful behavior is more useful.

No retention, observer, reflector, dropper, ledger, project recall, or model prompt
changes. In particular, do not add ranking diagnostics to the recall tool's prompt,
parameters, or returned text. DeepSeek's prompt cache is separate from both stores
below; its hit rate is not a promised consequence of this design.

## 2. External interface and integration

Illustrative TypeScript, not a new public recall-tool schema:

```ts
type RecallConsumer = "tool" | "command";

type TextSearchRequest = Readonly<{
  consumer: RecallConsumer;
  query: string;
  page: number;
  scope: "lineage" | "all";
}>;

type RecallPage = Readonly<{
  hits: readonly Readonly<SearchHit>[];
  page: number;
  totalPages: number;
  candidateCount: number;
  totalBeforeCap: number;
  truncated: boolean;
  outOfRange: boolean;
}>;

type SearchResolution =
  | { kind: "legacy" }
  | { kind: "results"; page: RecallPage; lifetime: AbortSignal }
  | {
      kind: "restart";
      reason: "missing" | "expired" | "superseded" | "snapshot-too-large" | "source-changed";
      lifetime: AbortSignal;
    };

interface RecallSearch {
  resolve(
    request: TextSearchRequest,
    ctx: Pick<ExtensionContext, "sessionManager" | "cwd">,
    signal?: AbortSignal,
  ): Promise<SearchResolution>;
  settingsApplied(): void;
}
```

The module owns five-item slicing and range checks; `page.hits` contains only that
page. The remaining fields preserve the two callers' different count/header
wording. Callers keep response budgets, source expansion hints, and rendering.
Internally, hits and nested arrays are copied and treated as immutable; a caller
cannot reorder a shared store entry. Diagnostic receipts go to an injected
internal sink, not into the caller's result or model context.

One registration helper constructs and binds the module:

```ts
const search = registerRecallSearch(pi, {
  readMode: (cwd) => {
    omRuntime.ensureConfig(cwd);
    return omRuntime.config.typesafeRerankMode;
  },
});
registerRecallTool(pi, omRuntime, search);
registerVccRecallCommand(pi, search);
```

The helper owns all session lifecycle hooks and disposal. Its implementation uses
an internal factory accepting the TypeSafe transport, credential getter, monotonic
clock, and receipt sink; tests inject substitutes but exercise `resolve()`. The
settings command calls `settingsApplied()` after its existing load. That method
reads current mode with the captured cwd, compares it to the previous mode, and
applies the transition rules below. Unrelated settings changes do not invalidate
judgments. There is no caller-owned generation, cache, or configuration reader.

Call the shared instance only at the ordinary hybrid-query path, before
loading/searching that path. `legacy` means execute today's path unchanged.
Source-ID, `#N`, drill-down, explicit expansion, mixed query-plus-expand, file,
touched, and recent-history paths bypass it entirely. Regex eligibility comes
from the existing search parser, not another regular expression in the caller.

The parser needs one shared query-plan operation used by both
`searchEntriesDetailed` and RecallSearch. It exposes literal-versus-pattern intent
and the same compiled terms the search already uses. Keep the current search
function as a compatibility wrapper. Preserve punctuation behavior, including
terms with `?` being considered patterns; v1 does not reinterpret those as natural
language questions. Do not normalize queries down to their BM25 terms: "why" and
"where" can produce similar lexical terms but require different judgments.

The tool passes its currently unused execution signal. The command passes
`ctx.signal` when available, plus module-owned lifecycle cancellation. Pi provides
no dedicated command cancellation signal while idle, so do not promise that Escape
cancels an idle command without a separate UI change.

Cancellation rejects `resolve()` with `AbortError`. The tool propagates it; the
command catches it and sends no message. A returned `lifetime` aborts when the
session, navigation, or ranking policy becomes invalid. Check it before touching
context-dependent augmentation and immediately before returning/sending output.
Do not turn cancellation into lexical success or send a stale command result to
a replacement session. Existing context disposal errors are also handled as
cancellation, not as an invitation to use the new session's context.

## 3. Fresh search versus continuation

For eligible queries, trim only outer query whitespace. Preserve case, internal
whitespace, wording, and negation in the semantic identity. Queries above a proposed
4 KiB UTF-8 admission cap stay on the legacy path on every page, rather than
allocating unbounded semantic identities or continuation keys.

| Request                                  | Behavior in `on`                                                                                                                                                           |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First page                               | Load current history and run the unchanged lexical search. Reuse a judgment only after constructing and matching the exact inference input. Publish a new result snapshot. |
| Later page                               | Look up the result snapshot. Do not reload the corpus, rerun BM25, or ask Jev.                                                                                             |
| Later page with missing/expired snapshot | Return consumer-specific guidance to restart at page one; never silently splice fresh results into an old search.                                                          |
| Zero or one candidate                    | Return lexical order and create the normal result snapshot without inference. There is no alternative ordering to judge.                                                   |
| Two through five candidates              | Still eligible for judgment: order matters even when everything fits on one page.                                                                                          |

The existing loader's two-second, mtime-sensitive cache remains in use for fresh
searches. It is not a result snapshot and must not be used as one.

Snapshots contain copied hits, original global entry indices and IDs, counts,
`totalBeforeCap`, `truncated`, ordering class, creation time, and expiration. They
do not cache rendered responses or related observations. Both callers continue
to augment selected entries from the current memory ledger. Therefore transcript
page membership is stable while related observations can legitimately become
fresher. The tool retains its character cap; the operator command retains its
current output behavior and `triggerTurn: true`.

## 4. Two stores with different identities

### Complete-judgment store

Build canonical inference input before computing the key:

- Full trimmed query, not the last user message or current model choice.
- Candidates sorted by immutable session entry ID, not BM25 rank.
- Each candidate's role and exact prepared evidence passage.
- Explicit question references such as `candidates[3].passage` and their criteria.
- Pinned model, prompt version, excerpt version, and response-contract version.

Do not put BM25 scores, lexical positions, wall-clock timestamps, page numbers,
corpus mtime, unrelated transcript text, or receipt fields in the model request.
Chronological dates already present in the evidence remain evidence, not synthetic
recency metadata. Missing or duplicate candidate IDs cause whole-list fallback.

Hash the exact deterministic serialized request and its local canonical ID
binding. Namespace it by the current session generation and credential epoch.
Store only complete, validated answer vectors bound to those IDs. Do not use a
semantic-similarity cache. A hash hit must also match the retained input identity;
no secret values are included in diagnostic keys. Credential rotation is a
deliberate cache miss: without an independent account identifier the module cannot
tell same-account rotation from a switch to a different access principal. This is
an isolation choice, not a claim that a secret changes semantic relevance.

A fresh search can have a new corpus revision and lexical order yet reuse the
same judgments if the canonical inference input is identical. Apply the retained
probabilities to the new hits and use the **current lexical order** for ties.
Counts and snippets still come from the fresh search. This is judgment reuse, not
stale-result reuse.

Every question in a batch sees the whole state. Adding, removing, or changing any
candidate evidence invalidates the whole judgment vector. Do not reuse scores for
unchanged individual candidates from a different batch. Question independence is
not independence from changed state. Likewise, a source record with the same ID
but different supplied text is a miss.

### Result-snapshot store

A continuation slot is:

```text
session generation + navigation epoch + consumer + full query + scope
+ ranking-policy version
```

It points to a particular immutable result snapshot whose provenance records the
original corpus/candidate identity. Agent and operator slots are separate so one
surface's fresh search cannot redirect the other's page two. They can still share
an exact-input judgment and in-flight request.

Starting a new page-one request invalidates that consumer's old slot immediately.
Only the latest-started request for that slot may publish. An older request that
finishes later returns `restart: superseded`, not a page whose continuation points
elsewhere. Without a new snapshot-token argument, two independent same-query page
sequences from the same consumer cannot coexist. This limitation is explicit.

Lexical fallback is also frozen into a result snapshot. A successful API recovery
must not change later pages of that search. A new first page may try again, subject
to the failure suppression below.

## 5. Lifetime, coalescing, and bounded work

Proposed initial implementation constants, subject to the offline and shadow gates:

| Resource           | Bound                                                                                                                                         |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Result snapshots   | 16 slots, 10-minute absolute lifetime, 4 MiB total retained logical payload including keys, hits, counts, provenance, and restart hints       |
| Complete judgments | 64 entries, 30-minute absolute lifetime, 4 MiB total retained logical payload including keys, request identity, local ID binding, and answers |
| In-flight requests | At most two different batches per session, including at most one shadow-only batch                                                            |
| Waiting work       | No queue; a new unmatched request at capacity falls back or skips shadow evaluation                                                           |
| Response body      | 64 KiB maximum before JSON parsing                                                                                                            |
| Request deadline   | 1,200 ms of added work, including preparation, joining an existing job, transport, body reading, and validation                               |

These are logical serialized-payload limits, not claims about exact JavaScript
heap overhead. Keys, metadata, pending-slot records, and restart hints count too;
the slot index has no independent unbounded collection. Each deferred/in-flight
capture has an additional proposed 256 KiB logical-payload cap and the query
admission cap applies before retaining any key. Acquire its concurrency slot and
check field lengths before copying or serializing. Reject an oversized string by
length before allocating another copy; estimate bytes only for bounded fields.
The offline budgeting spike may tighten these maxima, never silently leave them
unbounded.

Use least-recently-used eviction under both count and byte limits; reads do not
extend absolute lifetime. Maintain the slot index atomically with eviction. Bound
individual retained snapshots as well: if a result cannot be retained under the
byte bound, serve the lexical first page and record a small `snapshot-too-large`
slot, not a partially retained list. A continuation then asks the caller to refine
the query or turn reranking off for ordinary lexical paging; it must not send them
into a futile page-one restart loop. No cache or queue survives reload, restart, or session
change. No background warming, disk cache, cross-session reuse, embeddings, or
persistent new index.

Exact matching requests share one in-flight job whose result is only a complete
ID-to-probability vector, never an ordered page. Each surviving subscriber applies
its own current lexical tie order and publishes only its own result snapshot.
Shadow evaluation is an explicit module-owned subscriber governed by the parent
session lifetime, not by normal tool completion. Each subscriber has its own
cancellation and remaining deadline. Aborting one caller detaches only that
subscriber; abort the transport when all subscribers leave. A lifecycle reset
aborts the job regardless of subscribers. A late subscriber cannot extend the
job's original deadline. Do not cache results that arrive after timeout, reset, or
loss of the last subscriber. Late completions never publish snapshots.

Snapshot retention failures do not authorize throwing away candidates. A first
page still comes from a complete lexical result, with a receipt explaining why a
later-page request will require restart. Offline tests must make this rare-case
behavior explicit before accepting the proposed memory bounds.

## 6. Jev request and evidence contract

Use one Noul per candidate in one bounded request to the fixed TypeSafe endpoint.
The prompt asks whether that candidate supplies what the query seeks, not whether
it is generally important. Preserve the final proposal's explicit candidate
addressing and treatment of transcript instructions as data. No generation,
additional intent question, relevance threshold, or candidate filtering.

For the first offline experiment, use the existing match-centered search snippet,
with role and necessary file/source context, as the evidence passage. The matching
line and surrounding context are already selected by the existing search code.
Do not send full session entries or arbitrary leading-character clips. Unbounded
file-match snippet fields must not bypass the evidence budget.

The allowlisted wire state is exactly `{ query, candidates: [{ role, passage }] }`.
Sort using immutable entry IDs locally, then assign array positions for question
references. Do not transmit a separate session ID, entry ID, global index, absolute
source path, full message object, credential, or receipt. A path already quoted in
the authorized evidence passage remains part of that evidence; it is not extra
metadata. Relevant file content, when included, is bounded passage text selected
by the existing matching logic, not a spread of `fileMatches` objects. All local
IDs and indices remain in the code-owned response binding. Record exactly what
the model saw so an excerpt omission is distinguishable from a model error.

Admit the whole batch or fall back. Budget both state-plus-longest-question and
state-plus-all-questions against the documented 32k/64k token ceilings, with
headroom. Do not call Blackhole's own model-token estimate an exact Jev tokenizer.
The offline harness must establish a conservative estimator/byte ceiling and
publish its observed error against API usage before runtime integration. Until
then, budgeting remains an explicit implementation spike, not an invented token
guarantee. A vendor context-limit rejection is whole-list fallback and visible in
receipts; it is not a retry or a reason to drop tail candidates.

The HTTP adapter uses native `fetch`, a fixed HTTPS endpoint, no redirects, no
read-path retries, bounded body reading, and abort propagation. Parse the response
as `unknown`; require the pinned model and exactly the requested answer keys, each
with `type: noul` and a finite probability in `[0, 1]`. Validate usage independently
for reporting. Project only validated model, Noul values, and usage from the
response; discard unrecognized fields instead of retaining or logging the raw
object. Question keys are code-owned bindings, not IDs chosen by the model.
The wire response is a JSON object; duplicate candidate IDs are rejected before
dispatch, not detected by pretending the returned object is a list of IDs.

Sort descending by probability; ties retain lexical order. Flat probabilities do
not cause candidate removal or an invented confidence score.

## 7. Off, shadow, and failures

Keep one user-facing setting: `typesafeRerankMode: off | shadow | on`, default
`off`. Pin the model, prompt versions, cache bounds, and deadline in versioned code
for v1 rather than exposing a panel of tuning knobs. Read `TYPESAFE_API_KEY` from
the Pi process, never from a copied credential file.

- `off` returns `legacy` before semantic preparation, cache lookup, or network.
- `shadow` runs the existing loader/search once inside the module and returns
  `results` in lexical order, including current counts for each requested page.
  Existing callers render those results exactly as before. Capture a bounded,
  immutable lexical result and defer evaluation to a later event-loop turn, without
  awaiting model work or scanning the corpus again. No caller-owned after-response
  hook is needed. Shadow may reuse complete judgments and coalesce matching work,
  but never creates or changes continuation snapshots. Parent-session lifecycle
  cancellation owns deferred work; do not retain a stale Pi context or tie task
  survival to the normal completion of the tool call. Bounded capture overhead is
  measured, not claimed to be zero.
- `on` uses the fresh-search/continuation rules above. Every failed or incomplete
  judgment returns the complete lexical ordering. Caller cancellation is
  cancellation, not a manufactured successful fallback response.

Successful cache lookup precedes transient-service suppression. Keep failure
suppression separate from successful judgments: 401 disables new requests for the
credential epoch; 422 disables the current request-contract version for the
session; transient network errors, 429, 529, and timeout suppress new unmatched
requests for a short 5-second cooldown. Honor a longer valid `Retry-After`, capped
at 60 seconds, for rate-limit/overload replies. This is suppression of future
attempts, not a retry inside the current recall. Do not suppress because one
subscriber cancelled.

Observe credential material synchronously at each admission, immediately before
HTTP dispatch, and before accepting a transport result. There is no magical
environment-change event. An empty key skips judgment preparation/network and
produces lexical results in `on`, or skips evaluation in `shadow`. Changing
credential material advances its epoch, clears judgments and failure state, and
aborts associated in-flight work; never log the material. Existing
result snapshots remain valid because they need neither credentials nor new
inference. `off` clears all ranking state. `shadow`/`on` transitions invalidate
continuations and pending publications, but may retain complete judgments when
the actual inference input and credential epoch are unchanged.

## 8. Lifecycle and compatibility findings

Bind lifecycle wiring in the module's registration helper:

- `session_start`: initialize the session generation and owned state.
- `session_tree`: increment the navigation epoch and clear snapshots, judgments,
  and in-flight work after successful navigation.
- `session_shutdown`: dispose on quit, reload, new, resume, or fork.

Do not use the live leaf ID as the navigation epoch. Every ordinary append,
including the recall response itself, advances it. Use Pi's navigation events;
synchronously capture session ID/file, cwd, lineage IDs, and the module generation
at admission. After an await, validate only the module-owned generation and
lifetime; do not dereference a saved Pi context, whose accessors can throw after
session replacement. Callers follow the returned-lifetime contract before output.

Pi-managed history is append-only. Snapshot provenance records file device/inode
and baseline size. A continuation performs a lightweight stat, not a corpus scan:
same-file growth is allowed; replacement, shrinkage, or disappearance returns
`restart: source-changed` and clears affected snapshots. An unobserved same-file,
same-size external history rewrite is outside this append-only assumption; do not
claim to detect it or guarantee stable source indices across arbitrary edits.

Configuration must follow Blackhole's existing parser and settings owner: update
`UnifiedConfig`, defaults/validation, env mapping, the Blackhole settings field,
and documentation together. Do not create a second direct JSON reader. Add a
narrow settings-applied callback from the existing command to the ranking module
so mode changes reset pending work after the current settings load. The module
also checks current policy before committing an asynchronous result. Raw file
edits remain effective only after the existing supported reload path.

One wording correction to the earlier proposal is necessary: a JavaScript timer
cannot guarantee a preemptive 1.2-second wall-clock bound while synchronous code
or the host event loop is stalled. Start the added-work timer after the baseline
lexical search, use bounded preparation and deadline checks, and abort transport
at the remaining budget. In the table, 1,200 ms means a **cooperative added-work
budget**, not a preemptive wall-clock guarantee. It includes canonicalization,
cache lookup, waiting on a shared job, dispatch, body reading, parsing, validation,
and ordering; baseline loading/BM25 timing is recorded separately. Measure actual
overruns and keep the existing p95 gate; do not omit overruns or call this a
real-time guarantee. The selected proposal's strict observed-overrun gate remains
a pilot criterion: an overrun fails it unless the operator explicitly approves a
new tolerance before a fresh evaluation. This draft does not silently relax that
gate. Moving work to a separate
worker process would be a different scope decision.

## 9. Behavioral test plan

Test through the shared module with temporary session files, a fake clock, and a
scripted transport adapter; then test both registered caller surfaces. Do not
assert that source files contain particular code strings.

1. `off`, excluded routes, regex, zero/one candidate, later pages, exact-input hits,
   coalesced followers, and suppressed requests make zero new transport calls.
2. A repeated first page loads fresh history but reuses identical canonical input.
   An irrelevant append and a lexical tie-order change reuse judgments while
   exposing current counts. Changed candidate membership, text, query wording,
   prompt, or model produces a miss.
3. Overlapping but unequal candidate sets cannot reuse partial scores. Missing,
   duplicate, and unstable IDs cannot enter the judgment cache.
4. Page two retains the first-page result snapshot after a transcript append,
   timeout recovery, key removal, or a change to related observations. Agent and
   operator continuation slots do not replace each other.
5. Two same-consumer first pages finish in reverse order: only the newer request
   publishes; the older receives explicit restart guidance.
6. One coalesced subscriber aborts and the other completes; all aborts stop the
   transport. Lifecycle reset and expired deadlines reject late publications.
7. Every HTTP, transport, budget, oversized-body, parse, key-set, range, and model
   failure returns all lexical candidates and preserves their order.
8. Cache count, byte, absolute-expiry, no-queue, and shadow concurrency bounds hold.
   Missing/evicted continuations request page-one restart without fresh inference.
9. Off/shadow output is byte-identical through both existing renderers, including
   different headers/counts, tool output budget, OM augmentation, and operator
   `triggerTurn`. The tool's schema and prompt text remain unchanged.
10. Settings changes, session navigation, shutdown, and credential changes follow
    their distinct reset rules without touching the memory ledger.

The offline evaluator then uses the selected proposal's labeled cases, including
no-answer and adversarial transcripts. Record cold inference latency separately
from cache-hit latency, plus complete-judgment hits, continuation hits, coalesced
followers, requests actually sent, input usage, and fallback reasons. Do not let
zero-cost cache hits hide a slow or unreliable cold path. DeepSeek cached input,
uncached input, output/reasoning, and Jev input belong in a later comparable-work
cost evaluation; no hardcoded saving is an acceptance claim.

## 10. Implementation order and readiness

1. Offline fixture reader, existing lexical baseline, exact prepared-request
   capture, candidate coverage, and token-budget spike. Synthetic fixtures first;
   private excerpts remain blocked pending the proposal's explicit approvals.
2. Shared query plan and module with fake transport: continuations, exact reuse,
   cancellation, memory bounds, and all-zero-request paths.
3. TypeSafe HTTP adapter, complete-response validation, and failure suppression.
4. Both caller integrations and settings/lifecycle wiring with mode off.
5. Approved MBA shadow, then an enabled pilot only after the existing gates.

Proposed file ownership: `src/recall/search.ts` owns the external seam and session
state; `src/recall/judgment.ts` owns canonical requests/validation; and
`src/recall/typesafe.ts` is the private transport adapter. Split internal files only
where the implementation needs it. Existing search/loading and both renderers
remain their current owners. Changes to `index.ts`, query planning, config/settings,
and the two recall entry points are explicit integration work, not claimed to be
a one-line patch.

This design guides the approved ticket breakdown; it is not evidence that the
feature works. Resolve the budgeting spike and validate the proposed resource
bounds against fixtures before calling the implementation contract frozen. This
publication changes documentation only, not runtime code, credentials, or installed
settings. Host rollout and private-data transmission still require their explicit
approvals.

## Sources checked

- [Existing search](../../src/core/search-entries.ts), [loader](../../src/core/load-messages.ts),
  [tool](../../src/tools/recall.ts), [command](../../src/commands/vcc-recall.ts),
  [formatters](../../src/core/format-recall.ts), [runtime lifecycle](../../src/om/runtime.ts),
  and [settings command](../../src/commands/pi-vcc.ts), at the source pin above.
- Pi `0.85.1` extension/session docs and matching installed public types; see
  [Pi extension documentation](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/extensions.md).
- TypeSafe [HTTP contract](https://docs.typesafe.ai/api.md),
  [shared state](https://docs.typesafe.ai/concepts/state.md),
  [question independence and addressing](https://docs.typesafe.ai/primitives.md),
  and [model limits](https://docs.typesafe.ai/models.md).
