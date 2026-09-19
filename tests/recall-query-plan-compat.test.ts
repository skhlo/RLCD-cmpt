import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Entry } from "../src/om/ledger/types.js";
import * as searchEntries from "../src/core/search-entries.js";
import { registerVccRecallCommand } from "../src/commands/vcc-recall.js";
import { registerRecallTool } from "../src/tools/recall.js";

interface SessionMessage {
  role: string;
  content: unknown;
}

interface SessionFixture {
  dir: string;
  file: string;
  branch: Entry[];
}

interface SessionManagerFixture {
  getSessionFile(): string;
  getBranch(): Entry[];
  getEntries(): Entry[];
}

interface CommandContextFixture {
  sessionManager: SessionManagerFixture;
  ui: {
    notify(message: string, level: string): void;
  };
}

type CommandHandler = (args: string, ctx: CommandContextFixture) => Promise<void>;

interface CommandRegistrationFixture {
  handler: CommandHandler;
}

interface RecallParams {
  query?: string;
  expand?: number[];
  page?: number;
  scope?: "lineage" | "all";
  mode?: "hybrid" | "file" | "touched";
}

interface ToolContextFixture {
  sessionManager: SessionManagerFixture;
}

type ToolExecute = (
  toolCallId: string,
  params: RecallParams,
  signal: AbortSignal | undefined,
  onUpdate: undefined,
  ctx: ToolContextFixture,
) => Promise<unknown>;

interface ToolRegistrationFixture {
  execute: ToolExecute;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object";

const isCommandRegistration = (value: unknown): value is CommandRegistrationFixture =>
  isRecord(value) && typeof value.handler === "function";

const isToolRegistration = (value: unknown): value is ToolRegistrationFixture =>
  isRecord(value) && typeof value.execute === "function";

const textFromToolResult = (value: unknown): string => {
  if (!isRecord(value) || !Array.isArray(value.content)) {
    throw new Error("expected a tool result with content");
  }
  const [first] = value.content;
  if (!isRecord(first) || first.type !== "text" || typeof first.text !== "string") {
    throw new Error("expected a text tool result");
  }
  return first.text;
};

const createSession = (messages: SessionMessage[], branch?: Entry[]): SessionFixture => {
  const dir = mkdtempSync(join(tmpdir(), "pi-recall-query-plan-"));
  const file = join(dir, "session.jsonl");
  const entries: Entry[] = messages.map((message, index) => ({
    type: "message",
    id: `m${index}`,
    message,
  }));
  const lines = entries.map((entry) => JSON.stringify(entry));
  writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
  return { dir, file, branch: branch ?? entries };
};

const createSessionManager = (session: SessionFixture): SessionManagerFixture => ({
  getSessionFile: () => session.file,
  getBranch: () => session.branch,
  getEntries: () => session.branch,
});

const invokeCommand = async (
  messages: SessionMessage[],
  args: string,
  branch?: Entry[],
): Promise<string> => {
  const session = createSession(messages, branch);
  try {
    let handler: CommandHandler | undefined;
    const sent: string[] = [];
    const pi: Pick<ExtensionAPI, "registerCommand" | "sendMessage"> = {
      registerCommand(name: string, options: unknown): void {
        if (name === "blackhole-recall" && isCommandRegistration(options)) {
          handler = options.handler;
        }
      },
      sendMessage(message: unknown): void {
        if (!isRecord(message) || typeof message.content !== "string") {
          throw new Error("expected a command message with string content");
        }
        sent.push(message.content);
      },
    };
    registerVccRecallCommand(pi);
    if (!handler) throw new Error("blackhole-recall command was not registered");

    const ctx: CommandContextFixture = {
      sessionManager: createSessionManager(session),
      ui: { notify: () => undefined },
    };
    await handler(args, ctx);
    const [output] = sent;
    if (sent.length !== 1 || output === undefined) {
      throw new Error(`expected one command message, received ${sent.length}`);
    }
    return output;
  } finally {
    rmSync(session.dir, { recursive: true });
  }
};

const invokeTool = async (
  messages: SessionMessage[],
  params: RecallParams,
  branch?: Entry[],
): Promise<string> => {
  const session = createSession(messages, branch);
  try {
    let execute: ToolExecute | undefined;
    const pi: Pick<ExtensionAPI, "registerTool"> = {
      registerTool(tool: unknown): void {
        if (isToolRegistration(tool)) execute = tool.execute;
      },
    };
    registerRecallTool(pi);
    if (!execute) throw new Error("recall tool was not registered");

    const result = await execute("tool-call", params, undefined, undefined, {
      sessionManager: createSessionManager(session),
    });
    return textFromToolResult(result);
  } finally {
    rmSync(session.dir, { recursive: true });
  }
};

const textMessages: SessionMessage[] = [
  { role: "user", content: "first recent message" },
  { role: "assistant", content: "second recent message" },
];

const literalMessages: SessionMessage[] = [
  { role: "user", content: "saved observer.ts" },
  { role: "assistant", content: "saved observerXts" },
];

const regexMessages: SessionMessage[] = [
  { role: "user", content: "color choice" },
  { role: "assistant", content: "colour choice" },
];

const fileMessages: SessionMessage[] = [
  {
    role: "assistant",
    content: [
      { type: "text", text: "described stored token" },
      {
        type: "toolCall",
        id: "write-1",
        name: "write",
        arguments: { path: "src/auth.ts", content: "const storedToken = true;" },
      },
    ],
  },
];

const touchedMessages: SessionMessage[] = [
  {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "write-1",
        name: "write",
        arguments: { path: "src/auth.ts", content: "one\ntwo" },
      },
    ],
  },
  {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "edit-1",
        name: "edit",
        arguments: { path: "src/auth.ts", oldText: "one", newText: "three" },
      },
      {
        type: "toolCall",
        id: "write-2",
        name: "write",
        arguments: { path: "src/other.ts", content: "four" },
      },
    ],
  },
];

const paginationMessages: SessionMessage[] = Array.from({ length: 6 }, (_, index) => ({
  role: "user",
  content: `pagehit ${index}`,
}));

const drilldownMessages: SessionMessage[] = [
  {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "write-1",
        name: "write",
        arguments: { path: "src/auth.ts", content: "line one\nline two\nline three" },
      },
    ],
  },
];

const expansionMessages: SessionMessage[] = [
  { role: "user", content: "needle first" },
  { role: "assistant", content: "expanded second" },
];

const sourceMessages: SessionMessage[] = [{ role: "user", content: "source evidence" }];
const sourceBranch: Entry[] = [
  { type: "message", id: "m0", message: sourceMessages[0] },
  {
    type: "custom",
    id: "observation-record",
    customType: "om.observations.recorded",
    data: {
      observations: [
        {
          id: "abcdef123456",
          content: "Remembered source fact",
          timestamp: "2026-01-02 03:04",
          relevance: "high",
          sourceEntryIds: ["m0"],
          tokenCount: 3,
        },
      ],
      coversUpToId: "m0",
    },
  },
];

interface SharedRouteCase {
  label: string;
  messages: SessionMessage[];
  commandArgs: string;
  toolParams: RecallParams;
  commandOutput: string;
  toolOutput: string;
}

const sharedRouteCases: SharedRouteCase[] = [
  {
    label: "recent history",
    messages: textMessages,
    commandArgs: "",
    toolParams: {},
    commandOutput:
      "Session history (2 entries):\n\n#0 [user] first recent message\n\n#1 [assistant] second recent message",
    toolOutput:
      "Session history (2 entries):\n\n#0 [user] first recent message\n\n#1 [assistant] second recent message",
  },
  {
    label: "a dotted-filename literal",
    messages: literalMessages,
    commandArgs: "observer.ts",
    toolParams: { query: "observer.ts" },
    commandOutput: '1 matches for "observer.ts":\n\n#0 [user] saved observer.ts',
    toolOutput: '1 matches for "observer.ts":\n\n#0 [user] saved observer.ts',
  },
  {
    label: "a question-mark regex",
    messages: regexMessages,
    commandArgs: "colou?r",
    toolParams: { query: "colou?r" },
    commandOutput:
      '2 matches for "colou?r":\n\n#0 [user] color choice\n\n#1 [assistant] colour choice',
    toolOutput:
      '2 matches for "colou?r":\n\n#0 [user] color choice\n\n#1 [assistant] colour choice',
  },
  {
    label: "file mode",
    messages: fileMessages,
    commandArgs: "storedToken mode:file",
    toolParams: { query: "storedToken", mode: "file" },
    commandOutput:
      '1 matches for "storedToken":\n\n#0 [assistant]\n  const storedToken = true;\n\n  [write] src/auth.ts — 1 match    use #0:src/auth.ts\n    | const storedToken = true;',
    toolOutput:
      '1 matches for "storedToken":\n\n#0 [assistant]\n  const storedToken = true;\n\n  [write] src/auth.ts — 1 match    use #0:src/auth.ts\n    | const storedToken = true;',
  },
  {
    label: "touched mode",
    messages: touchedMessages,
    commandArgs: "mode:touched",
    toolParams: { mode: "touched" },
    commandOutput:
      "2 files touched:\n\n  src/auth.ts    #0 (write), #1 (edit)\n  src/other.ts    #1 (write)",
    toolOutput:
      "2 files touched:\n\n  src/auth.ts    #0 (write), #1 (edit)\n\n  src/other.ts    #1 (write)",
  },
  {
    label: "page two",
    messages: paginationMessages,
    commandArgs: "pagehit page:2",
    toolParams: { query: "pagehit", page: 2 },
    commandOutput: 'Page 2/2 (6 total matches) for "pagehit":\n\n#5 [user] pagehit 5',
    toolOutput: 'Page 2/2 (6 matches) for "pagehit":\n\n#5 [user] pagehit 5',
  },
];

for (const routeCase of sharedRouteCases) {
  it(`preserves /blackhole-recall output for ${routeCase.label}`, async () => {
    expect(await invokeCommand(routeCase.messages, routeCase.commandArgs)).toBe(
      routeCase.commandOutput,
    );
  });

  it(`preserves recall-tool output for ${routeCase.label}`, async () => {
    expect(await invokeTool(routeCase.messages, routeCase.toolParams)).toBe(routeCase.toolOutput);
  });
}

it("preserves recall-tool source-ID output", async () => {
  expect(await invokeTool(sourceMessages, { query: "abcdef123456" }, sourceBranch)).toBe(
    "[abcdef123456] 2026-01-02 03:04 [high] Remembered source fact\n\n" +
      "Sources:\n\n(at index #0)\n\n[User @ Unknown time]: source evidence",
  );
});

it("preserves recall-tool drilldown output", async () => {
  expect(await invokeTool(drilldownMessages, { query: "#0:auth.ts" })).toBe(
    "File: src/auth.ts\nTool: write\n\nline one\nline two\nline three",
  );
});

it("preserves recall-tool explicit-expansion output", async () => {
  expect(await invokeTool(expansionMessages, { query: "#1" })).toBe(
    "Session history (1 entries):\n\n#1 [assistant] expanded second",
  );
});

it("preserves recall-tool mixed query-plus-expand output", async () => {
  expect(await invokeTool(expansionMessages, { query: "needle", expand: [1] })).toBe(
    '1 matches (+ 1 expanded) for "needle":\n\n' +
      "#0 [user] needle first\n\n#1 [assistant] expanded second",
  );
});

describe("registered recall callers", () => {
  it("passes each real parser-owned plan to the real planned search", async () => {
    const planner = vi.spyOn(searchEntries, "planSearchQuery");
    const plannedSearch = vi.spyOn(searchEntries, "searchEntriesDetailedWithPlan");

    try {
      await invokeCommand(literalMessages, "observer.ts");
      await invokeTool(literalMessages, { query: "observer.ts" });

      const created = planner.mock.results.map((result) => {
        if (result.type !== "return" || !result.value) {
          throw new Error("expected the real planner to return a query plan");
        }
        return result.value;
      });
      expect({
        created: created.map((plan) => ({
          query: plan.query,
          intent: plan.intent,
          eligibleForReranking: plan.eligibleForReranking,
        })),
        consumedOwnPlan: plannedSearch.mock.calls.map((args, index) => args[2] === created[index]),
      }).toEqual({
        created: [
          { query: "observer.ts", intent: "literal", eligibleForReranking: true },
          { query: "observer.ts", intent: "literal", eligibleForReranking: true },
        ],
        consumedOwnPlan: [true, true],
      });
    } finally {
      planner.mockRestore();
      plannedSearch.mockRestore();
    }
  });
});
