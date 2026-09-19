import { describe, expect, it } from "vitest";
import type { SearchHit } from "../src/core/search-entries.js";
import {
  JEV_BOUNDS,
  JEV_MODEL,
  JEV_PROMPT,
  prepareJevRequest,
  rankPreparedCandidates,
  validateJevResponse,
} from "../src/evaluation/jev-contract.js";

const hit = (id: string, passage: string, role = "assistant"): SearchHit => ({
  id,
  index: 0,
  role,
  summary: "summary must not be sent",
  snippet: passage,
});

describe("bounded Jev request contract", () => {
  it("canonicalizes by immutable local ID while keeping IDs and metadata off the wire", () => {
    const prepared = prepareJevRequest("  Why was SQLite selected?  ", [
      hit("z-local", "SQLite appeared in an unrelated list.", "user"),
      hit("a-local", "SQLite was selected because startup must stay offline."),
    ]);

    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    expect(prepared.binding).toEqual([
      { questionKey: "c0", entryId: "a-local" },
      { questionKey: "c1", entryId: "z-local" },
    ]);
    expect(prepared.request).toEqual({
      state: {
        query: "Why was SQLite selected?",
        candidates: [
          {
            role: "assistant",
            passage: "SQLite was selected because startup must stay offline.",
          },
          { role: "user", passage: "SQLite appeared in an unrelated list." },
        ],
      },
      model: JEV_MODEL,
      questions: {
        c0: {
          type: "noul",
          instructions: JEV_PROMPT.instructions(0),
          criteria: JEV_PROMPT.criteria,
        },
        c1: {
          type: "noul",
          instructions: JEV_PROMPT.instructions(1),
          criteria: JEV_PROMPT.criteria,
        },
      },
    });
    expect(prepared.body).not.toContain("a-local");
    expect(prepared.body).not.toContain("z-local");
    expect(prepared.body).not.toContain("summary must not be sent");
    expect(Object.keys(prepared.request.state)).toEqual(["query", "candidates"]);
  });

  it("produces the same canonical body when lexical tie order changes", () => {
    const first = prepareJevRequest("full query", [hit("z", "z evidence"), hit("a", "a evidence")]);
    const second = prepareJevRequest("full query", [
      hit("a", "a evidence"),
      hit("z", "z evidence"),
    ]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.body).toBe(second.body);
    expect(first.binding).toEqual(second.binding);
  });

  it.each([
    ["duplicate immutable IDs", [hit("same", "first"), hit("same", "second")], "duplicate-id"],
    ["missing immutable IDs", [hit("", "evidence")], "missing-id"],
    [
      "missing match-centered evidence",
      [{ ...hit("a", "evidence"), snippet: undefined }],
      "missing-passage",
    ],
    [
      "an oversized passage",
      [hit("a", "x".repeat(JEV_BOUNDS.proposed.passageMaxUtf8Bytes + 1))],
      "passage-field",
    ],
  ])("rejects %s without clipping or thinning", (_name, candidates, expectedCode) => {
    const prepared = prepareJevRequest("query", candidates);

    expect(prepared).toMatchObject({ ok: false, issues: [{ code: expectedCode }] });
    if (prepared.ok) return;
    expect(prepared.lexicalCandidateEntryIds).toEqual(candidates.map((candidate) => candidate.id));
  });

  it.each([
    [
      "the query field",
      "q".repeat(JEV_BOUNDS.proposed.queryMaxUtf8Bytes + 1),
      [hit("a", "evidence")],
      "query-field",
    ],
    [
      "the role field",
      "query",
      [hit("a", "evidence", "r".repeat(JEV_BOUNDS.proposed.roleMaxUtf8Bytes + 1))],
      "role-field",
    ],
    [
      "the candidate count",
      "query",
      Array.from({ length: JEV_BOUNDS.proposed.candidateMaxCount + 1 }, (_, index) =>
        hit(`id-${index}`, "evidence"),
      ),
      "candidate-count",
    ],
  ])("enforces %s without dropping a lexical candidate", (_name, query, candidates, code) => {
    const prepared = prepareJevRequest(query, candidates);

    expect(prepared).toMatchObject({ ok: false, issues: [{ code }] });
    if (prepared.ok) return;
    expect(prepared.lexicalCandidateEntryIds).toEqual(candidates.map(({ id }) => id));
  });

  it("reports every exceeded aggregate budget from the same measured request", () => {
    const candidates = Array.from({ length: 30 }, (_, index) =>
      hit(
        `id-${index.toString().padStart(2, "0")}`,
        "x".repeat(JEV_BOUNDS.proposed.passageMaxUtf8Bytes),
      ),
    );
    const prepared = prepareJevRequest("query", candidates);

    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.issues.map(({ code }) => code)).toEqual([
      "state-bytes",
      "state-plus-longest-question",
      "state-plus-all-questions",
      "request-bytes",
    ]);
    expect(prepared.measurements).toMatchObject({
      candidateCount: 30,
      stateUtf8Bytes: expect.any(Number),
      statePlusLongestQuestionEstimatedTokens: expect.any(Number),
      statePlusAllQuestionsEstimatedTokens: expect.any(Number),
      requestUtf8Bytes: expect.any(Number),
    });
    expect(prepared.lexicalCandidateEntryIds).toEqual(candidates.map(({ id }) => id));
  });

  it("measures every proposed and documented request budget separately", () => {
    const prepared = prepareJevRequest("query", [hit("a", "bounded evidence")]);

    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.measurements).toMatchObject({
      queryUtf8Bytes: 5,
      candidateCount: 1,
      longestPassageUtf8Bytes: 16,
      stateUtf8Bytes: expect.any(Number),
      longestQuestionUtf8Bytes: expect.any(Number),
      allQuestionsUtf8Bytes: expect.any(Number),
      statePlusLongestQuestionEstimatedTokens: expect.any(Number),
      statePlusAllQuestionsEstimatedTokens: expect.any(Number),
      requestUtf8Bytes: expect.any(Number),
      requestEstimatedInputTokens: expect.any(Number),
    });
    expect(JEV_BOUNDS.vendorDocumented).toEqual({
      statePlusLongestQuestionTokens: 32_000,
      statePlusAllQuestionsTokens: 64_000,
    });
    expect(JEV_BOUNDS.estimator.exactTokenizerGuarantee).toBe(false);
  });
});

describe("complete Jev response binding", () => {
  const prepare = () => {
    const result = prepareJevRequest("query", [hit("z", "z"), hit("a", "a")]);
    if (!result.ok) throw new Error("test request must prepare");
    return result;
  };

  it("accepts only the complete pinned Noul vector and validates usage independently", () => {
    const prepared = prepare();
    const validated = validateJevResponse(
      {
        model: JEV_MODEL,
        answers: {
          c0: { type: "noul", noul: 0.8, ignored: "discard me" },
          c1: { type: "noul", noul: 0.2 },
        },
        usage: { input_tokens: "not-an-integer", output_tokens: 7 },
        ignored: "discard me",
      },
      prepared.binding,
    );

    expect(validated).toEqual({
      ok: true,
      scoresByEntryId: { a: 0.8, z: 0.2 },
      usage: null,
      usageIssue: "invalid-usage",
    });
  });

  it.each([
    ["a non-object", null, "response-object"],
    [
      "the wrong model",
      {
        model: "jev-latest",
        answers: { c0: { type: "noul", noul: 0.8 }, c1: { type: "noul", noul: 0.2 } },
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      "model",
    ],
    ["a missing answers map", { model: JEV_MODEL }, "answers-object"],
    [
      "a partial key set",
      { model: JEV_MODEL, answers: { c0: { type: "noul", noul: 0.8 } } },
      "answer-keys",
    ],
    [
      "an extra key",
      {
        model: JEV_MODEL,
        answers: {
          c0: { type: "noul", noul: 0.8 },
          c1: { type: "noul", noul: 0.2 },
          c2: { type: "noul", noul: 0.1 },
        },
      },
      "answer-keys",
    ],
    [
      "the wrong primitive",
      {
        model: JEV_MODEL,
        answers: { c0: { type: "score", noul: 0.8 }, c1: { type: "noul", noul: 0.2 } },
      },
      "answer-type",
    ],
    [
      "a non-finite probability",
      {
        model: JEV_MODEL,
        answers: { c0: { type: "noul", noul: Number.NaN }, c1: { type: "noul", noul: 0.2 } },
      },
      "answer-range",
    ],
    [
      "an out-of-range probability",
      {
        model: JEV_MODEL,
        answers: { c0: { type: "noul", noul: 1.01 }, c1: { type: "noul", noul: 0.2 } },
      },
      "answer-range",
    ],
  ])("rejects %s as a whole response", (_name, response, expectedCode) => {
    expect(validateJevResponse(response, prepare().binding)).toEqual({
      ok: false,
      reason: expectedCode,
    });
  });

  it("sorts valid scores descending with current lexical order as the tie break", () => {
    const lexical = [hit("z", "z"), hit("a", "a"), hit("m", "m")];

    expect(rankPreparedCandidates(lexical, { a: 0.9, z: 0.4, m: 0.4 }).map(({ id }) => id)).toEqual(
      ["a", "z", "m"],
    );
  });
});
