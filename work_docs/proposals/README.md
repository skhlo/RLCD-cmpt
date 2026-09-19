# RLCD-cmpt design proposals

Start with the [final retrieval-first proposal](retrieval-first-final.md). It owns
the selected v1 scope, implementation contracts, evaluation gates, and corrections
to the original alternatives below. It selects a smaller C: query-aware recall
reranking without retention changes or birth-time grading.

The original six artifacts were preserved in the first fork-specific commit; the
refined proposal follows separately. No Jev integration is implemented by these
documentation commits, and no installed settings have changed.

## Original exploration

These are historical alternatives, not current implementation requirements. Their
technical claims and simulated results are not verified measurements. Keep the six
original files byte-for-byte unchanged; corrections belong in the refined proposal.

| Direction                   | Proposal                                         | Runnable prototype                             |
| --------------------------- | ------------------------------------------------ | ---------------------------------------------- |
| A - Minimal substitution    | [Markdown](archive/a-minimal-substitution.md)    | [HTML](archive/a-minimal-substitution.html)    |
| B - Judgment-first pipeline | [Markdown](archive/b-judgment-first-pipeline.md) | [HTML](archive/b-judgment-first-pipeline.html) |
| C - Retrieval-first         | [Markdown](archive/c-retrieval-first.md)         | [HTML](archive/c-retrieval-first.html)         |

The prototypes use inline CSS and JavaScript, system fonts, and mock judgments.
They do not call TypeSafe or load external resources. They demonstrate ideas, not
model accuracy, measured cost, or service latency.

## Run the prototypes

Download or clone this repository, then open the HTML files in a browser. GitHub's
file viewer displays source rather than executing the prototypes. No server,
build, API key, or dependency installation is required.

On macOS, from the repository root:

```sh
open work_docs/proposals/archive/a-minimal-substitution.html
open work_docs/proposals/archive/b-judgment-first-pipeline.html
open work_docs/proposals/archive/c-retrieval-first.html
```

Use the guided walkthroughs or free-play controls. In C, run the keyword search
before reranking.

## Provenance

The six originals were imported unchanged from the operator's existing
`dotfiles/preview/proposals/` exploration. The archive is excluded from automatic
formatting to preserve those originals. Verify their recorded hashes with:

```sh
cd work_docs/proposals/archive
shasum -a 256 -c SHA256SUMS
```
