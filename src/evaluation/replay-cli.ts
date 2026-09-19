#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import {
  ReplayFixtureError,
  readReplayFixture,
  sha256File,
  type ReplayInputPaths,
  type ReplayPartition,
} from "./replay-fixture.js";
import { evaluateLexicalReplay } from "./lexical-replay.js";

interface CliOptions {
  readonly paths: ReplayInputPaths;
  readonly partition: ReplayPartition;
}

const usage = `Usage: replay-evaluator --corpus <session.jsonl> --queries <queries.json> --truth <truth.json> --partition <tuning|held-out>

Runs the unchanged lexical recall search over one explicit synthetic fixture partition.
The JSON report is written to stdout; invalid truth remains visible and exits with status 2.
`;

const parseCliOptions = (args: readonly string[]): CliOptions => {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--" && index === 0) continue;
    if (flag === "--help" || flag === "-h") {
      process.stdout.write(usage);
      process.exit(0);
    }
    if (!flag || !["--corpus", "--queries", "--truth", "--partition"].includes(flag)) {
      throw new ReplayFixtureError(`Unknown argument ${JSON.stringify(flag)}\n${usage}`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new ReplayFixtureError(`Missing value for ${flag}\n${usage}`);
    }
    if (values.has(flag)) {
      throw new ReplayFixtureError(`Duplicate argument ${flag}`);
    }
    values.set(flag, value);
    index++;
  }

  const corpus = values.get("--corpus");
  const queries = values.get("--queries");
  const truth = values.get("--truth");
  const partition = values.get("--partition");
  if (!corpus || !queries || !truth || !partition) {
    throw new ReplayFixtureError(`All four arguments are required\n${usage}`);
  }
  if (partition !== "tuning" && partition !== "held-out") {
    throw new ReplayFixtureError("--partition must be tuning or held-out");
  }
  return { paths: { corpus, queries, truth }, partition };
};

const main = (): void => {
  try {
    const options = parseCliOptions(process.argv.slice(2));
    const fixture = readReplayFixture(options.paths, options.partition);
    const report = evaluateLexicalReplay(fixture, {
      provenance: "executable-sha256",
      executableSha256: sha256File(fileURLToPath(import.meta.url)),
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.validation.valid) process.exitCode = 2;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`replay-evaluator: ${message}\n`);
    process.exitCode = 1;
  }
};

main();
