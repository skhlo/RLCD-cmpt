import { createHash } from "node:crypto";
import type { SearchHit } from "../core/search-entries.js";
import { planSearchQuery, searchEntriesDetailedWithPlan } from "../core/search-entries.js";
import {
  JEV_BOUNDS,
  JEV_MODEL,
  JEV_PROMPT,
  JEV_PROMPT_VERSION,
  JEV_RESPONSE_CONTRACT_VERSION,
  prepareJevRequest,
  rankPreparedCandidates,
  validateJevResponse,
  type JevRequestMeasurements,
  type PreparedJevRequest,
} from "./jev-contract.js";
import {
  evaluateLexicalReplay,
  type AnswerableReplayCaseReport,
  type LexicalReplayReport,
  type ReplayImplementationProvenance,
} from "./lexical-replay.js";
import type { ReplayFixture, ReplayFixtureCase } from "./replay-fixture.js";
import { TypeSafeHttpError, type JevTransport } from "./typesafe-http.js";

export type JevEvaluationInputKind = "synthetic" | "private-reviewed";
export type JevEvaluationPhase = "calibration" | "held-out";

export const JEV_EVALUATION_THRESHOLDS = Object.freeze({
  calibrationMinimumObservedRequests: 10,
  estimatorMaximumUnderestimateRatio: 0,
  candidateCoverageMinimum: 0.9,
  answerAt5NetImprovementMinimum: 0.05,
  answerAt5MinimumPromotions: 2,
  meanReciprocalRankMinimumDelta: 0,
  consequentialFirstPageRegressionMaximum: 0,
  noAnswerHighSupportThreshold: 0.9,
  noAnswerHighSupportMaximum: 0,
  adversarialHighSupportThreshold: 0.9,
  adversarialHighSupportMaximum: 0,
  completeWithinDeadlineRateMinimum: 0.95,
  addedLatencyP95MaximumMs: 1_000,
  cooperativeDeadlineMaximumMs: JEV_BOUNDS.proposed.cooperativeDeadlineMs,
} as const);

export const JEV_PRICE = Object.freeze({
  inputUsdPerMillionTokens: 0.042,
  outputTokensFree: true,
  provenance: "https://docs.typesafe.ai/models.md#current-models (retrieved 2026-09-19 UTC)",
  contractualQuote: false,
});

interface FrozenEvaluationInput {
  readonly kind: JevEvaluationInputKind;
  readonly tuning: {
    readonly revision: string;
    readonly inputSha256: ReplayFixture["digests"];
  };
  readonly heldOut: {
    readonly inputSha256: ReplayFixture["digests"];
  };
}

interface PreparationCase {
  readonly queryId: string;
  readonly result: "prepared" | "no-candidates" | "rejected" | "invalid";
  readonly candidateCount: number;
  readonly requestSha256?: string;
  readonly measurements?: JevRequestMeasurements;
  readonly issues?: readonly string[];
}

export interface JevEvaluationPlan {
  readonly manifestVersion: 1;
  readonly evaluator: "jev-evaluation-plan-v1";
  readonly freezeSha256: string;
  readonly implementation: ReplayImplementationProvenance;
  readonly input: FrozenEvaluationInput;
  readonly contract: {
    readonly model: typeof JEV_MODEL;
    readonly promptVersion: typeof JEV_PROMPT_VERSION;
    readonly prompt: {
      readonly instructionsTemplate: string;
      readonly criteria: typeof JEV_PROMPT.criteria;
    };
    readonly responseContractVersion: typeof JEV_RESPONSE_CONTRACT_VERSION;
    readonly bounds: typeof JEV_BOUNDS;
    readonly tokenEstimateIsExact: false;
    readonly liveShadowEvaluationsRequiredForOfflineEvaluator: false;
  };
  readonly thresholds: typeof JEV_EVALUATION_THRESHOLDS;
  readonly pricing: typeof JEV_PRICE;
  readonly preparation: {
    readonly status: "READY_FOR_CALIBRATION" | "BLOCKED";
    readonly preparedQueries: number;
    readonly noCandidateQueries: number;
    readonly failedQueries: number;
    readonly cases: readonly PreparationCase[];
  };
  readonly gates: {
    readonly status: "BLOCKED";
    readonly reasons: readonly string[];
  };
}

export interface JevEvaluationApproval {
  readonly evidenceSha256: string;
  readonly transmissionApproved: boolean;
  readonly privateAccountTermsAccepted: boolean;
  readonly localRawEvidenceRetentionDays: number;
  readonly localRetentionExtensionReference: string | null;
}

export interface QualifiedCalibrationEvidence {
  readonly evidenceSha256: string;
  readonly planSha256: string;
  readonly source: "native-api";
  readonly inputKind: "private-reviewed";
  readonly observedUsageResponses: number;
  readonly readyForHeldOut: true;
}

export interface EvaluateJevReplayOptions {
  readonly phase: JevEvaluationPhase;
  readonly transport?: JevTransport;
  readonly apiKey?: string;
  readonly approval?: JevEvaluationApproval;
  readonly calibration?: QualifiedCalibrationEvidence;
  readonly implementation: ReplayImplementationProvenance;
  readonly now?: () => number;
  readonly signal?: AbortSignal;
}

export interface JevReplayCaseReport {
  readonly queryId: string;
  readonly query: string;
  readonly category: string;
  readonly lexical: {
    readonly outcome: string;
    readonly candidateEntryIds: readonly string[];
    readonly bestKnownAnswerRank: number | null;
    readonly candidateMissReason: string | null;
  };
  readonly semantic: {
    readonly result: "reranked" | "lexical-fallback";
    readonly fallbackReason: string | null;
    readonly candidateEntryIds: readonly string[];
    readonly bestKnownAnswerRank: number | null;
    readonly scores: readonly {
      readonly entryId: string;
      readonly noul: number;
    }[];
    readonly usage: {
      readonly inputTokens: number;
      readonly outputTokens: number;
    } | null;
    readonly usageIssue: "invalid-usage" | null;
    readonly requestSha256: string | null;
    readonly transmittedRequest: PreparedJevRequest["request"] | null;
    readonly requestMeasurements: JevRequestMeasurements | null;
    readonly timingMs: {
      readonly preparation: number;
      readonly transport: number;
      readonly totalAdded: number;
    };
    readonly estimatorError: {
      readonly estimatedInputTokens: number;
      readonly actualInputTokens: number;
      readonly actualMinusEstimatedTokens: number;
      readonly underestimateRatio: number;
    } | null;
  };
}

interface ComparisonDisagreement {
  readonly queryId: string;
  readonly lexicalCandidateEntryIds: readonly string[];
  readonly semanticCandidateEntryIds: readonly string[];
  readonly reviewStatus: "pending";
}

export interface JevReplayReport {
  readonly manifestVersion: 1;
  readonly evaluator: "jev-replay-v1";
  readonly phase: JevEvaluationPhase;
  readonly planSha256: string;
  readonly implementation: ReplayImplementationProvenance;
  readonly fixture: {
    readonly revision: string;
    readonly partition: ReplayFixture["partition"];
    readonly inputSha256: ReplayFixture["digests"];
    readonly inputKind: JevEvaluationInputKind;
  };
  readonly lexicalBaseline: LexicalReplayReport;
  readonly evidence: {
    readonly source: "none" | JevTransport["evidenceSource"];
    readonly approvalEvidenceSha256: string | null;
    readonly calibrationEvidenceSha256: string | null;
    readonly localRawEvidenceRetentionDays: number | null;
    readonly localRetentionExtensionReference: string | null;
    readonly actualApiUsage: boolean;
    readonly estimatorCalibrationAccepted: boolean;
    readonly price: typeof JEV_PRICE;
  };
  readonly operations: {
    readonly eligibleEvaluations: number;
    readonly attemptedRequests: number;
    readonly validJudgments: number;
    readonly completeWithinDeadline: number;
    readonly responsesWithValidUsage: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly estimatedInputCostUsd: number;
    readonly estimatorError: {
      readonly maximumUnderestimateRatio: number | null;
      readonly meanActualMinusEstimatedTokens: number | null;
    };
    readonly latencyMs: {
      readonly p50: number | null;
      readonly p95: number | null;
      readonly maximum: number | null;
      readonly cooperativeDeadlineOverruns: number;
    };
    readonly failures: readonly { readonly queryId: string; readonly reason: string }[];
  };
  readonly comparison: {
    readonly candidateMisses: number;
    readonly candidateMissDetails: readonly {
      readonly queryId: string;
      readonly reason: string | null;
    }[];
    readonly lexicalRankMisses: number;
    readonly semanticRankMisses: number;
    readonly lexicalAnswerAt5: number | null;
    readonly semanticAnswerAt5: number | null;
    readonly answerAt5NetImprovement: number | null;
    readonly lexicalMeanReciprocalRank: number | null;
    readonly semanticMeanReciprocalRank: number | null;
    readonly meanReciprocalRankDelta: number | null;
    readonly promotionsIntoTop5: number;
    readonly rankRegressions: readonly {
      readonly queryId: string;
      readonly category: string;
      readonly lexicalRank: number;
      readonly semanticRank: number | null;
      readonly consequential: boolean;
      readonly reviewStatus: "pending";
    }[];
    readonly firstPageRegressions: readonly {
      readonly queryId: string;
      readonly category: string;
      readonly lexicalRank: number;
      readonly semanticRank: number | null;
      readonly consequential: boolean;
      readonly reviewStatus: "pending";
    }[];
    readonly disagreements: readonly ComparisonDisagreement[];
    readonly noAnswerHighSupport: readonly {
      readonly queryId: string;
      readonly entryId: string;
      readonly noul: number;
    }[];
    readonly adversarialCases: number;
    readonly adversarialHighSupport: readonly {
      readonly queryId: string;
      readonly entryId: string;
      readonly noul: number;
    }[];
  };
  readonly cases: readonly JevReplayCaseReport[];
  readonly gates: {
    readonly status: "PASS" | "BLOCKED";
    readonly readyForHeldOut: boolean;
    readonly reasons: readonly string[];
  };
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const requestSha256 = (prepared: PreparedJevRequest): string =>
  sha256(`${prepared.body}\n${JSON.stringify(prepared.binding)}`);
const round = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;
const roundCost = (value: number): number =>
  Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
const equalIds = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((id, index) => id === right[index]);

const transportFailureReason = (error: unknown): string => {
  if (error instanceof TypeSafeHttpError) {
    return error.status === undefined
      ? `transport-${error.code}`
      : `transport-${error.code}-${error.status}`;
  }
  if (error instanceof Error && error.name === "AbortError") return "transport-aborted";
  return "transport-failure";
};

const fixtureCaseHits = (
  fixture: ReplayFixture,
  fixtureCase: ReplayFixtureCase,
): readonly SearchHit[] => {
  const plan = planSearchQuery(fixtureCase.query.text);
  if (!plan || !plan.eligibleForReranking) return [];
  return searchEntriesDetailedWithPlan(
    fixture.rendered,
    fixture.rawMessages,
    plan,
    undefined,
    "hybrid",
  ).hits;
};

const preparationCases = (fixture: ReplayFixture): readonly PreparationCase[] =>
  fixture.cases.map((fixtureCase) => {
    if (fixtureCase.truth.classification === "invalid") {
      return {
        queryId: fixtureCase.query.id,
        result: "invalid",
        candidateCount: 0,
        issues: fixtureCase.truth.issues.map(({ code }) => code),
      };
    }
    const hits = fixtureCaseHits(fixture, fixtureCase);
    if (hits.length === 0) {
      return { queryId: fixtureCase.query.id, result: "no-candidates", candidateCount: 0 };
    }
    const prepared = prepareJevRequest(fixtureCase.query.text, hits);
    if (!prepared.ok) {
      return {
        queryId: fixtureCase.query.id,
        result: "rejected",
        candidateCount: hits.length,
        measurements: prepared.measurements,
        issues: prepared.issues.map(({ code }) => code),
      };
    }
    return {
      queryId: fixtureCase.query.id,
      result: "prepared",
      candidateCount: hits.length,
      requestSha256: requestSha256(prepared),
      measurements: prepared.measurements,
    };
  });

export const createJevEvaluationPlan = (options: {
  readonly tuningFixture: ReplayFixture;
  readonly heldOutInputSha256: ReplayFixture["digests"];
  readonly inputKind: JevEvaluationInputKind;
  readonly implementation: ReplayImplementationProvenance;
}): JevEvaluationPlan => {
  if (options.tuningFixture.partition !== "tuning") {
    throw new Error("The evaluation plan must be frozen from a tuning fixture");
  }
  if (
    options.tuningFixture.revision === "public-synthetic-v1" &&
    options.inputKind !== "synthetic"
  ) {
    throw new Error("The committed public synthetic fixture must use synthetic input provenance");
  }
  const cases = preparationCases(options.tuningFixture);
  const failedQueries = cases.filter(
    ({ result }) => result === "rejected" || result === "invalid",
  ).length;
  const input: FrozenEvaluationInput = {
    kind: options.inputKind,
    tuning: {
      revision: options.tuningFixture.revision,
      inputSha256: options.tuningFixture.digests,
    },
    heldOut: { inputSha256: options.heldOutInputSha256 },
  };
  const contract = {
    model: JEV_MODEL,
    promptVersion: JEV_PROMPT_VERSION,
    prompt: {
      instructionsTemplate: JEV_PROMPT.instructions(0).replace("candidates[0]", "candidates[i]"),
      criteria: JEV_PROMPT.criteria,
    },
    responseContractVersion: JEV_RESPONSE_CONTRACT_VERSION,
    bounds: JEV_BOUNDS,
    tokenEstimateIsExact: false as const,
    liveShadowEvaluationsRequiredForOfflineEvaluator: false as const,
  };
  const frozen = {
    implementation: options.implementation,
    input,
    contract,
    thresholds: JEV_EVALUATION_THRESHOLDS,
    pricing: JEV_PRICE,
  };
  const reasons = ["real-api-calibration-missing", "held-out-evaluation-missing"];
  if (options.inputKind === "synthetic") {
    reasons.push("synthetic-input-cannot-pass-empirical-gates");
  }
  if (failedQueries > 0) reasons.push("preparation-failures-present");

  return {
    manifestVersion: 1,
    evaluator: "jev-evaluation-plan-v1",
    freezeSha256: sha256(JSON.stringify(frozen)),
    implementation: options.implementation,
    input,
    contract,
    thresholds: JEV_EVALUATION_THRESHOLDS,
    pricing: JEV_PRICE,
    preparation: {
      status: failedQueries === 0 ? "READY_FOR_CALIBRATION" : "BLOCKED",
      preparedQueries: cases.filter(({ result }) => result === "prepared").length,
      noCandidateQueries: cases.filter(({ result }) => result === "no-candidates").length,
      failedQueries,
      cases,
    },
    gates: { status: "BLOCKED", reasons },
  };
};

const percentile = (values: readonly number[], probability: number): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * probability) - 1);
  return round(sorted[index]);
};

const bestRank = (candidateIds: readonly string[], answerIds: readonly string[]): number | null => {
  const answers = new Set(answerIds);
  const index = candidateIds.findIndex((id) => answers.has(id));
  return index === -1 ? null : index + 1;
};

const inputMatchesPlan = (
  fixture: ReplayFixture,
  plan: JevEvaluationPlan,
  phase: JevEvaluationPhase,
): boolean => {
  if (fixture.revision === "public-synthetic-v1" && plan.input.kind !== "synthetic") {
    return false;
  }
  const expected =
    phase === "calibration" ? plan.input.tuning.inputSha256 : plan.input.heldOut.inputSha256;
  return (Object.keys(expected) as Array<keyof typeof expected>).every(
    (key) => fixture.digests[key] === expected[key],
  );
};

const dispatchBlockReason = (
  fixture: ReplayFixture,
  plan: JevEvaluationPlan,
  options: EvaluateJevReplayOptions,
): string | null => {
  if (!inputMatchesPlan(fixture, plan, options.phase)) return "input-provenance-mismatch";
  if (!options.transport) return "transmission-not-approved";
  if (options.transport.evidenceSource === "scripted") return null;
  if (!options.approval?.transmissionApproved) return "transmission-approval-required";
  if (plan.input.kind === "private-reviewed" && !options.approval.privateAccountTermsAccepted) {
    return "account-terms-acceptance-required";
  }
  if (options.phase === "held-out") {
    const calibration = options.calibration;
    if (
      !calibration ||
      calibration.readyForHeldOut !== true ||
      calibration.source !== "native-api" ||
      calibration.inputKind !== "private-reviewed" ||
      calibration.planSha256 !== plan.freezeSha256 ||
      calibration.observedUsageResponses <
        JEV_EVALUATION_THRESHOLDS.calibrationMinimumObservedRequests
    ) {
      return "qualified-calibration-required";
    }
  }
  if (!options.apiKey) return "credential-unavailable";
  return null;
};

const lexicalCaseById = (
  report: LexicalReplayReport,
): ReadonlyMap<string, LexicalReplayReport["cases"][number]> =>
  new Map(report.cases.map((caseReport) => [caseReport.queryId, caseReport]));

const lexicalProjection = (
  lexical: LexicalReplayReport["cases"][number] | undefined,
  hits: readonly SearchHit[],
): JevReplayCaseReport["lexical"] => {
  const candidateEntryIds = hits.map(({ id }) => id);
  if (!lexical) {
    return {
      outcome: "invalid",
      candidateEntryIds,
      bestKnownAnswerRank: null,
      candidateMissReason: null,
    };
  }
  return {
    outcome: lexical.outcome,
    candidateEntryIds,
    bestKnownAnswerRank: "bestKnownAnswerRank" in lexical ? lexical.bestKnownAnswerRank : null,
    candidateMissReason: "candidateMissReason" in lexical ? lexical.candidateMissReason : null,
  };
};

const fallbackCase = (
  fixtureCase: ReplayFixtureCase,
  lexical: JevReplayCaseReport["lexical"],
  reason: string,
  preparationMs = 0,
  totalAddedMs = 0,
  measurements: JevRequestMeasurements | null = null,
  requestHash: string | null = null,
  transmittedRequest: PreparedJevRequest["request"] | null = null,
): JevReplayCaseReport => ({
  queryId: fixtureCase.query.id,
  query: fixtureCase.query.text,
  category: fixtureCase.query.category,
  lexical,
  semantic: {
    result: "lexical-fallback",
    fallbackReason: reason,
    candidateEntryIds: lexical.candidateEntryIds,
    bestKnownAnswerRank: lexical.bestKnownAnswerRank,
    scores: [],
    usage: null,
    usageIssue: null,
    requestSha256: requestHash,
    transmittedRequest,
    requestMeasurements: measurements,
    timingMs: { preparation: round(preparationMs), transport: 0, totalAdded: round(totalAddedMs) },
    estimatorError: null,
  },
});

export const evaluateJevReplay = async (
  fixture: ReplayFixture,
  plan: JevEvaluationPlan,
  options: EvaluateJevReplayOptions,
): Promise<JevReplayReport> => {
  const now = options.now ?? (() => performance.now());
  const lexicalBaseline = evaluateLexicalReplay(fixture, options.implementation);
  const lexicalById = lexicalCaseById(lexicalBaseline);
  const globalBlock = dispatchBlockReason(fixture, plan, options);
  const failures: Array<{ queryId: string; reason: string }> = [];
  const cases: JevReplayCaseReport[] = [];
  const latencies: number[] = [];
  let eligibleEvaluations = 0;
  let attemptedRequests = 0;
  let validJudgments = 0;
  let completeWithinDeadline = 0;
  let responsesWithValidUsage = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  const estimatorDeltas: number[] = [];
  const underestimateRatios: number[] = [];

  for (const fixtureCase of fixture.cases) {
    const hits = fixtureCaseHits(fixture, fixtureCase);
    const lexical = lexicalProjection(lexicalById.get(fixtureCase.query.id), hits);
    if (fixtureCase.truth.classification === "invalid") {
      cases.push(fallbackCase(fixtureCase, lexical, "invalid-truth"));
      failures.push({ queryId: fixtureCase.query.id, reason: "invalid-truth" });
      continue;
    }
    if (hits.length === 0) {
      cases.push(fallbackCase(fixtureCase, lexical, "no-candidates"));
      continue;
    }
    eligibleEvaluations++;
    if (globalBlock) {
      cases.push(fallbackCase(fixtureCase, lexical, globalBlock));
      failures.push({ queryId: fixtureCase.query.id, reason: globalBlock });
      continue;
    }

    const startedAt = now();
    const prepared = prepareJevRequest(fixtureCase.query.text, hits);
    const preparedAt = now();
    const preparationMs = preparedAt - startedAt;
    if (!prepared.ok) {
      const reason = `preparation-${prepared.issues[0]?.code ?? "rejected"}`;
      cases.push(fallbackCase(fixtureCase, lexical, reason, preparationMs, now() - startedAt));
      failures.push({ queryId: fixtureCase.query.id, reason });
      continue;
    }
    const hash = requestSha256(prepared);
    const remainingMs = JEV_BOUNDS.proposed.cooperativeDeadlineMs - preparationMs;
    if (remainingMs <= 0) {
      cases.push(
        fallbackCase(
          fixtureCase,
          lexical,
          "preparation-deadline",
          preparationMs,
          now() - startedAt,
          prepared.measurements,
          hash,
        ),
      );
      failures.push({ queryId: fixtureCase.query.id, reason: "preparation-deadline" });
      continue;
    }

    const transport = options.transport;
    if (!transport) {
      cases.push(fallbackCase(fixtureCase, lexical, "transport-unavailable"));
      failures.push({ queryId: fixtureCase.query.id, reason: "transport-unavailable" });
      continue;
    }
    attemptedRequests++;
    const transportStartedAt = now();
    let transportResponse: Awaited<ReturnType<JevTransport["send"]>>;
    try {
      transportResponse = await transport.send({
        body: prepared.body,
        apiKey: options.apiKey ?? "scripted-transport",
        timeoutMs: remainingMs,
        responseMaxUtf8Bytes: JEV_BOUNDS.proposed.responseMaxUtf8Bytes,
        signal: options.signal,
      });
    } catch (error) {
      const reason = transportFailureReason(error);
      const totalAddedMs = now() - startedAt;
      latencies.push(totalAddedMs);
      cases.push(
        fallbackCase(
          fixtureCase,
          lexical,
          reason,
          preparationMs,
          totalAddedMs,
          prepared.measurements,
          hash,
          prepared.request,
        ),
      );
      failures.push({ queryId: fixtureCase.query.id, reason });
      continue;
    }
    const transportFinishedAt = now();
    const transportMs = transportFinishedAt - transportStartedAt;
    const totalBeforeValidation = transportFinishedAt - startedAt;
    const responseBytes = new TextEncoder().encode(transportResponse.body).byteLength;
    if (
      transportResponse.status < 200 ||
      transportResponse.status >= 300 ||
      responseBytes > JEV_BOUNDS.proposed.responseMaxUtf8Bytes
    ) {
      const reason =
        responseBytes > JEV_BOUNDS.proposed.responseMaxUtf8Bytes
          ? "response-too-large"
          : "transport-http-status";
      latencies.push(totalBeforeValidation);
      cases.push(
        fallbackCase(
          fixtureCase,
          lexical,
          reason,
          preparationMs,
          totalBeforeValidation,
          prepared.measurements,
          hash,
          prepared.request,
        ),
      );
      failures.push({ queryId: fixtureCase.query.id, reason });
      continue;
    }
    if (totalBeforeValidation > JEV_BOUNDS.proposed.cooperativeDeadlineMs) {
      latencies.push(totalBeforeValidation);
      cases.push(
        fallbackCase(
          fixtureCase,
          lexical,
          "deadline-overrun",
          preparationMs,
          totalBeforeValidation,
          prepared.measurements,
          hash,
          prepared.request,
        ),
      );
      failures.push({ queryId: fixtureCase.query.id, reason: "deadline-overrun" });
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(transportResponse.body);
    } catch {
      const totalAddedMs = now() - startedAt;
      latencies.push(totalAddedMs);
      cases.push(
        fallbackCase(
          fixtureCase,
          lexical,
          "response-json",
          preparationMs,
          totalAddedMs,
          prepared.measurements,
          hash,
          prepared.request,
        ),
      );
      failures.push({ queryId: fixtureCase.query.id, reason: "response-json" });
      continue;
    }
    const validated = validateJevResponse(parsed, prepared.binding);
    const validationCompletedMs = now() - startedAt;
    if (validationCompletedMs > JEV_BOUNDS.proposed.cooperativeDeadlineMs) {
      latencies.push(validationCompletedMs);
      cases.push(
        fallbackCase(
          fixtureCase,
          lexical,
          "deadline-overrun",
          preparationMs,
          validationCompletedMs,
          prepared.measurements,
          hash,
          prepared.request,
        ),
      );
      failures.push({ queryId: fixtureCase.query.id, reason: "deadline-overrun" });
      continue;
    }
    if (!validated.ok) {
      const reason = `response-${validated.reason}`;
      latencies.push(validationCompletedMs);
      cases.push(
        fallbackCase(
          fixtureCase,
          lexical,
          reason,
          preparationMs,
          validationCompletedMs,
          prepared.measurements,
          hash,
          prepared.request,
        ),
      );
      failures.push({ queryId: fixtureCase.query.id, reason });
      continue;
    }

    const reranked = rankPreparedCandidates(hits, validated.scoresByEntryId);
    const candidateEntryIds = reranked.map(({ id }) => id);
    const answerIds =
      fixtureCase.truth.classification === "answerable" ? fixtureCase.truth.answerEntryIds : [];
    const scores = prepared.binding.map(({ entryId }) => ({
      entryId,
      noul: validated.scoresByEntryId[entryId],
    }));
    const totalAddedMs = now() - startedAt;
    latencies.push(totalAddedMs);
    if (totalAddedMs > JEV_BOUNDS.proposed.cooperativeDeadlineMs) {
      cases.push(
        fallbackCase(
          fixtureCase,
          lexical,
          "deadline-overrun",
          preparationMs,
          totalAddedMs,
          prepared.measurements,
          hash,
          prepared.request,
        ),
      );
      failures.push({ queryId: fixtureCase.query.id, reason: "deadline-overrun" });
      continue;
    }

    validJudgments++;
    completeWithinDeadline++;
    let estimatorError: JevReplayCaseReport["semantic"]["estimatorError"] = null;
    if (validated.usage) {
      responsesWithValidUsage++;
      inputTokens += validated.usage.inputTokens;
      outputTokens += validated.usage.outputTokens;
      const delta = validated.usage.inputTokens - prepared.measurements.requestEstimatedInputTokens;
      const underestimateRatio =
        validated.usage.inputTokens === 0 ? 0 : Math.max(0, delta / validated.usage.inputTokens);
      estimatorDeltas.push(delta);
      underestimateRatios.push(underestimateRatio);
      estimatorError = {
        estimatedInputTokens: prepared.measurements.requestEstimatedInputTokens,
        actualInputTokens: validated.usage.inputTokens,
        actualMinusEstimatedTokens: delta,
        underestimateRatio: round(underestimateRatio),
      };
    }
    cases.push({
      queryId: fixtureCase.query.id,
      query: fixtureCase.query.text,
      category: fixtureCase.query.category,
      lexical,
      semantic: {
        result: "reranked",
        fallbackReason: null,
        candidateEntryIds,
        bestKnownAnswerRank: bestRank(candidateEntryIds, answerIds),
        scores,
        usage: validated.usage,
        usageIssue: validated.usageIssue,
        requestSha256: hash,
        transmittedRequest: prepared.request,
        requestMeasurements: prepared.measurements,
        timingMs: {
          preparation: round(preparationMs),
          transport: round(transportMs),
          totalAdded: round(totalAddedMs),
        },
        estimatorError,
      },
    });
  }

  const answerableCases = fixture.cases.filter(
    (fixtureCase) => fixtureCase.truth.classification === "answerable",
  );
  const answerableReports = answerableCases
    .map((fixtureCase) => cases.find(({ queryId }) => queryId === fixtureCase.query.id))
    .filter((caseReport): caseReport is JevReplayCaseReport => caseReport !== undefined);
  const denominator = answerableReports.length;
  const lexicalTop5 = answerableReports.filter(
    ({ lexical }) => lexical.bestKnownAnswerRank !== null && lexical.bestKnownAnswerRank <= 5,
  ).length;
  const semanticTop5 = answerableReports.filter(
    ({ semantic }) => semantic.bestKnownAnswerRank !== null && semantic.bestKnownAnswerRank <= 5,
  ).length;
  const lexicalMrrSum = answerableReports.reduce(
    (sum, { lexical }) =>
      sum + (lexical.bestKnownAnswerRank === null ? 0 : 1 / lexical.bestKnownAnswerRank),
    0,
  );
  const semanticMrrSum = answerableReports.reduce(
    (sum, { semantic }) =>
      sum + (semantic.bestKnownAnswerRank === null ? 0 : 1 / semantic.bestKnownAnswerRank),
    0,
  );
  const lexicalAnswerAt5 = denominator === 0 ? null : round(lexicalTop5 / denominator);
  const semanticAnswerAt5 = denominator === 0 ? null : round(semanticTop5 / denominator);
  const lexicalMrr = denominator === 0 ? null : round(lexicalMrrSum / denominator);
  const semanticMrr = denominator === 0 ? null : round(semanticMrrSum / denominator);
  const disagreements: ComparisonDisagreement[] = cases
    .filter(
      ({ lexical, semantic }) =>
        semantic.result === "reranked" &&
        !equalIds(lexical.candidateEntryIds, semantic.candidateEntryIds),
    )
    .map(({ queryId, lexical, semantic }) => ({
      queryId,
      lexicalCandidateEntryIds: lexical.candidateEntryIds,
      semanticCandidateEntryIds: semantic.candidateEntryIds,
      reviewStatus: "pending",
    }));
  const rankRegressions = cases
    .filter(
      ({ lexical, semantic }) =>
        lexical.bestKnownAnswerRank !== null &&
        (semantic.bestKnownAnswerRank === null ||
          semantic.bestKnownAnswerRank > lexical.bestKnownAnswerRank),
    )
    .map(({ queryId, category, lexical, semantic }) => ({
      queryId,
      category,
      lexicalRank: lexical.bestKnownAnswerRank ?? 0,
      semanticRank: semantic.bestKnownAnswerRank,
      consequential: ["correction", "constraint", "supersession"].includes(category),
      reviewStatus: "pending" as const,
    }));
  const firstPageRegressions = rankRegressions.filter(
    ({ lexicalRank, semanticRank }) =>
      lexicalRank <= 5 && (semanticRank === null || semanticRank > 5),
  );
  const noAnswerIds = new Set(
    fixture.cases
      .filter((fixtureCase) => fixtureCase.truth.classification === "no-answer")
      .map((fixtureCase) => fixtureCase.query.id),
  );
  const adversarialIds = new Set(
    fixture.cases
      .filter(
        (fixtureCase) =>
          fixtureCase.truth.classification === "no-answer" &&
          fixtureCase.query.category.includes("adversarial"),
      )
      .map((fixtureCase) => fixtureCase.query.id),
  );
  const highSupport = (
    ids: ReadonlySet<string>,
    threshold: number,
  ): Array<{ queryId: string; entryId: string; noul: number }> =>
    cases.flatMap((caseReport) =>
      ids.has(caseReport.queryId)
        ? caseReport.semantic.scores
            .filter(({ noul }) => noul >= threshold)
            .map(({ entryId, noul }) => ({ queryId: caseReport.queryId, entryId, noul }))
        : [],
    );

  const candidateMissDetails = lexicalBaseline.cases
    .filter(
      (caseReport): caseReport is AnswerableReplayCaseReport =>
        caseReport.outcome === "candidate-miss",
    )
    .map(({ queryId, candidateMissReason }) => ({ queryId, reason: candidateMissReason }));
  const comparison: JevReplayReport["comparison"] = {
    candidateMisses: candidateMissDetails.length,
    candidateMissDetails,
    lexicalRankMisses: lexicalBaseline.aggregate.rankMisses,
    semanticRankMisses: answerableReports.filter(
      ({ lexical, semantic }) =>
        lexical.outcome !== "candidate-miss" &&
        semantic.bestKnownAnswerRank !== null &&
        semantic.bestKnownAnswerRank > 5,
    ).length,
    lexicalAnswerAt5,
    semanticAnswerAt5,
    answerAt5NetImprovement:
      lexicalAnswerAt5 === null || semanticAnswerAt5 === null
        ? null
        : round(semanticAnswerAt5 - lexicalAnswerAt5),
    lexicalMeanReciprocalRank: lexicalMrr,
    semanticMeanReciprocalRank: semanticMrr,
    meanReciprocalRankDelta:
      lexicalMrr === null || semanticMrr === null ? null : round(semanticMrr - lexicalMrr),
    promotionsIntoTop5: cases.filter(
      ({ lexical, semantic }) =>
        (lexical.bestKnownAnswerRank === null || lexical.bestKnownAnswerRank > 5) &&
        semantic.bestKnownAnswerRank !== null &&
        semantic.bestKnownAnswerRank <= 5,
    ).length,
    rankRegressions,
    firstPageRegressions,
    disagreements,
    noAnswerHighSupport: highSupport(
      noAnswerIds,
      JEV_EVALUATION_THRESHOLDS.noAnswerHighSupportThreshold,
    ),
    adversarialCases: adversarialIds.size,
    adversarialHighSupport: highSupport(
      adversarialIds,
      JEV_EVALUATION_THRESHOLDS.adversarialHighSupportThreshold,
    ),
  };

  const p95 = percentile(latencies, 0.95);
  const maximumLatency = latencies.length === 0 ? null : round(Math.max(...latencies));
  const maximumUnderestimateRatio =
    underestimateRatios.length === 0 ? null : round(Math.max(...underestimateRatios));
  const estimatorCalibrationAccepted =
    options.transport?.evidenceSource === "native-api" &&
    plan.input.kind === "private-reviewed" &&
    responsesWithValidUsage >= JEV_EVALUATION_THRESHOLDS.calibrationMinimumObservedRequests &&
    maximumUnderestimateRatio !== null &&
    maximumUnderestimateRatio <= JEV_EVALUATION_THRESHOLDS.estimatorMaximumUnderestimateRatio;
  const actualApiUsage =
    options.transport?.evidenceSource === "native-api" && responsesWithValidUsage > 0;
  const reasons: string[] = [];
  if (!options.transport) reasons.push("live-transmission-approval-and-evidence-missing");
  if (options.transport?.evidenceSource === "scripted") {
    reasons.push("scripted-transport-is-not-empirical-evidence");
  }
  if (plan.input.kind === "synthetic") {
    reasons.push("synthetic-input-cannot-pass-empirical-gates");
  }
  if (globalBlock === "qualified-calibration-required") {
    reasons.push("qualified-real-api-calibration-missing");
  } else if (globalBlock) {
    reasons.push(globalBlock);
  }
  if (validJudgments > responsesWithValidUsage) reasons.push("actual-usage-evidence-incomplete");
  if (!lexicalBaseline.validation.valid) reasons.push("fixture-validation-failed");
  if (comparison.disagreements.length > 0 || comparison.rankRegressions.length > 0) {
    reasons.push("review-evidence-missing");
  }
  if (comparison.adversarialCases === 0) reasons.push("adversarial-evidence-missing");
  const coverage = lexicalBaseline.aggregate.candidateCoverage.rate;
  if (coverage === null || coverage < JEV_EVALUATION_THRESHOLDS.candidateCoverageMinimum) {
    reasons.push("candidate-coverage-gate-failed");
  }
  if (
    comparison.answerAt5NetImprovement === null ||
    comparison.answerAt5NetImprovement < JEV_EVALUATION_THRESHOLDS.answerAt5NetImprovementMinimum ||
    comparison.promotionsIntoTop5 < JEV_EVALUATION_THRESHOLDS.answerAt5MinimumPromotions
  ) {
    reasons.push("first-page-quality-gate-failed");
  }
  if (
    comparison.meanReciprocalRankDelta === null ||
    comparison.meanReciprocalRankDelta < JEV_EVALUATION_THRESHOLDS.meanReciprocalRankMinimumDelta
  ) {
    reasons.push("reciprocal-rank-gate-failed");
  }
  if (
    comparison.firstPageRegressions.filter(({ consequential }) => consequential).length >
    JEV_EVALUATION_THRESHOLDS.consequentialFirstPageRegressionMaximum
  ) {
    reasons.push("consequential-regression-gate-failed");
  }
  if (
    comparison.noAnswerHighSupport.length > JEV_EVALUATION_THRESHOLDS.noAnswerHighSupportMaximum
  ) {
    reasons.push("no-answer-alarm-gate-failed");
  }
  if (
    comparison.adversarialHighSupport.length >
    JEV_EVALUATION_THRESHOLDS.adversarialHighSupportMaximum
  ) {
    reasons.push("adversarial-alarm-gate-failed");
  }
  const reliabilityRate =
    eligibleEvaluations === 0 ? null : completeWithinDeadline / eligibleEvaluations;
  if (
    reliabilityRate === null ||
    reliabilityRate < JEV_EVALUATION_THRESHOLDS.completeWithinDeadlineRateMinimum
  ) {
    reasons.push("reliability-gate-failed");
  }
  if (
    p95 === null ||
    p95 > JEV_EVALUATION_THRESHOLDS.addedLatencyP95MaximumMs ||
    (maximumLatency ?? Number.POSITIVE_INFINITY) >
      JEV_EVALUATION_THRESHOLDS.cooperativeDeadlineMaximumMs
  ) {
    reasons.push("latency-gate-failed");
  }
  if (!estimatorCalibrationAccepted) reasons.push("estimator-calibration-gate-blocked");

  const readyForHeldOut =
    options.phase === "calibration" &&
    estimatorCalibrationAccepted &&
    options.approval?.transmissionApproved === true &&
    plan.preparation.status === "READY_FOR_CALIBRATION";
  const uniqueReasons = [...new Set(reasons)];
  return {
    manifestVersion: 1,
    evaluator: "jev-replay-v1",
    phase: options.phase,
    planSha256: plan.freezeSha256,
    implementation: options.implementation,
    fixture: {
      revision: fixture.revision,
      partition: fixture.partition,
      inputSha256: fixture.digests,
      inputKind: plan.input.kind,
    },
    lexicalBaseline,
    evidence: {
      source: options.transport?.evidenceSource ?? "none",
      approvalEvidenceSha256: options.approval?.evidenceSha256 ?? null,
      calibrationEvidenceSha256: options.calibration?.evidenceSha256 ?? null,
      localRawEvidenceRetentionDays: options.approval?.localRawEvidenceRetentionDays ?? null,
      localRetentionExtensionReference: options.approval?.localRetentionExtensionReference ?? null,
      actualApiUsage,
      estimatorCalibrationAccepted,
      price: JEV_PRICE,
    },
    operations: {
      eligibleEvaluations,
      attemptedRequests,
      validJudgments,
      completeWithinDeadline,
      responsesWithValidUsage,
      inputTokens,
      outputTokens,
      estimatedInputCostUsd: roundCost(
        (inputTokens / 1_000_000) * JEV_PRICE.inputUsdPerMillionTokens,
      ),
      estimatorError: {
        maximumUnderestimateRatio,
        meanActualMinusEstimatedTokens:
          estimatorDeltas.length === 0
            ? null
            : round(
                estimatorDeltas.reduce((sum, value) => sum + value, 0) / estimatorDeltas.length,
              ),
      },
      latencyMs: {
        p50: percentile(latencies, 0.5),
        p95,
        maximum: maximumLatency,
        cooperativeDeadlineOverruns: latencies.filter(
          (latency) => latency > JEV_BOUNDS.proposed.cooperativeDeadlineMs,
        ).length,
      },
      failures,
    },
    comparison,
    cases,
    gates: {
      status: uniqueReasons.length === 0 ? "PASS" : "BLOCKED",
      readyForHeldOut,
      reasons: uniqueReasons,
    },
  };
};
