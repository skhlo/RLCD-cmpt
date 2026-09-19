import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("lexical replay CLI", () => {
  it("reports a known answer found by the shared lexical search", () => {
    const dir = mkdtempSync(join(tmpdir(), "blackhole-replay-cli-"));
    const corpusPath = join(dir, "corpus.jsonl");
    const queriesPath = join(dir, "queries.json");
    const truthPath = join(dir, "truth.json");

    try {
      writeFileSync(
        corpusPath,
        `${[
          {
            type: "session",
            id: "fixture-cli-test",
            schemaVersion: 1,
            fixtureRevision: "cli-test-v1",
            partition: "tuning",
          },
          {
            type: "message",
            id: "answer-entry",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "We chose SQLite because startup stays offline." }],
            },
          },
        ]
          .map((entry) => JSON.stringify(entry))
          .join("\n")}\n`,
      );
      writeFileSync(
        queriesPath,
        `${JSON.stringify({
          schemaVersion: 1,
          fixtureRevision: "cli-test-v1",
          partition: "tuning",
          queries: [
            {
              id: "decision-query",
              text: "SQLite offline startup reason",
              category: "decision-reason",
            },
          ],
        })}\n`,
      );
      writeFileSync(
        truthPath,
        `${JSON.stringify({
          schemaVersion: 1,
          fixtureRevision: "cli-test-v1",
          partition: "tuning",
          labels: [
            {
              queryId: "decision-query",
              classification: "answerable",
              answerEntryIds: ["answer-entry"],
              reviewed: true,
            },
          ],
        })}\n`,
      );

      const stdout = execFileSync(
        "pnpm",
        [
          "--silent",
          "replay:lexical",
          "--",
          "--corpus",
          corpusPath,
          "--queries",
          queriesPath,
          "--truth",
          truthPath,
          "--partition",
          "tuning",
        ],
        { cwd: process.cwd(), encoding: "utf8" },
      );
      const report: unknown = JSON.parse(stdout);

      expect(report).toMatchObject({
        manifestVersion: 1,
        fixture: { revision: "cli-test-v1", partition: "tuning" },
        aggregate: {
          candidateCoverage: { hits: 1, denominator: 1, rate: 1 },
          answerAt5: { hits: 1, denominator: 1, rate: 1 },
          meanReciprocalRank: { denominator: 1, value: 1 },
        },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("emits invalid truth for review and exits with status 2", () => {
    const dir = mkdtempSync(join(tmpdir(), "blackhole-replay-cli-invalid-"));
    const corpusPath = join(dir, "corpus.jsonl");
    const queriesPath = join(dir, "queries.json");
    const truthPath = join(dir, "truth.json");

    try {
      writeFileSync(
        corpusPath,
        `${[
          {
            type: "session",
            id: "fixture-cli-invalid",
            schemaVersion: 1,
            fixtureRevision: "cli-invalid-v1",
            partition: "tuning",
          },
          {
            type: "message",
            id: "possible-answer",
            message: { role: "user", content: "possible answer" },
          },
        ]
          .map((entry) => JSON.stringify(entry))
          .join("\n")}\n`,
      );
      writeFileSync(
        queriesPath,
        `${JSON.stringify({
          schemaVersion: 1,
          fixtureRevision: "cli-invalid-v1",
          partition: "tuning",
          queries: [{ id: "q1", text: "possible answer", category: "test" }],
        })}\n`,
      );
      writeFileSync(
        truthPath,
        `${JSON.stringify({
          schemaVersion: 1,
          fixtureRevision: "cli-invalid-v1",
          partition: "tuning",
          labels: [{ queryId: "q1", classification: "ambiguous", reviewed: true }],
        })}\n`,
      );

      const result = spawnSync(
        "pnpm",
        [
          "--silent",
          "replay:lexical",
          "--",
          "--corpus",
          corpusPath,
          "--queries",
          queriesPath,
          "--truth",
          truthPath,
          "--partition",
          "tuning",
        ],
        { cwd: process.cwd(), encoding: "utf8" },
      );
      const report: unknown = JSON.parse(result.stdout);

      expect({ status: result.status, report }).toMatchObject({
        status: 2,
        report: {
          validation: {
            valid: false,
            reviewRequired: true,
            issues: [{ code: "ambiguous-label", queryId: "q1" }],
          },
        },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
