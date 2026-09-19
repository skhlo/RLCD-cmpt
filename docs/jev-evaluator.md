# Offline bounded Jev evaluator

The Jev evaluator is development tooling for the recall experiment. It prepares
and, only with explicit approval, sends bounded reranking requests over the
existing lexical candidate set. It does not register with Pi, alter runtime
recall, add settings, cache judgments, scan session directories, or read
credentials during preparation.

`jev-1.13.0`, the prompt, response contract, budgets, thresholds, price source,
tuning/held-out input digests, implementation provenance, and complete
preparation record are frozen in a plan before held-out use. Every plan field is
covered by the freeze digest; readers also validate preparation counts and gates.
A plan remains `BLOCKED` until real approved calibration and held-out evidence
exist. Synthetic fixtures and scripted transports test mechanics only and can
never pass empirical quality, budget, cost, reliability, or latency gates.

## Prepare and freeze

Preparation needs explicit files. It does not discover private history and does
not use the network or `TYPESAFE_API_KEY`.

```sh
pnpm --silent replay:jev -- prepare \
  --corpus fixtures/replay/public-v1/tuning/corpus.jsonl \
  --queries fixtures/replay/public-v1/tuning/queries.json \
  --truth fixtures/replay/public-v1/tuning/truth.json \
  --partition tuning \
  --held-out-corpus fixtures/replay/public-v1/held-out/corpus.jsonl \
  --held-out-queries fixtures/replay/public-v1/held-out/queries.json \
  --held-out-truth fixtures/replay/public-v1/held-out/truth.json \
  --input-kind synthetic > /tmp/jev-plan.json
```

The public fixture currently reports 14 prepared queries, two empty lexical
shortlists, and no preparation failures. Its gate is still `BLOCKED` with
`synthetic-input-cannot-pass-empirical-gates`,
`real-api-calibration-missing`, and `held-out-evaluation-missing`.

Each prepared case records measured field/state/question/request byte counts and
conservative token estimates. The estimate is `ceil(UTF-8 bytes / 3)`. It is not
TypeSafe's tokenizer and is not an exact context guarantee. A later calibration
must compare it with returned `usage.input_tokens`.

## Contract and bounds

The wire state is exactly:

```json
{
  "query": "the full recall query",
  "candidates": [{ "role": "user", "passage": "match-centered evidence" }]
}
```

Candidates are sorted by immutable local entry ID before positions and question
keys are assigned. IDs, lexical positions, session IDs, paths, scores, and
receipt metadata stay outside the request. Each `cN` Noul explicitly addresses
`candidates[N].passage`. Passage text comes from the existing match-centered
lexical snippet. The evaluator never substitutes an arbitrary leading clip.

A batch is all-or-nothing. Missing/duplicate IDs, missing evidence, an exceeded
budget, transport error, timeout, malformed JSON, wrong model, incomplete or
extra answer keys, wrong answer type, or a non-finite/out-of-range Noul preserves
every candidate in the complete lexical order. There is no thinning, split
batch, partial-score reuse, retry, generated answer, intent classifier, or
model-created no-answer decision.

TypeSafe documents these token ceilings:

- state plus the longest question: 32,000 tokens
- state plus all questions: 64,000 tokens

The public pages were rechecked for this implementation. The primitives page's
“around 32,000 tokens, roughly 150,000 characters” wording is only a heuristic and
conflicts with the model page's two-limit contract, so the plan uses the model
page. The API examples recommend the moving `jev-latest` alias, while the model
page explicitly says versioned IDs such as `jev-1.13.0` are accepted even when
model listing returns only aliases; this evaluator pins the version. Noul criteria
remain plain strings, satisfying the narrower HTTP schema as well as the broader
structured guidance.

The evaluator separately enforces versioned proposed guards: a 4 KiB query,
64-byte role, 8 KiB passage, 50 candidates, 192 KiB state, 25,600 estimated
tokens for state plus the longest question, 51,200 for state plus all questions,
256 KiB request, 64 KiB response, and a 1,200 ms cooperative added-work deadline.
These byte/field/deadline guards are project proposals, not vendor limits. A
JavaScript deadline aborts fetch and body reads but cannot preempt a stalled event
loop or synchronous work; observed overruns remain failures.

The standard native adapter uses only
`POST https://api.typesafe.ai/v1/systemone`, sets `redirect: "error"`, performs
one attempt, reads the response incrementally under the body cap, and propagates
caller aborts. Caller cancellation rejects the evaluation and stops later
dispatch; internal deadline and ordinary transport failures retain the complete
lexical order. Response JSON starts as `unknown`. Ranking requires the exact
pinned model and complete `cN` key set, with every answer
`{type:"noul", noul:[0,1]}`.

Usage is projected independently of judgment validation. Provider-reported usage
is retained for malformed, incomplete, non-success HTTP, and late responses when
the bounded body supplies valid counters. Every dispatched request without valid
usage is reported as unknown; its complete provider-reported cost is `null`, not
zero, and estimator/budget acceptance stays blocked. Reports distinguish
provider-reported tokens and cost, request-size estimates and estimated cost,
unknown-cost request counts, and judgment/fallback outcomes.

## Approved calibration and held-out run

A no-`--live` run is safe and useful for checking the workflow. It emits a
`BLOCKED` all-lexical report, makes zero requests, and never reads credentials:

```sh
pnpm --silent replay:jev -- run --phase calibration \
  --corpus fixtures/replay/public-v1/tuning/corpus.jsonl \
  --queries fixtures/replay/public-v1/tuning/queries.json \
  --truth fixtures/replay/public-v1/tuning/truth.json \
  --partition tuning --plan /tmp/jev-plan.json
```

Live operation requires all of `--live`, `--approval`, and `--output`. The CLI
reads `TYPESAFE_API_KEY` only after plan, phase, calibration, and approval
preflight. It requires a dedicated mode-0700 output directory, creates a new
evidence file with mode 0600, and refuses to overwrite one. The report contains
the exact transmitted wire request (without credentials), local binding,
validated judgments, provider-reported or explicitly unknown usage, estimator
error, end-to-end added latency, failures, and cost derived from reported input
tokens when complete.

Approval JSON binds one phase to the frozen plan:

```json
{
  "schemaVersion": 1,
  "planSha256": "<plan freezeSha256>",
  "phase": "calibration",
  "transmissionApproved": true,
  "approvedBy": "<human or approval record>",
  "approvedAt": "<timestamp>",
  "evidenceReference": "<approval record>",
  "localRawEvidenceRetentionDays": 7,
  "accountTerms": {
    "retentionAccepted": true,
    "accessAccepted": true,
    "deletionAccepted": true,
    "reference": "<accepted TypeSafe terms record>"
  }
}
```

`accountTerms` is mandatory for `private-reviewed` input. Local raw evidence is
limited to no more than seven days; a larger value is rejected unless the
approval also contains a non-empty `localRetentionExtensionReference`. Deletion
still requires operator authorization. Private calibration must contain at least
ten native API responses with valid provider-reported usage for every dispatched
request and demonstrate that the frozen estimator did not underestimate reported
input usage. A synthetic or scripted calibration never qualifies. Supplying a
fetch implementation or CLI transport factory always marks that adapter as
scripted, even if the injected object labels itself native. This is a guard
against accidental evidence misclassification, not an attestation mechanism or
a claim of protection from arbitrary local program changes. A live held-out
command additionally requires `--calibration <qualified-calibration-report>`
from the same frozen plan; the CLI validates the complete report, recomputes its
aggregates and gates, and binds its plan, implementation, and input before
admission. There is no path that performs live held-out first.

A held-out report keeps candidate misses separate from rank misses, compares
answer@5 and mean reciprocal rank on all answerable queries, counts promotions
and first-page regressions, lists changed orderings, and raises no-answer and
adversarial high-support alarms. Every disagreement/regression starts as
`reviewStatus: "pending"`; the evaluator does not invent reviewer judgments.

After a person reviews every listed item, bind that evidence to the exact report:

```sh
pnpm --silent replay:jev -- assess \
  --plan /path/to/frozen-plan.json \
  --report ~/.local/state/RLCD-cmpt/evaluations/<run-id>/held-out.json \
  --review-evidence /path/to/review.json
```

Review evidence names the reviewer/date, sets `heldOutEvidenceSha256`, and has one
item per pending query with a non-empty note and one of
`acceptable-change`, `confirmed-regression`, `model-error`, or `label-error`.
Assessment first validates every case, recomputes operations, comparisons, and
base gates, and binds the report to the frozen plan and executable. It then
removes only the missing-review blocker; all measured failures remain. A reported
label error adds a blocker.

## Frozen pilot thresholds

- lexical candidate coverage at least 90%
- answer@5 net improvement at least 5 percentage points and at least two
  outside-to-inside top-five promotions
- mean reciprocal rank delta at least zero
- zero consequential first-page regressions
- complete valid timely judgments for every eligible no-answer case, then zero
  candidates at or above 0.9 support; zero-candidate cases are reported but are
  not model-quality evidence
- complete valid timely judgments for every eligible adversarial no-answer case,
  then zero candidates at or above 0.9 support
- at least 95% complete valid responses within the deadline
- added-work p95 at most 1,000 ms and no observed attempt over 1,200 ms

The input price source frozen in the plan is TypeSafe's model page as retrieved on
2026-09-19: $0.042 per million input tokens, output free. It is mutable public
documentation, not a contractual quote. Provider-reported and estimated costs are
separate; complete provider-reported cost stays unknown if any dispatched request
lacks valid usage. Cost is not inferred from model correctness. The later 100-evaluation, five-session live
shadow gate is explicitly not a prerequisite for this offline evaluator.
