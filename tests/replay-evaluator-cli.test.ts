import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

interface CliFixture {
  readonly dir: string;
  readonly corpusPath: string;
  readonly queriesPath: string;
  readonly truthPath: string;
}

const cliPath = join(process.cwd(), "dist", "replay-evaluator.js");

const answerableLabel = {
  queryId: "decision-query",
  classification: "answerable",
  answerEntryIds: ["answer-entry"],
  reviewed: true,
};

const writeCliFixture = (label: unknown = answerableLabel): CliFixture => {
  const dir = mkdtempSync(join(tmpdir(), "blackhole-replay-cli-"));
  const corpusPath = join(dir, "corpus.jsonl");
  const queriesPath = join(dir, "queries.json");
  const truthPath = join(dir, "truth.json");

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
      labels: [label],
    })}\n`,
  );

  return { dir, corpusPath, queriesPath, truthPath };
};

const fixtureArgs = (fixture: CliFixture): string[] => [
  "--corpus",
  fixture.corpusPath,
  "--queries",
  fixture.queriesPath,
  "--truth",
  fixture.truthPath,
  "--partition",
  "tuning",
];

const withoutArgument = (args: readonly string[], omittedFlag: string): string[] => {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === undefined || value === undefined) {
      throw new Error("CLI test arguments must be flag-value pairs");
    }
    if (flag !== omittedFlag) result.push(flag, value);
  }
  return result;
};

const runCli = (args: readonly string[]) =>
  spawnSync(process.execPath, [cliPath, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  });

const withCliFixture = <T>(run: (fixture: CliFixture) => T, label?: unknown): T => {
  const fixture = writeCliFixture(label);
  try {
    return run(fixture);
  } finally {
    rmSync(fixture.dir, { recursive: true });
  }
};

beforeAll(() => {
  const result = spawnSync("pnpm", ["build"], { cwd: process.cwd(), encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`CLI build failed:\n${result.stdout}\n${result.stderr}`);
  }
});

describe("lexical replay CLI", () => {
  it("reports a known answer found by the shared lexical search", () => {
    withCliFixture((fixture) => {
      const result = runCli(fixtureArgs(fixture));
      const report: unknown = JSON.parse(result.stdout);
      const executableSha256 = createHash("sha256").update(readFileSync(cliPath)).digest("hex");

      expect({ status: result.status, report }).toMatchObject({
        status: 0,
        report: {
          manifestVersion: 1,
          implementation: {
            provenance: "executable-sha256",
            executableSha256,
          },
          fixture: { revision: "cli-test-v1", partition: "tuning" },
          aggregate: {
            candidateCoverage: { hits: 1, denominator: 1, rate: 1 },
            answerAt5: { hits: 1, denominator: 1, rate: 1 },
            meanReciprocalRank: { denominator: 1, value: 1 },
          },
        },
      });
    });
  });

  it("emits malformed no-answer evidence for review and exits with status 2", () => {
    withCliFixture(
      (fixture) => {
        const result = runCli(fixtureArgs(fixture));
        const report: unknown = JSON.parse(result.stdout);

        expect({ status: result.status, report }).toMatchObject({
          status: 2,
          report: {
            validation: {
              valid: false,
              reviewRequired: true,
              issues: [{ code: "contradictory-label", queryId: "decision-query" }],
            },
          },
        });
      },
      {
        queryId: "decision-query",
        classification: "no-answer",
        answerEntryIds: "answer-entry",
        reviewed: true,
      },
    );
  });

  it("accepts one leading argument separator", () => {
    withCliFixture((fixture) => {
      expect(runCli(["--", ...fixtureArgs(fixture)]).status).toBe(0);
    });
  });

  it.each(["--help", "-h"])("prints usage for %s", (helpFlag) => {
    const result = runCli([helpFlag]);
    expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toMatchObject({
      status: 0,
      stdout: expect.stringContaining("Usage: replay-evaluator"),
      stderr: "",
    });
  });

  it.each(["--unknown", "positional", ""])("rejects unknown argument %j", (argument) => {
    const result = runCli([argument]);
    expect({ status: result.status, stderr: result.stderr }).toMatchObject({
      status: 1,
      stderr: expect.stringContaining(`Unknown argument ${JSON.stringify(argument)}`),
    });
  });

  it.each([
    ["a trailing flag", ["--corpus"]],
    ["another flag in value position", ["--corpus", "--queries"]],
  ])("rejects a missing value from %s", (_caseName, args) => {
    const result = runCli(args);
    expect({ status: result.status, stderr: result.stderr }).toMatchObject({
      status: 1,
      stderr: expect.stringContaining("Missing value for --corpus"),
    });
  });

  it("rejects a duplicate argument", () => {
    withCliFixture((fixture) => {
      const result = runCli(["--corpus", fixture.corpusPath, "--corpus", fixture.corpusPath]);
      expect({ status: result.status, stderr: result.stderr }).toMatchObject({
        status: 1,
        stderr: expect.stringContaining("Duplicate argument --corpus"),
      });
    });
  });

  it.each(["--corpus", "--queries", "--truth", "--partition"])(
    "rejects an invocation missing %s",
    (omittedFlag) => {
      withCliFixture((fixture) => {
        const result = runCli(withoutArgument(fixtureArgs(fixture), omittedFlag));
        expect({ status: result.status, stderr: result.stderr }).toMatchObject({
          status: 1,
          stderr: expect.stringContaining("All four arguments are required"),
        });
      });
    },
  );

  it("rejects an invalid partition", () => {
    withCliFixture((fixture) => {
      const args = fixtureArgs(fixture);
      args[args.length - 1] = "private";
      const result = runCli(args);
      expect({ status: result.status, stderr: result.stderr }).toMatchObject({
        status: 1,
        stderr: expect.stringContaining("--partition must be tuning or held-out"),
      });
    });
  });
});
