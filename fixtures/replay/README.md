# Public replay fixtures

`public-v1/` contains only synthetic session messages. Its 32 queries are split
into separate `tuning/` and `held-out/` corpora, query files, and reviewed truth
files. No real transcript, credential, or model output is included.

Do not combine the partitions. Use tuning fixtures for development and freeze any
later semantic-ranking choices before evaluating the held-out fixtures. The CLI
requires the selected partition and rejects mismatched query or truth metadata.
The deliberately constructed rankings and aggregate metrics verify evaluator
mechanics only; they do not establish retrieval or reranking quality.

See [`docs/replay-evaluator.md`](../../docs/replay-evaluator.md) for the schemas,
frozen labeling rules, commands, metrics, and reproducibility contract.
