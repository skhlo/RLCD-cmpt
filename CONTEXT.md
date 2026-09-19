# RLCD-cmpt recall

Recall recovers evidence from session history. This glossary distinguishes finding
that evidence, judging its relevance, and preserving a search while it is paged.

## Language

**Recall query**:
The text describing evidence sought from session history. It is not the broader
conversation goal or the latest user message.

**Candidate**:
A session-history entry selected by lexical search as a possible answer to a recall
query. Being a candidate does not establish that the entry answers the query.

**Candidate set**:
The complete shortlist offered for relevance judgment for one search.
_Avoid_: Memory pool

**Judgment**:
The model's estimated probability that a specified candidate passage supplies the
evidence sought by a recall query. It is an assessment of that supplied evidence,
not a fact about the candidate's permanent importance.
_Avoid_: Truth score, retention score

**Lexical order**:
The order of candidates produced by the existing text search before semantic
judgment.

**Reranked order**:
An ordering of the same candidates using semantic judgments. It neither expands
the candidate set nor removes entries from session history.

**Result snapshot**:
The fixed search results and counts used throughout one sequence of result pages.
Its ordering may be lexical or reranked.
_Avoid_: Judgment cache

**Continuation**:
A request for a later page of an existing result snapshot, not a fresh search of
the latest history.
