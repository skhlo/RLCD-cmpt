# Offline lexical replay evaluator

The replay evaluator measures the existing lexical recall search against explicit,
reviewed fixture truth. It is development tooling only: it does not register with
Pi, change recall output or settings, call Jev, use credentials, scan session
directories, or make network requests.

## Run it

From a development checkout with dependencies installed:

```sh
pnpm --silent replay:lexical -- \
  --corpus fixtures/replay/public-v1/tuning/corpus.jsonl \
  --queries fixtures/replay/public-v1/tuning/queries.json \
  --truth fixtures/replay/public-v1/tuning/truth.json \
  --partition tuning > /tmp/lexical-tuning.json
```

Use the held-out files and `--partition held-out` for the held-out baseline. The
partition argument is required. Query and truth metadata must match it, so a
held-out truth file cannot be silently presented as tuning data. The evaluator
has no ranking-tuning options and evaluates one partition per invocation.

The corpus is an explicit Pi-compatible session JSONL file. Its first record is
fixture metadata, which the normal session loader ignores as a non-message entry:

```json
{"type":"session","id":"fixture-tuning","schemaVersion":1,"fixtureRevision":"public-synthetic-v1","partition":"tuning"}
```

The command never discovers other files. Corpus, query, and truth revision and
partition metadata must agree. Queries and truth are versioned JSON documents:

```json
{
  "schemaVersion": 1,
  "fixtureRevision": "public-synthetic-v1",
  "partition": "tuning",
  "queries": [
    { "id": "q1", "text": "SQLite offline reason", "category": "decision-reason" }
  ]
}
```

```json
{
  "schemaVersion": 1,
  "fixtureRevision": "public-synthetic-v1",
  "partition": "tuning",
  "labels": [
    {
      "queryId": "q1",
      "classification": "answerable",
      "answerEntryIds": ["message-id"],
      "reviewed": true
    },
    { "queryId": "q2", "classification": "no-answer", "reviewed": true }
  ]
}
```

Truth is never inferred from retrieved candidates. Each query needs exactly one
reviewed `answerable` or `no-answer` label. Missing labels, duplicate labels,
explicit `ambiguous` labels, no-answer labels with answer IDs, unreviewed labels,
and answer IDs absent from the corpus produce visible invalid cases requiring
review. Invalid cases are excluded from quality denominators, and the CLI exits
with status 2 after emitting the report.

## Report contract

The evaluator calls the shared query planner, session loader, and unchanged
`searchEntriesDetailedWithPlan` implementation in hybrid mode. The report includes:

- **Candidate coverage** - answerable queries whose reviewed answer enters the
  lexical shortlist, divided by valid answerable queries.
- **Answer@5** - answerable queries whose first reviewed answer ranks in the first
  five, using the same denominator. Candidate misses count as zero.
- **Mean reciprocal rank** - reciprocal rank of the first reviewed answer, using
  the same denominator. Candidate misses contribute zero.
- **Candidate misses** - answers excluded by lexical matching, the relative floor,
  or the 50-candidate cap. These are separate from rank misses.
- **Rank misses** - reviewed answers present in the shortlist but below rank five.
- **No-answer behavior** - no-answer cases with and without lexical candidates.
  Retrieved overlap candidates are not relabeled as answers.

Every JSON report is also the reproducibility manifest. It records fixture
revision and partition, SHA-256 digests for all three inputs, the frozen ranking
configuration, aggregate results, and ordered per-case candidate IDs. It omits
wall-clock timestamps, so the same input bytes and evaluator revision produce the
same report bytes. To verify:

```sh
pnpm --silent replay:lexical -- <the same arguments> > /tmp/run-2.json
diff -u /tmp/lexical-tuning.json /tmp/run-2.json
```

The committed public corpus has 32 synthetic queries split into distinct tuning
and held-out partitions. It covers decisions with reasons, corrections and
supersession, exact commands, exact errors, plausible term-overlap distractors,
known answers, candidate misses, rank misses, and explicit no-answer cases. Freeze
any future semantic-ranking choices on tuning data before opening a held-out run;
this lexical evaluator itself performs no tuning or semantic comparison.
