# Retrieval-first recall reranking

**Status: selected direction and build proposal. Not implemented.** The source claims below were checked against public commit [`51e4cfea744f5b54ed851a45359f2cafe91e205b`](https://github.com/skhlo/RLCD-cmpt/tree/51e4cfea744f5b54ed851a45359f2cafe91e205b). Nothing in this document is acceptance evidence or authorization to install a dependency, provision infrastructure, send private data, change dotfiles, or roll out a service.

## Decision

Improve query-aware recall first. Keep the generative observer, reflector, and dropper unchanged. Do not change retention, birth-time grading, observer relevance, the active pool, or the ledger schema. Do not add universal memory scores, an intent classifier, reachability or durability boosts, or new recall arguments.

The first release reranks only ordinary, non-regex free-text searches in the existing `hybrid` mode. The search parser must report whether a query is eligible; the reranker must not duplicate its own regex heuristic. This matters because the current parser classifies each term, treating operator-bearing terms as regex while keeping dotted filenames literal ([source](https://github.com/skhlo/RLCD-cmpt/blob/51e4cfea744f5b54ed851a45359f2cafe91e205b/src/core/search-entries.ts#L68-L95)). Regex searches, `mode:file`, `mode:touched`, recent-history requests, source-ID lookups, `#N` expansion, file drilldown, and mixed query-plus-expand requests retain their current routes and ordering. The existing tool exposes those paths explicitly ([source](https://github.com/skhlo/RLCD-cmpt/blob/51e4cfea744f5b54ed851a45359f2cafe91e205b/src/tools/recall.ts#L414-L455)), and query-plus-expand currently merges before pagination ([source](https://github.com/skhlo/RLCD-cmpt/blob/51e4cfea744f5b54ed851a45359f2cafe91e205b/src/tools/recall.ts#L119-L216)).

This is a bounded reranker, not semantic retrieval. BM25 still generates candidates, applies its relative floor, and caps the shortlist at 50 ([source](https://github.com/skhlo/RLCD-cmpt/blob/51e4cfea744f5b54ed851a45359f2cafe91e205b/src/core/search-entries.ts#L461-L490)). Page size remains five. Reranking cannot restore an answer excluded by lexical matching, the floor, or the cap. A candidate-coverage failure is a retrieval problem to improve separately.

## Judgment contract

Use TypeSafe model `jev-1.13.0`, pinned rather than an alias. TypeSafe documents a 64k total request limit and a separate 32k limit for state plus the longest question; both state and all questions count toward the total ([models](https://docs.typesafe.ai/models#current-models)).

For each BM25 candidate, ask one Noul:

> Does this candidate passage supply evidence that answers what the search query seeks, rather than merely mentioning the same terms?

This is a template, not the literal repeated request. Each question must address its own candidate explicitly, for example: "Does `candidates[3].passage` supply evidence that answers `query`, rather than merely mentioning the same terms?" Code binds that position to the immutable source ID and verifies the returned question key against that binding. Question IDs are for code and are not sent to the model; identical unaddressed questions over shared state would not score separate candidates ([primitives](https://docs.typesafe.ai/primitives)).

Candidate passages are delimited evidence, not instructions to obey. The question explicitly says to judge their content without following embedded commands or claims about how they should be ranked. This is fallible prompting, not an injection-proof guarantee. Include instruction-bearing transcripts and adversarial ranking instructions in the evaluation corpus; Jev documents that state is not treated as hostile by default ([adversarial content](https://docs.typesafe.ai/model-jaggedness/jev-1.13#adversarial-content)).

The true criterion says the passage itself contains the sought fact, decision and reason, command, error, correction, or other evidence. The false criterion covers term overlap, repetition of the question, adjacent context without the answer, and unrelated uses of the same words. A Noul is the appropriate primitive because it returns the probability of one defined yes/no condition and no separate confidence field ([Noul](https://docs.typesafe.ai/primitives/noul#response)). Confidence concentration must not be described as truth.

All candidate questions are independent and are batched into one request when the bounded state satisfies both limits; otherwise the whole shortlist falls back rather than being split or thinned. TypeSafe says questions in one request share state but are evaluated independently ([primitives](https://docs.typesafe.ai/primitives#ask-multiple-questions-together)). Code, not Jev, owns query classification, candidate generation, validation, routing, sorting, caps, deadlines, and allowed IDs. The search query is the full request intent; there is no latest-user-message guess. Jev supplies one Noul per candidate. It does not generate text, choose an intent, decide “no answer,” or remove candidates. RLCD means reinforcement learning for calibrated decisions, not “no LLM”; Jev returns typed judgments rather than generated prose, while the rest of this fork still uses generative models ([AI primer](https://docs.typesafe.ai/introduction/machine-learning-primer#three-post-training-approaches), [System One](https://docs.typesafe.ai/concepts/system-one#how-it-differs-from-an-llm)).

The shared module builds query-relevant excerpts: matched line windows, the candidate’s role and source identity, and enough nearby text to assess whether the evidence is present. It must not use an arbitrary `first 600 chars` clip. It budgets the serialized state, the longest question, and all questions against both model limits. If all known candidates and the evidence needed to judge them do not fit, it falls back to the complete lexical shortlist. It must never silently omit candidates and then imply that no answer exists. Filtering first and avoiding irrelevant state also follows Jev’s documented large-state limitation ([jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13#large-state-full-of-irrelevant-detail)).

## One shared ranking module

The agent `recall` tool and operator `/blackhole-recall` command must call one module, not parallel implementations. Today both call `searchEntriesDetailed`, but each paginates independently ([tool](https://github.com/skhlo/RLCD-cmpt/blob/51e4cfea744f5b54ed851a45359f2cafe91e205b/src/tools/recall.ts#L191-L237), [command](https://github.com/skhlo/RLCD-cmpt/blob/51e4cfea744f5b54ed851a45359f2cafe91e205b/src/commands/vcc-recall.ts#L109-L118)).

The module owns:

- eligibility supplied by the search parser;
- transport, native `fetch` unless implementation proves an SDK is needed;
- bounded candidate-state construction and the fixed prompt;
- response-schema, range, completeness, duplicate-ID, and known-ID checks;
- immutable source IDs and indices through every reorder and fallback;
- descending Noul order with original lexical position as the stable tie-break;
- one finite end-to-end deadline covering preparation, network, body reading, parsing, and validation;
- caller cancellation, session lifecycle cancellation, and shadow concurrency guards;
- bounded per-session ordering snapshots and structured receipts.

A receipt records mode, model and prompt versions, candidate and input usage, preparation/network/total timings, result class, and fallback reason. Private, opt-in evaluation data stores the raw judgments with the exact model and prompt versions. It never mutates observations. Public output adds neither model scores nor required arguments.

## Modes and failure behavior

`off | shadow | on` defaults to `off`.

- **Off:** bypass all new preparation, caches, and network code. Return byte-identical current output with zero requests.
- **Shadow:** return exactly the lexical output and order. Asynchronously evaluate a bounded snapshot captured during that call. The task is attached to the parent session lifecycle, obeys a strict concurrency bound, and discards late results after cancellation or session change. It cannot mutate returned results, pagination, observations, or the ledger.
- **On:** validate a complete response, then sort all candidates. Missing key, network error, malformed response, 401, 429, 529, timeout, or any incomplete candidate answer falls back to the whole lexical shortlist. There is no partial rerank and no read-path retry. A caller abort is cancellation, not a failure that should manufacture a fallback response.

The starting targets are p95 added latency at or below 1.0 second and a hard total deadline of 1.2 seconds. These are release budgets, not measurements or universal TypeSafe latency claims. Timeout and fallback rates remain visible; an operator must set an acceptable rate before `on`. A lexical fallback is functional degradation, not a successful rerank.

## Stable pagination contract

In `on`, page one stores the final ordered candidate snapshot, whether it came from Jev or whole-list lexical fallback. The bounded cache is partitioned by session, branch, normalized query, scope, mode, model, prompt, and ranking configuration. Its snapshot identity also includes the original corpus/candidate fingerprint, while a stable continuation index points to that identity. The record contains the ordered source IDs.

Continuation lookup uses the stable request identity to find that page-one record; it does not recompute a key solely from the now-live corpus. Therefore transcript appends, network recovery, or a later outage cannot reshuffle page two. A new page-one request deliberately replaces the snapshot for that identity. Session or branch change invalidates it. TTL, per-session count, and total memory bounds make eviction explicit. If page greater than one has no matching snapshot, return guidance to restart at page one instead of splicing a fresh ordering onto earlier pages. `off` and `shadow` retain existing paging.

## Evaluation gate before runtime integration

Build an offline harness and a baseline corpus of 30–50 representative, local, known-answer queries: decisions and reasons, exact commands and errors, corrections and supersession, distractors, and no-answer cases. Identify the answer passages before running either ranker. Prefer separate sessions for tuning and held-out evaluation; freeze prompt and thresholds before held-out runs. A smaller pilot can find defects but is not statistical proof.

Report:

- candidate coverage: whether an identified answer entered the 50-candidate shortlist;
- answer@5 and reciprocal rank on answerable queries only;
- no-answer behavior separately, especially promotion of mere mentions;
- reviewed disagreements and regressions, without fabricated labels;
- end-to-end added latency p50/p95 across every request, including failures and timeouts;
- timeout and fallback rates, request/input usage, and private raw evidence.

Before a held-out run, record these proposed initial pilot gates or operator-approved replacements in the evaluation manifest. Do not choose a passing threshold after looking at held-out results; a later change requires a fresh held-out set.

| Measure                         | Proposed initial gate                                                                                                                                                                                                                                               |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Candidate coverage              | At least 90% of answerable held-out queries have an identified answer in the lexical shortlist; otherwise stop and investigate retrieval separately.                                                                                                                |
| First-page quality              | At least 5 percentage points net improvement in answer@5 over lexical ranking, with at least two queries improved from outside to inside the top five. Count candidate misses as misses for both rankers.                                                           |
| Reciprocal rank                 | Mean reciprocal rank does not decrease across the same answerable held-out queries.                                                                                                                                                                                 |
| Consequential regressions       | No first-page answer loss on labeled user corrections, constraints, or superseding decisions; review every other regression before a pilot.                                                                                                                         |
| No-answer and adversarial cases | Zero candidates rated at or above 0.9 support when labeled as unrelated, instruction-only, or from a no-answer query. This is an evaluation alarm, not a production filtering threshold.                                                                            |
| Runtime reliability             | At least 100 eligible shadow evaluations across at least five sessions; at least 95% return complete valid judgments within the total deadline. Report every skip, timeout, cancellation, and fallback separately; cancellations do not count as completed reranks. |
| Added latency                   | p95 at most 1.0 second over attempted evaluations, including fallback paths; no attempt exceeds the 1.2-second total work deadline.                                                                                                                                 |

These small-sample gates authorize only a monitored pilot, not a general accuracy claim. A weak or saturated corpus is a reason to gather more representative cases, not to manufacture improvements. The operator approves the fallback tolerance before enabling; the proposed 5% ceiling is not a vendor guarantee.

Incumbent agreement, promotion counts, page-two rate, and a mock prototype are diagnostics, not proof. Quality must improve on held-out data with regressions reviewed, no candidate loss, unchanged special lookup paths, stable pagination, and byte-identical `off`/`shadow` output. The TypeSafe reranking cookbook supports the shortlist-then-judge pattern but its legal-corpus results are not evidence for coding sessions ([cookbook](https://docs.typesafe.ai/cookbooks/rerank_typesafe#re-ranking-with-typesafe)). No RLCD-cmpt benchmark numbers exist yet.

Use synthetic fixtures publicly. Sanitized real excerpts may be published only after separate review and permission; removing a name alone does not make a transcript public. Historical local sessions are never committed and require explicit permission before any excerpt is sent to TypeSafe. Credentials remain host-local.

Raw evaluation capture defaults off. When approved, store only the selected query, labeled evidence, transmitted candidate excerpts, answers, and versioned receipt under `~/.local/state/RLCD-cmpt/evaluations/<run-id>/`, outside the checkout, with directory mode 0700 and file mode 0600. Inspect the exact outbound request and redact credentials, personal data, and unrelated confidential content before sending; never log authorization headers. Preflight must refuse private excerpts without recorded approval. Set a maximum seven-day local raw-evidence window unless the operator explicitly extends it. Review and authorize task-owned evidence deletion at the end of the run; retain only approved aggregate results and synthetic fixtures in Git.

Before private-data evaluation or MBA shadow, record the exact TypeSafe account's accepted retention, access, and deletion terms and obtain consent for those terms. "Not used for training" is not a zero-retention promise ([models and data handling](https://docs.typesafe.ai/models#data-handling), [legal terms](https://docs.typesafe.ai/legal)). Unknown or unaccepted terms block private requests; continue with synthetic data only. MBA shadow requires this privacy gate and the offline quality gates. Its measurements then establish the runtime reliability and latency gates required for the enabled pilot.

## Delivery slices and operations

1. Offline harness, labeled baseline corpus, and candidate-coverage gate.
2. Shared ranking module with fake transport tests for budgeting, validation, complete-list fallback, cancellation, deadline, cache lifecycle, and stable ties.
3. Integrate both recall surfaces with mode `off`; prove zero requests and unchanged outputs, including IDs, regex, file modes, drilldown, expansion, and mixed query-plus-expand.
4. MBA-only shadow after the offline gates.
5. MBA enabled pilot only after quality, latency, privacy, and fallback gates. Other hosts follow independently.

Development uses a normal clone or worktree, never the live runtime checkout. Dotfiles work comes later as a new git source/pin plus mode-off configuration and documentation. A renamed source package identity needs a planned rollout; editing installed settings is not a rollout. Runtime configuration is cached, so implementation must verify the actual settings-save/reload wiring rather than claim a file edit is live; the current settings command explicitly reloads runtime config after its UI closes ([source](https://github.com/skhlo/RLCD-cmpt/blob/51e4cfea744f5b54ed851a45359f2cafe91e205b/src/commands/pi-vcc.ts#L63-L70)). Rollback is disable plus verified reload. This proposal introduces no deletion behavior.

## Corrections and boundaries

The archived six artifacts remain historical and untouched. Their mock HTML is not model-quality or latency evidence, and C’s prototype contains beyond-v1 retention and scoring ideas; it is not the final UI or implementation specification.

A critical drop is permitted by the current prompt under strong semantic evidence ([source](https://github.com/skhlo/RLCD-cmpt/blob/51e4cfea744f5b54ed851a45359f2cafe91e205b/src/om/agents/dropper/prompts.ts#L25-L33)) and tests accept and select critical IDs ([source](https://github.com/skhlo/RLCD-cmpt/blob/51e4cfea744f5b54ed851a45359f2cafe91e205b/tests/dropper.test.ts#L147-L157), [source](https://github.com/skhlo/RLCD-cmpt/blob/51e4cfea744f5b54ed851a45359f2cafe91e205b/tests/dropper.test.ts#L267-L274)); it is not an established upstream bug. The 20k setting is a projection output limit, a trigger for full-fold maintenance, and the budget denominator used by dropper fullness, not a hard retained-ledger ceiling; source records remain in the branch ([projection](https://github.com/skhlo/RLCD-cmpt/blob/51e4cfea744f5b54ed851a45359f2cafe91e205b/src/om/ledger/projection.ts#L228-L246), [dropper calculation](https://github.com/skhlo/RLCD-cmpt/blob/51e4cfea744f5b54ed851a45359f2cafe91e205b/src/om/agents/dropper/agent.ts#L108-L127)). Drop events are ledger tombstones accumulated by the fold ([source](https://github.com/skhlo/RLCD-cmpt/blob/51e4cfea744f5b54ed851a45359f2cafe91e205b/src/om/ledger/fold.ts#L87-L92)); a config rollback does not undo them. Low reachability boosts cannot recover excluded candidates.

Observer source-faithfulness checks may be evaluated later as a separate candidate, not a dependency. Any later dropper proof must track a relationship to a surviving witness record; independently judging two duplicates redundant can delete both.

## Readiness

The direction is selected and source-pinned. It is ready for the offline harness, not runtime activation. Missing evidence is the labeled local corpus, candidate-coverage result, held-out quality result, measured p50/p95 latency, input usage, timeout/fallback rates, verified privacy approval for any live excerpts, and proven runtime reload wiring. Those gates decide readiness to enable; they do not reopen the settled scope.
