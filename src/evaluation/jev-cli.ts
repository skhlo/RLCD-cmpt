#!/usr/bin/env node
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  JEV_BOUNDS,
  JEV_MODEL,
  JEV_PROMPT,
  JEV_PROMPT_VERSION,
  JEV_RESPONSE_CONTRACT_VERSION,
} from "./jev-contract.js";
import {
  JEV_EVALUATION_THRESHOLDS,
  JEV_PRICE,
  createJevEvaluationPlan,
  deriveJevReplayComparison,
  deriveJevReplayGates,
  deriveJevReplayOperations,
  evaluateJevReplay,
  evaluationPlanFreezeSha256,
  type JevEvaluationApproval,
  type JevEvaluationPhase,
  type JevEvaluationPlan,
  type JevReplayCaseReport,
  type JevReplayReport,
  type QualifiedCalibrationEvidence,
} from "./jev-replay.js";
import {
  ReplayFixtureError,
  readReplayFixture,
  sha256File,
  type ReplayFixture,
  type ReplayInputPaths,
  type ReplayPartition,
} from "./replay-fixture.js";
import { createTypeSafeHttpTransport, type JevTransport } from "./typesafe-http.js";

export interface JevCliDependencies {
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly executableSha256: string;
  readonly createNativeTransport?: () => JevTransport;
}

const usage = `Usage:
  jev-evaluator prepare --corpus <tuning.jsonl> --queries <tuning.json> --truth <tuning.json> --partition tuning \\
    --held-out-corpus <held-out.jsonl> --held-out-queries <held-out.json> --held-out-truth <held-out.json> \\
    --input-kind <synthetic|private-reviewed>

  jev-evaluator run --phase <calibration|held-out> --corpus <session.jsonl> --queries <queries.json> \\
    --truth <truth.json> --partition <tuning|held-out> --plan <plan.json> \\
    [--live --approval <approval.json> --output <new-evidence.json> [--calibration <calibration.json>]]

  jev-evaluator assess --plan <plan.json> --report <held-out-evidence.json> --review-evidence <review.json>

Without --live, run emits a BLOCKED lexical-fallback report and never reads credentials.
Live use is opt-in, requires approval evidence, reads TYPESAFE_API_KEY only after preflight,
and writes private raw evidence to a new mode-0600 file. No request is retried.
`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readJsonObject = (path: string, kind: string): Record<string, unknown> => {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ReplayFixtureError(`Cannot parse ${kind} file ${path}: ${detail}`);
  }
  if (!isRecord(value)) throw new ReplayFixtureError(`${kind} file ${path} must be an object`);
  return value;
};

const isSha256 = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

const isDigests = (value: unknown): value is ReplayFixture["digests"] =>
  isRecord(value) && isSha256(value.corpus) && isSha256(value.queries) && isSha256(value.truth);

const isImplementation = (value: unknown): value is JevEvaluationPlan["implementation"] =>
  isRecord(value) && value.provenance === "executable-sha256" && isSha256(value.executableSha256);

const isPlanCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

const isPlanMeasurements = (value: unknown): boolean =>
  isRecord(value) &&
  [
    value.queryUtf8Bytes,
    value.candidateCount,
    value.longestRoleUtf8Bytes,
    value.longestPassageUtf8Bytes,
    value.stateUtf8Bytes,
    value.longestQuestionUtf8Bytes,
    value.allQuestionsUtf8Bytes,
    value.statePlusLongestQuestionEstimatedTokens,
    value.statePlusAllQuestionsEstimatedTokens,
    value.requestUtf8Bytes,
    value.requestEstimatedInputTokens,
  ].every(isPlanCount);

const isPreparationCase = (value: unknown): boolean => {
  if (
    !isRecord(value) ||
    typeof value.queryId !== "string" ||
    !["prepared", "no-candidates", "rejected", "invalid"].includes(
      typeof value.result === "string" ? value.result : "",
    ) ||
    !isPlanCount(value.candidateCount) ||
    (value.requestSha256 !== undefined && !isSha256(value.requestSha256)) ||
    (value.measurements !== undefined && !isPlanMeasurements(value.measurements)) ||
    (value.issues !== undefined &&
      (!Array.isArray(value.issues) || value.issues.some((issue) => typeof issue !== "string")))
  ) {
    return false;
  }
  return true;
};

const isCurrentPlan = (value: unknown): value is JevEvaluationPlan => {
  if (!isRecord(value)) return false;
  if (
    value.manifestVersion !== 1 ||
    value.evaluator !== "jev-evaluation-plan-v1" ||
    !isSha256(value.freezeSha256) ||
    !isImplementation(value.implementation) ||
    !isRecord(value.input) ||
    (value.input.kind !== "synthetic" && value.input.kind !== "private-reviewed") ||
    !isRecord(value.input.tuning) ||
    typeof value.input.tuning.revision !== "string" ||
    !isDigests(value.input.tuning.inputSha256) ||
    !isRecord(value.input.heldOut) ||
    !isDigests(value.input.heldOut.inputSha256) ||
    !isRecord(value.contract) ||
    !isRecord(value.contract.prompt) ||
    !isRecord(value.preparation) ||
    !isRecord(value.gates)
  ) {
    return false;
  }
  if (
    value.contract.model !== JEV_MODEL ||
    value.contract.promptVersion !== JEV_PROMPT_VERSION ||
    value.contract.prompt.instructionsTemplate !==
      JEV_PROMPT.instructions(0).replace("candidates[0]", "candidates[i]") ||
    JSON.stringify(value.contract.prompt.criteria) !== JSON.stringify(JEV_PROMPT.criteria) ||
    value.contract.responseContractVersion !== JEV_RESPONSE_CONTRACT_VERSION ||
    JSON.stringify(value.contract.bounds) !== JSON.stringify(JEV_BOUNDS) ||
    value.contract.tokenEstimateIsExact !== false ||
    value.contract.liveShadowEvaluationsRequiredForOfflineEvaluator !== false ||
    JSON.stringify(value.thresholds) !== JSON.stringify(JEV_EVALUATION_THRESHOLDS) ||
    JSON.stringify(value.pricing) !== JSON.stringify(JEV_PRICE)
  ) {
    return false;
  }
  return (
    (value.preparation.status === "READY_FOR_CALIBRATION" ||
      value.preparation.status === "BLOCKED") &&
    isPlanCount(value.preparation.preparedQueries) &&
    isPlanCount(value.preparation.noCandidateQueries) &&
    isPlanCount(value.preparation.failedQueries) &&
    Array.isArray(value.preparation.cases) &&
    value.preparation.cases.every(isPreparationCase) &&
    value.gates.status === "BLOCKED" &&
    Array.isArray(value.gates.reasons) &&
    value.gates.reasons.every((reason) => typeof reason === "string")
  );
};

const readPlan = (path: string): JevEvaluationPlan => {
  const value = readJsonObject(path, "evaluation plan");
  if (!isRecord(value.contract) || value.contract.model !== JEV_MODEL) {
    throw new ReplayFixtureError("Evaluation plan contract does not match the pinned Jev contract");
  }
  if (!isCurrentPlan(value)) {
    throw new ReplayFixtureError(
      "Evaluation plan is malformed or does not match this evaluator version",
    );
  }
  if (evaluationPlanFreezeSha256(value) !== value.freezeSha256) {
    throw new ReplayFixtureError("Evaluation plan freeze digest does not match its contents");
  }
  const preparedQueries = value.preparation.cases.filter(
    ({ result }) => result === "prepared",
  ).length;
  const noCandidateQueries = value.preparation.cases.filter(
    ({ result }) => result === "no-candidates",
  ).length;
  const failedQueries = value.preparation.cases.filter(
    ({ result }) => result === "rejected" || result === "invalid",
  ).length;
  const queryIds = value.preparation.cases.map(({ queryId }) => queryId);
  const expectedReasons = ["real-api-calibration-missing", "held-out-evaluation-missing"];
  if (value.input.kind === "synthetic") {
    expectedReasons.push("synthetic-input-cannot-pass-empirical-gates");
  }
  if (failedQueries > 0) expectedReasons.push("preparation-failures-present");
  if (
    value.preparation.preparedQueries !== preparedQueries ||
    value.preparation.noCandidateQueries !== noCandidateQueries ||
    value.preparation.failedQueries !== failedQueries ||
    value.preparation.status !== (failedQueries === 0 ? "READY_FOR_CALIBRATION" : "BLOCKED") ||
    new Set(queryIds).size !== queryIds.length ||
    JSON.stringify(value.gates.reasons) !== JSON.stringify(expectedReasons)
  ) {
    throw new ReplayFixtureError("Evaluation plan preparation and gates are inconsistent");
  }
  return value;
};

const isFiniteNonnegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const isNonnegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;
const isNullableFiniteNonnegative = (value: unknown): value is number | null =>
  value === null || isFiniteNonnegative(value);
const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");
const isUniqueStringArray = (value: unknown): value is readonly string[] =>
  isStringArray(value) && new Set(value).size === value.length;
const sameJson = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const stableRerankedIds = (
  lexicalIds: readonly string[],
  scores: JevReplayCaseReport["semantic"]["scores"],
): readonly string[] => {
  const scoresById = new Map(scores.map(({ entryId, noul }) => [entryId, noul]));
  return lexicalIds
    .map((entryId, lexicalPosition) => ({ entryId, lexicalPosition }))
    .sort((left, right) => {
      const leftScore = scoresById.get(left.entryId);
      const rightScore = scoresById.get(right.entryId);
      if (leftScore === undefined || rightScore === undefined) {
        return left.lexicalPosition - right.lexicalPosition;
      }
      return rightScore - leftScore || left.lexicalPosition - right.lexicalPosition;
    })
    .map(({ entryId }) => entryId);
};

const rankOfKnownAnswer = (
  candidateIds: readonly string[],
  knownAnswerIds: readonly string[],
): number | null => {
  const knownAnswers = new Set(knownAnswerIds);
  const index = candidateIds.findIndex((entryId) => knownAnswers.has(entryId));
  return index === -1 ? null : index + 1;
};

const isLexicalCaseArtifact = (
  value: unknown,
): value is JevReplayReport["lexicalBaseline"]["cases"][number] => {
  if (
    !isRecord(value) ||
    typeof value.queryId !== "string" ||
    typeof value.query !== "string" ||
    typeof value.category !== "string"
  ) {
    return false;
  }
  if (value.outcome === "no-answer-empty" || value.outcome === "no-answer-candidates") {
    return isUniqueStringArray(value.candidateEntryIds);
  }
  if (
    value.outcome !== "answer-at-5" &&
    value.outcome !== "rank-miss" &&
    value.outcome !== "candidate-miss"
  ) {
    return false;
  }
  return (
    isUniqueStringArray(value.knownAnswerEntryIds) &&
    isUniqueStringArray(value.candidateEntryIds) &&
    (value.bestKnownAnswerRank === null ||
      (isNonnegativeInteger(value.bestKnownAnswerRank) && value.bestKnownAnswerRank > 0)) &&
    isFiniteNonnegative(value.reciprocalRank) &&
    (value.candidateMissReason === null ||
      value.candidateMissReason === "lexical-match" ||
      value.candidateMissReason === "relative-floor" ||
      value.candidateMissReason === "candidate-cap")
  );
};

const expectedLexicalAggregate = (
  cases: JevReplayReport["lexicalBaseline"]["cases"],
): JevReplayReport["lexicalBaseline"]["aggregate"] => {
  const answerable = cases.filter(
    ({ outcome }) =>
      outcome === "answer-at-5" || outcome === "rank-miss" || outcome === "candidate-miss",
  );
  const noAnswer = cases.filter(
    ({ outcome }) => outcome === "no-answer-empty" || outcome === "no-answer-candidates",
  );
  const candidateHits = answerable.filter(({ outcome }) => outcome !== "candidate-miss").length;
  const answerAt5Hits = answerable.filter(({ outcome }) => outcome === "answer-at-5").length;
  const reciprocalRankSum = answerable.reduce(
    (sum, caseReport) => sum + ("reciprocalRank" in caseReport ? caseReport.reciprocalRank : 0),
    0,
  );
  const metric = (hits: number, denominator: number) => ({
    hits,
    denominator,
    rate: denominator === 0 ? null : Math.round((hits / denominator) * 1_000_000) / 1_000_000,
  });
  return {
    totalQueries: cases.length,
    validQueries: cases.length,
    invalidQueries: 0,
    answerableQueries: answerable.length,
    noAnswerQueries: noAnswer.length,
    candidateMisses: answerable.filter(({ outcome }) => outcome === "candidate-miss").length,
    rankMisses: answerable.filter(({ outcome }) => outcome === "rank-miss").length,
    noAnswerWithCandidates: noAnswer.filter(({ outcome }) => outcome === "no-answer-candidates")
      .length,
    noAnswerWithoutCandidates: noAnswer.filter(({ outcome }) => outcome === "no-answer-empty")
      .length,
    candidateCoverage: metric(candidateHits, answerable.length),
    answerAt5: metric(answerAt5Hits, answerable.length),
    meanReciprocalRank: {
      sum: Math.round(reciprocalRankSum * 1_000_000) / 1_000_000,
      denominator: answerable.length,
      value:
        answerable.length === 0
          ? null
          : Math.round((reciprocalRankSum / answerable.length) * 1_000_000) / 1_000_000,
    },
  };
};

const isLexicalReplayArtifact = (value: unknown): value is JevReplayReport["lexicalBaseline"] => {
  if (
    !isRecord(value) ||
    value.manifestVersion !== 1 ||
    value.evaluator !== "lexical-replay-v1" ||
    !isImplementation(value.implementation) ||
    !isRecord(value.fixture) ||
    typeof value.fixture.revision !== "string" ||
    (value.fixture.partition !== "tuning" && value.fixture.partition !== "held-out") ||
    !isDigests(value.fixture.inputSha256) ||
    !isRecord(value.parameters) ||
    value.parameters.mode !== "hybrid" ||
    value.parameters.answerAtK !== 5 ||
    !isRecord(value.parameters.ranking) ||
    !isRecord(value.validation) ||
    value.validation.valid !== true ||
    value.validation.reviewRequired !== false ||
    !Array.isArray(value.validation.issues) ||
    value.validation.issues.length !== 0 ||
    !isRecord(value.aggregate) ||
    !Array.isArray(value.cases) ||
    !value.cases.every(isLexicalCaseArtifact)
  ) {
    return false;
  }
  return sameJson(value.aggregate, expectedLexicalAggregate(value.cases));
};

const isMeasurementsArtifact = (value: unknown): boolean =>
  isRecord(value) &&
  [
    value.queryUtf8Bytes,
    value.candidateCount,
    value.longestRoleUtf8Bytes,
    value.longestPassageUtf8Bytes,
    value.stateUtf8Bytes,
    value.longestQuestionUtf8Bytes,
    value.allQuestionsUtf8Bytes,
    value.statePlusLongestQuestionEstimatedTokens,
    value.statePlusAllQuestionsEstimatedTokens,
    value.requestUtf8Bytes,
    value.requestEstimatedInputTokens,
  ].every(isFiniteNonnegative);

const isUsageArtifact = (value: unknown): boolean =>
  isRecord(value) &&
  isNonnegativeInteger(value.inputTokens) &&
  isNonnegativeInteger(value.outputTokens);

const isTransmittedRequestArtifact = (value: unknown): boolean => {
  if (
    !isRecord(value) ||
    value.model !== JEV_MODEL ||
    !isRecord(value.state) ||
    typeof value.state.query !== "string" ||
    !Array.isArray(value.state.candidates) ||
    !value.state.candidates.every(
      (candidate) =>
        isRecord(candidate) &&
        typeof candidate.role === "string" &&
        typeof candidate.passage === "string",
    ) ||
    !isRecord(value.questions)
  ) {
    return false;
  }
  return Object.entries(value.questions).every(
    ([key, question], index) =>
      key === `c${index}` &&
      isRecord(question) &&
      question.type === "noul" &&
      question.instructions === JEV_PROMPT.instructions(index) &&
      sameJson(question.criteria, JEV_PROMPT.criteria),
  );
};

const isReplayCaseArtifact = (value: unknown): value is JevReplayCaseReport => {
  if (
    !isRecord(value) ||
    typeof value.queryId !== "string" ||
    typeof value.query !== "string" ||
    typeof value.category !== "string" ||
    !isRecord(value.lexical) ||
    typeof value.lexical.outcome !== "string" ||
    !isUniqueStringArray(value.lexical.candidateEntryIds) ||
    !isNullableFiniteNonnegative(value.lexical.bestKnownAnswerRank) ||
    (value.lexical.candidateMissReason !== null &&
      typeof value.lexical.candidateMissReason !== "string") ||
    !isRecord(value.semantic) ||
    (value.semantic.result !== "reranked" && value.semantic.result !== "lexical-fallback") ||
    !isUniqueStringArray(value.semantic.candidateEntryIds) ||
    !isNullableFiniteNonnegative(value.semantic.bestKnownAnswerRank) ||
    !Array.isArray(value.semantic.scores) ||
    !value.semantic.scores.every(
      (score) =>
        isRecord(score) &&
        typeof score.entryId === "string" &&
        typeof score.noul === "number" &&
        Number.isFinite(score.noul) &&
        score.noul >= 0 &&
        score.noul <= 1,
    ) ||
    (value.semantic.usage !== null && !isUsageArtifact(value.semantic.usage)) ||
    (value.semantic.usageStatus !== "not-dispatched" &&
      value.semantic.usageStatus !== "provider-reported" &&
      value.semantic.usageStatus !== "unknown") ||
    (value.semantic.usageIssue !== null &&
      value.semantic.usageIssue !== "invalid-usage" &&
      value.semantic.usageIssue !== "response-unavailable") ||
    (value.semantic.requestSha256 !== null && !isSha256(value.semantic.requestSha256)) ||
    (value.semantic.transmittedRequest !== null &&
      !isTransmittedRequestArtifact(value.semantic.transmittedRequest)) ||
    (value.semantic.requestMeasurements !== null &&
      !isMeasurementsArtifact(value.semantic.requestMeasurements)) ||
    !isRecord(value.semantic.timingMs) ||
    !isFiniteNonnegative(value.semantic.timingMs.preparation) ||
    !isFiniteNonnegative(value.semantic.timingMs.transport) ||
    !isFiniteNonnegative(value.semantic.timingMs.totalAdded) ||
    (value.semantic.estimatorError !== null &&
      (!isRecord(value.semantic.estimatorError) ||
        !isFiniteNonnegative(value.semantic.estimatorError.estimatedInputTokens) ||
        !isFiniteNonnegative(value.semantic.estimatorError.actualInputTokens) ||
        typeof value.semantic.estimatorError.actualMinusEstimatedTokens !== "number" ||
        !Number.isFinite(value.semantic.estimatorError.actualMinusEstimatedTokens) ||
        !isFiniteNonnegative(value.semantic.estimatorError.underestimateRatio)))
  ) {
    return false;
  }

  const dispatched = value.semantic.transmittedRequest !== null;
  const hasUsage = value.semantic.usage !== null;
  if (
    (dispatched &&
      (value.semantic.requestMeasurements === null || value.semantic.requestSha256 === null)) ||
    (!dispatched &&
      (value.semantic.requestMeasurements !== null ||
        value.semantic.usageStatus !== "not-dispatched" ||
        hasUsage)) ||
    (hasUsage && value.semantic.usageStatus !== "provider-reported") ||
    (dispatched && !hasUsage && value.semantic.usageStatus !== "unknown")
  ) {
    return false;
  }

  if (value.semantic.result === "lexical-fallback") {
    return (
      typeof value.semantic.fallbackReason === "string" &&
      value.semantic.fallbackReason.length > 0 &&
      value.semantic.scores.length === 0 &&
      sameJson(value.semantic.candidateEntryIds, value.lexical.candidateEntryIds) &&
      value.semantic.bestKnownAnswerRank === value.lexical.bestKnownAnswerRank
    );
  }
  const lexicalIds = [...value.lexical.candidateEntryIds].sort();
  const semanticIds = [...value.semantic.candidateEntryIds].sort();
  const scoreIds = value.semantic.scores.map(({ entryId }) => entryId).sort();
  return (
    value.semantic.fallbackReason === null &&
    dispatched &&
    new Set(scoreIds).size === scoreIds.length &&
    sameJson(semanticIds, lexicalIds) &&
    sameJson(scoreIds, lexicalIds)
  );
};

const isReplayEvidenceArtifact = (value: unknown): value is JevReplayReport["evidence"] =>
  isRecord(value) &&
  (value.source === "none" || value.source === "scripted" || value.source === "native-api") &&
  (value.approvalEvidenceSha256 === null || isSha256(value.approvalEvidenceSha256)) &&
  (value.calibrationEvidenceSha256 === null || isSha256(value.calibrationEvidenceSha256)) &&
  (value.localRawEvidenceRetentionDays === null ||
    isNonnegativeInteger(value.localRawEvidenceRetentionDays)) &&
  (value.localRetentionExtensionReference === null ||
    typeof value.localRetentionExtensionReference === "string") &&
  typeof value.nativeApiRequestsDispatched === "boolean" &&
  typeof value.estimatorCalibrationAccepted === "boolean" &&
  sameJson(value.price, JEV_PRICE);

const isReplayReportArtifactShape = (value: unknown): value is JevReplayReport =>
  isRecord(value) &&
  value.manifestVersion === 1 &&
  value.evaluator === "jev-replay-v1" &&
  (value.phase === "calibration" || value.phase === "held-out") &&
  isSha256(value.planSha256) &&
  isImplementation(value.implementation) &&
  isRecord(value.fixture) &&
  typeof value.fixture.revision === "string" &&
  (value.fixture.partition === "tuning" || value.fixture.partition === "held-out") &&
  isDigests(value.fixture.inputSha256) &&
  (value.fixture.inputKind === "synthetic" || value.fixture.inputKind === "private-reviewed") &&
  isLexicalReplayArtifact(value.lexicalBaseline) &&
  isReplayEvidenceArtifact(value.evidence) &&
  isRecord(value.operations) &&
  isRecord(value.comparison) &&
  Array.isArray(value.cases) &&
  value.cases.every(isReplayCaseArtifact) &&
  isRecord(value.gates);

const readValidatedReplayReport = (
  path: string,
  plan: JevEvaluationPlan,
  phase: JevEvaluationPhase,
  executableSha256: string,
): JevReplayReport => {
  const value: unknown = readJsonObject(path, `${phase} evidence`);
  if (!isReplayReportArtifactShape(value)) {
    throw new ReplayFixtureError(`${phase} evidence is malformed or incomplete`);
  }
  const expectedPartition = phase === "calibration" ? "tuning" : "held-out";
  const expectedDigests =
    phase === "calibration" ? plan.input.tuning.inputSha256 : plan.input.heldOut.inputSha256;
  if (
    value.phase !== phase ||
    value.planSha256 !== plan.freezeSha256 ||
    !sameJson(value.implementation, plan.implementation) ||
    value.implementation.executableSha256 !== executableSha256 ||
    value.fixture.partition !== expectedPartition ||
    value.fixture.inputKind !== plan.input.kind ||
    !sameJson(value.fixture.inputSha256, expectedDigests) ||
    !sameJson(value.lexicalBaseline.implementation, value.implementation) ||
    !sameJson(value.lexicalBaseline.fixture, {
      revision: value.fixture.revision,
      partition: value.fixture.partition,
      inputSha256: value.fixture.inputSha256,
    })
  ) {
    throw new ReplayFixtureError(
      `${phase} evidence does not bind this frozen plan, implementation, and input`,
    );
  }

  const lexicalById = new Map(value.lexicalBaseline.cases.map((item) => [item.queryId, item]));
  if (
    value.cases.length !== value.lexicalBaseline.cases.length ||
    value.cases.some((item) => {
      const lexical = lexicalById.get(item.queryId);
      return (
        !lexical ||
        item.query !== lexical.query ||
        item.category !== lexical.category ||
        item.lexical.outcome !== lexical.outcome ||
        !("candidateEntryIds" in lexical) ||
        !sameJson(item.lexical.candidateEntryIds, lexical.candidateEntryIds) ||
        item.lexical.bestKnownAnswerRank !==
          ("bestKnownAnswerRank" in lexical ? lexical.bestKnownAnswerRank : null)
      );
    })
  ) {
    throw new ReplayFixtureError(`${phase} evidence cases do not match its lexical baseline`);
  }
  for (const item of value.cases) {
    if (item.semantic.result !== "reranked") continue;
    const lexical = lexicalById.get(item.queryId);
    if (!lexical || !("candidateEntryIds" in lexical)) {
      throw new ReplayFixtureError(`${phase} evidence cases do not match its lexical baseline`);
    }
    const expectedOrder = stableRerankedIds(lexical.candidateEntryIds, item.semantic.scores);
    if (!sameJson(item.semantic.candidateEntryIds, expectedOrder)) {
      throw new ReplayFixtureError(
        `${phase} evidence query ${JSON.stringify(item.queryId)} reranked order is inconsistent with its complete scores and lexical order`,
      );
    }
    const knownAnswerIds = "knownAnswerEntryIds" in lexical ? lexical.knownAnswerEntryIds : [];
    if (item.semantic.bestKnownAnswerRank !== rankOfKnownAnswer(expectedOrder, knownAnswerIds)) {
      throw new ReplayFixtureError(
        `${phase} evidence query ${JSON.stringify(item.queryId)} best-known-answer rank is inconsistent with its reranked order and frozen answer IDs`,
      );
    }
  }

  const operations = deriveJevReplayOperations(value.cases);
  const comparison = deriveJevReplayComparison(value.lexicalBaseline, value.cases, plan.thresholds);
  const estimatorCalibrationAccepted =
    value.evidence.source === "native-api" &&
    plan.input.kind === "private-reviewed" &&
    operations.providerReportedUsageResponses >=
      plan.thresholds.calibrationMinimumObservedRequests &&
    operations.requestsWithUnknownUsage === 0 &&
    operations.providerReportedUsageResponses === operations.attemptedRequests &&
    operations.estimatorError.maximumUnderestimateRatio !== null &&
    operations.estimatorError.maximumUnderestimateRatio <=
      plan.thresholds.estimatorMaximumUnderestimateRatio;
  if (
    !sameJson(value.operations, operations) ||
    !sameJson(value.comparison, comparison) ||
    value.evidence.nativeApiRequestsDispatched !==
      (value.evidence.source === "native-api" && operations.attemptedRequests > 0) ||
    value.evidence.estimatorCalibrationAccepted !== estimatorCalibrationAccepted
  ) {
    throw new ReplayFixtureError(`${phase} evidence aggregates are inconsistent with its cases`);
  }
  const gates = deriveJevReplayGates({
    phase,
    plan,
    lexicalBaseline: value.lexicalBaseline,
    evidence: value.evidence,
    operations,
    comparison,
  });
  if (!sameJson(value.gates, gates)) {
    throw new ReplayFixtureError(`${phase} evidence gates are inconsistent with validated records`);
  }
  return value;
};

interface ParsedArguments {
  readonly command: "prepare" | "run" | "assess";
  readonly values: ReadonlyMap<string, string>;
  readonly live: boolean;
}

const parseArguments = (rawArgs: readonly string[]): ParsedArguments | "help" => {
  const args = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) return "help";
  const command = args[0];
  if (command !== "prepare" && command !== "run" && command !== "assess") {
    throw new ReplayFixtureError(`First argument must be prepare, run, or assess\n${usage}`);
  }
  const prepareFlags = new Set([
    "--corpus",
    "--queries",
    "--truth",
    "--partition",
    "--held-out-corpus",
    "--held-out-queries",
    "--held-out-truth",
    "--input-kind",
  ]);
  const runFlags = new Set([
    "--phase",
    "--corpus",
    "--queries",
    "--truth",
    "--partition",
    "--plan",
    "--approval",
    "--calibration",
    "--output",
  ]);
  const assessFlags = new Set(["--plan", "--report", "--review-evidence"]);
  const allowed = command === "prepare" ? prepareFlags : command === "run" ? runFlags : assessFlags;
  const values = new Map<string, string>();
  let live = false;
  for (let index = 1; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--live" && command === "run") {
      if (live) throw new ReplayFixtureError("Duplicate argument --live");
      live = true;
      continue;
    }
    if (!flag || !allowed.has(flag)) {
      throw new ReplayFixtureError(`Unknown argument ${JSON.stringify(flag)}\n${usage}`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new ReplayFixtureError(`Missing value for ${flag}\n${usage}`);
    }
    if (values.has(flag)) throw new ReplayFixtureError(`Duplicate argument ${flag}`);
    values.set(flag, value);
    index++;
  }
  return { command, values, live };
};

const requireValue = (values: ReadonlyMap<string, string>, flag: string): string => {
  const value = values.get(flag);
  if (!value) throw new ReplayFixtureError(`${flag} is required\n${usage}`);
  return value;
};

const fixtureOptions = (
  values: ReadonlyMap<string, string>,
): { paths: ReplayInputPaths; partition: ReplayPartition } => {
  const partition = requireValue(values, "--partition");
  if (partition !== "tuning" && partition !== "held-out") {
    throw new ReplayFixtureError("--partition must be tuning or held-out");
  }
  return {
    paths: {
      corpus: requireValue(values, "--corpus"),
      queries: requireValue(values, "--queries"),
      truth: requireValue(values, "--truth"),
    },
    partition,
  };
};

const readApproval = (
  path: string,
  plan: JevEvaluationPlan,
  phase: JevEvaluationPhase,
): JevEvaluationApproval => {
  const value = readJsonObject(path, "approval");
  if (
    value.schemaVersion !== 1 ||
    value.planSha256 !== plan.freezeSha256 ||
    value.phase !== phase ||
    value.transmissionApproved !== true ||
    typeof value.approvedBy !== "string" ||
    value.approvedBy.length === 0 ||
    typeof value.approvedAt !== "string" ||
    value.approvedAt.length === 0 ||
    typeof value.evidenceReference !== "string" ||
    value.evidenceReference.length === 0 ||
    !Number.isInteger(value.localRawEvidenceRetentionDays) ||
    typeof value.localRawEvidenceRetentionDays !== "number" ||
    value.localRawEvidenceRetentionDays < 1
  ) {
    throw new ReplayFixtureError(
      "Approval must explicitly bind this plan and phase with approver, date, and evidence reference",
    );
  }

  const extensionReference = value.localRetentionExtensionReference;
  if (
    value.localRawEvidenceRetentionDays > 7 &&
    (typeof extensionReference !== "string" || extensionReference.length === 0)
  ) {
    throw new ReplayFixtureError(
      "Local raw evidence beyond seven days requires an explicit extension reference",
    );
  }

  let privateAccountTermsAccepted = false;
  if (plan.input.kind === "private-reviewed") {
    const terms = value.accountTerms;
    if (
      !isRecord(terms) ||
      terms.retentionAccepted !== true ||
      terms.accessAccepted !== true ||
      terms.deletionAccepted !== true ||
      typeof terms.reference !== "string" ||
      terms.reference.length === 0
    ) {
      throw new ReplayFixtureError(
        "Private input requires accepted retention, access, and deletion terms with a reference",
      );
    }
    privateAccountTermsAccepted = true;
  }
  return {
    evidenceSha256: sha256File(path),
    transmissionApproved: true,
    privateAccountTermsAccepted,
    localRawEvidenceRetentionDays: value.localRawEvidenceRetentionDays,
    localRetentionExtensionReference:
      typeof extensionReference === "string" ? extensionReference : null,
  };
};

const readCalibration = (
  path: string,
  plan: JevEvaluationPlan,
  executableSha256: string,
): QualifiedCalibrationEvidence => {
  const value = readValidatedReplayReport(path, plan, "calibration", executableSha256);
  if (
    value.fixture.inputKind !== "private-reviewed" ||
    value.evidence.source !== "native-api" ||
    !isSha256(value.evidence.approvalEvidenceSha256) ||
    value.evidence.nativeApiRequestsDispatched !== true ||
    value.evidence.estimatorCalibrationAccepted !== true ||
    value.evidence.localRawEvidenceRetentionDays === null ||
    value.evidence.localRawEvidenceRetentionDays < 1 ||
    (value.evidence.localRawEvidenceRetentionDays > 7 &&
      (value.evidence.localRetentionExtensionReference === null ||
        value.evidence.localRetentionExtensionReference.length === 0)) ||
    value.operations.providerReportedUsageResponses <
      plan.thresholds.calibrationMinimumObservedRequests ||
    value.operations.requestsWithUnknownUsage !== 0 ||
    value.gates.readyForHeldOut !== true
  ) {
    throw new ReplayFixtureError(
      "Calibration evidence must contain qualified private native-API usage for this frozen plan",
    );
  }
  return {
    evidenceSha256: sha256File(path),
    planSha256: plan.freezeSha256,
    source: "native-api",
    inputKind: "private-reviewed",
    observedUsageResponses: value.operations.providerReportedUsageResponses,
    readyForHeldOut: true,
  };
};

const emitJson = (write: (value: string) => void, value: unknown): void => {
  write(`${JSON.stringify(value, null, 2)}\n`);
};

const runPrepare = (
  values: ReadonlyMap<string, string>,
  dependencies: JevCliDependencies,
): number => {
  const fixtureInput = fixtureOptions(values);
  if (fixtureInput.partition !== "tuning") {
    throw new ReplayFixtureError("prepare requires --partition tuning");
  }
  const inputKind = requireValue(values, "--input-kind");
  if (inputKind !== "synthetic" && inputKind !== "private-reviewed") {
    throw new ReplayFixtureError("--input-kind must be synthetic or private-reviewed");
  }
  const tuningFixture = readReplayFixture(fixtureInput.paths, "tuning");
  const heldOutInputSha256 = {
    corpus: sha256File(requireValue(values, "--held-out-corpus")),
    queries: sha256File(requireValue(values, "--held-out-queries")),
    truth: sha256File(requireValue(values, "--held-out-truth")),
  };
  const plan = createJevEvaluationPlan({
    tuningFixture,
    heldOutInputSha256,
    inputKind,
    implementation: {
      provenance: "executable-sha256",
      executableSha256: dependencies.executableSha256,
    },
  });
  emitJson(dependencies.stdout, plan);
  return plan.preparation.status === "READY_FOR_CALIBRATION" ? 0 : 2;
};

const runEvaluation = async (
  parsed: ParsedArguments,
  dependencies: JevCliDependencies,
): Promise<number> => {
  const phase = requireValue(parsed.values, "--phase");
  if (phase !== "calibration" && phase !== "held-out") {
    throw new ReplayFixtureError("--phase must be calibration or held-out");
  }
  const fixtureInput = fixtureOptions(parsed.values);
  const expectedPartition = phase === "calibration" ? "tuning" : "held-out";
  if (fixtureInput.partition !== expectedPartition) {
    throw new ReplayFixtureError(`${phase} requires --partition ${expectedPartition}`);
  }
  const plan = readPlan(requireValue(parsed.values, "--plan"));
  if (plan.implementation.executableSha256 !== dependencies.executableSha256) {
    throw new ReplayFixtureError(
      "Evaluation plan executable provenance does not match the current evaluator",
    );
  }
  const fixture = readReplayFixture(fixtureInput.paths, expectedPartition);
  const implementation = {
    provenance: "executable-sha256" as const,
    executableSha256: dependencies.executableSha256,
  };

  if (!parsed.live) {
    const report = await evaluateJevReplay(fixture, plan, { phase, implementation });
    emitJson(dependencies.stdout, report);
    return 2;
  }

  const approvalPath = parsed.values.get("--approval");
  if (!approvalPath) throw new ReplayFixtureError("--approval is required with --live");
  const outputPath = parsed.values.get("--output");
  if (!outputPath) throw new ReplayFixtureError("--output is required with --live");
  const calibration =
    phase === "held-out"
      ? readCalibration(
          requireValue(parsed.values, "--calibration"),
          plan,
          dependencies.executableSha256,
        )
      : undefined;
  const approval = readApproval(approvalPath, plan, phase);
  const outputDirectory = dirname(outputPath);
  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  if ((statSync(outputDirectory).mode & 0o077) !== 0) {
    throw new ReplayFixtureError("Live evidence output directory must have mode 0700");
  }
  if (existsSync(outputPath)) {
    throw new ReplayFixtureError("Live evidence output file must not already exist");
  }

  const apiKey = dependencies.env.TYPESAFE_API_KEY;
  if (!apiKey) throw new ReplayFixtureError("TYPESAFE_API_KEY is unavailable");
  closeSync(openSync(outputPath, "wx", 0o600));
  const injectedTransport = dependencies.createNativeTransport?.();
  const transport: JevTransport = injectedTransport
    ? {
        evidenceSource: "scripted",
        send: (request) => injectedTransport.send(request),
      }
    : createTypeSafeHttpTransport();
  const report = await evaluateJevReplay(fixture, plan, {
    phase,
    transport,
    apiKey,
    approval,
    calibration,
    implementation,
  });
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    flag: "w",
    mode: 0o600,
  });
  emitJson(dependencies.stdout, {
    evaluator: report.evaluator,
    phase: report.phase,
    status: report.gates.status,
    readyForHeldOut: report.gates.readyForHeldOut,
    evidencePath: outputPath,
    evidenceSha256: sha256File(outputPath),
    reasons: report.gates.reasons,
  });
  return phase === "calibration"
    ? report.gates.readyForHeldOut
      ? 0
      : 2
    : report.gates.status === "PASS"
      ? 0
      : 2;
};

const reviewItemIds = (value: unknown, kind: string): readonly string[] => {
  if (!Array.isArray(value)) {
    throw new ReplayFixtureError(`Held-out report ${kind} must be an array`);
  }
  return value.map((item) => {
    if (!isRecord(item) || typeof item.queryId !== "string" || item.queryId.length === 0) {
      throw new ReplayFixtureError(`Held-out report contains a malformed ${kind} item`);
    }
    return item.queryId;
  });
};

const runAssessment = (
  values: ReadonlyMap<string, string>,
  dependencies: JevCliDependencies,
): number => {
  const plan = readPlan(requireValue(values, "--plan"));
  if (plan.implementation.executableSha256 !== dependencies.executableSha256) {
    throw new ReplayFixtureError(
      "Evaluation plan executable provenance does not match the current evaluator",
    );
  }
  const reportPath = requireValue(values, "--report");
  const reviewPath = requireValue(values, "--review-evidence");
  const report = readValidatedReplayReport(
    reportPath,
    plan,
    "held-out",
    dependencies.executableSha256,
  );
  const disagreementIds = reviewItemIds(report.comparison.disagreements, "disagreement");
  const regressionIds = reviewItemIds(
    report.comparison.rankRegressions ?? report.comparison.firstPageRegressions,
    "regression",
  );
  const pendingIds = [...new Set([...disagreementIds, ...regressionIds])].sort();
  const reportDigest = sha256File(reportPath);

  const review = readJsonObject(reviewPath, "review evidence");
  if (
    review.schemaVersion !== 1 ||
    review.heldOutEvidenceSha256 !== reportDigest ||
    typeof review.reviewedBy !== "string" ||
    review.reviewedBy.length === 0 ||
    typeof review.reviewedAt !== "string" ||
    review.reviewedAt.length === 0 ||
    !Array.isArray(review.items)
  ) {
    throw new ReplayFixtureError(
      "Review evidence must bind this held-out report and name the reviewer and review date",
    );
  }
  const seen = new Set<string>();
  const reviewedItems = review.items.map((item) => {
    if (
      !isRecord(item) ||
      typeof item.queryId !== "string" ||
      item.queryId.length === 0 ||
      !["acceptable-change", "confirmed-regression", "model-error", "label-error"].includes(
        typeof item.judgment === "string" ? item.judgment : "",
      ) ||
      typeof item.notes !== "string" ||
      item.notes.length === 0
    ) {
      throw new ReplayFixtureError("Review evidence contains a malformed review item");
    }
    if (seen.has(item.queryId)) {
      throw new ReplayFixtureError(
        `Review evidence duplicates query ${JSON.stringify(item.queryId)}`,
      );
    }
    seen.add(item.queryId);
    const disagreement = disagreementIds.includes(item.queryId);
    const regression = regressionIds.includes(item.queryId);
    if (!disagreement && !regression) {
      throw new ReplayFixtureError(
        `Review evidence includes non-pending query ${JSON.stringify(item.queryId)}`,
      );
    }
    return {
      queryId: item.queryId,
      kind:
        disagreement && regression
          ? "disagreement-and-regression"
          : regression
            ? "regression"
            : "disagreement",
      judgment: item.judgment,
      notes: item.notes,
    };
  });
  const missingIds = pendingIds.filter((queryId) => !seen.has(queryId));
  if (missingIds.length > 0) {
    throw new ReplayFixtureError(
      `Review evidence is missing pending queries: ${missingIds.join(", ")}`,
    );
  }

  const reasons = report.gates.reasons.filter(
    (reason): reason is string =>
      typeof reason === "string" && reason !== "review-evidence-missing",
  );
  if (reviewedItems.some(({ judgment }) => judgment === "label-error")) {
    reasons.push("review-found-label-error");
  }
  const uniqueReasons = [...new Set(reasons)];
  const assessment = {
    manifestVersion: 1,
    evaluator: "jev-held-out-assessment-v1",
    planSha256: plan.freezeSha256,
    implementation: plan.implementation,
    heldOutEvidenceSha256: reportDigest,
    reviewEvidenceSha256: sha256File(reviewPath),
    review: {
      reviewedBy: review.reviewedBy,
      reviewedAt: review.reviewedAt,
      reviewedItems: reviewedItems.length,
      pendingItems: 0,
      items: reviewedItems,
    },
    gates: {
      status: uniqueReasons.length === 0 ? "PASS" : "BLOCKED",
      reasons: uniqueReasons,
    },
  };
  emitJson(dependencies.stdout, assessment);
  return assessment.gates.status === "PASS" ? 0 : 2;
};

export const runJevCli = async (
  rawArgs: readonly string[],
  dependencies: JevCliDependencies,
): Promise<number> => {
  try {
    const parsed = parseArguments(rawArgs);
    if (parsed === "help") {
      dependencies.stdout(usage);
      return 0;
    }
    if (parsed.command === "prepare") return runPrepare(parsed.values, dependencies);
    if (parsed.command === "assess") return runAssessment(parsed.values, dependencies);
    return await runEvaluation(parsed, dependencies);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    dependencies.stderr(`jev-evaluator: ${message}\n`);
    return 1;
  }
};

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const executablePath = fileURLToPath(import.meta.url);
  const status = await runJevCli(process.argv.slice(2), {
    stdout: (value) => process.stdout.write(value),
    stderr: (value) => process.stderr.write(value),
    env: process.env,
    executableSha256: sha256File(executablePath),
  });
  process.exitCode = status;
}
