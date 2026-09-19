import {
  DEFAULT_SEARCH_TUNING,
  SEARCH_RANKING_CONFIGURATION,
  planSearchQuery,
  searchEntriesDetailedWithPlan,
} from "../core/search-entries.js";
import type { SearchHit, SearchQueryPlan } from "../core/search-entries.js";
import type {
  AnswerableTruth,
  ReplayFixture,
  ReplayFixtureCase,
  ReplayValidationIssue,
} from "./replay-fixture.js";

const ANSWER_AT_K = 5;
const UNBOUNDED_CAP = Number.MAX_SAFE_INTEGER;

interface RatioMetric {
  readonly hits: number;
  readonly denominator: number;
  readonly rate: number | null;
}

interface MeanMetric {
  readonly sum: number;
  readonly denominator: number;
  readonly value: number | null;
}

interface ReplayCaseBase {
  readonly queryId: string;
  readonly query: string;
  readonly category: string;
}

export interface InvalidReplayCaseReport extends ReplayCaseBase {
  readonly outcome: "invalid";
  readonly issues: readonly ReplayValidationIssue[];
}

export interface AnswerableReplayCaseReport extends ReplayCaseBase {
  readonly outcome: "answer-at-5" | "rank-miss" | "candidate-miss";
  readonly knownAnswerEntryIds: readonly string[];
  readonly candidateEntryIds: readonly string[];
  readonly bestKnownAnswerRank: number | null;
  readonly reciprocalRank: number;
  readonly candidateMissReason: "lexical-match" | "relative-floor" | "candidate-cap" | null;
}

export interface NoAnswerReplayCaseReport extends ReplayCaseBase {
  readonly outcome: "no-answer-empty" | "no-answer-candidates";
  readonly candidateEntryIds: readonly string[];
}

export type ReplayCaseReport =
  | InvalidReplayCaseReport
  | AnswerableReplayCaseReport
  | NoAnswerReplayCaseReport;

export interface ReplayImplementationProvenance {
  readonly provenance: "executable-sha256";
  readonly executableSha256: string;
}

export interface LexicalReplayReport {
  readonly manifestVersion: 1;
  readonly evaluator: "lexical-replay-v1";
  readonly implementation: ReplayImplementationProvenance;
  readonly fixture: {
    readonly revision: string;
    readonly partition: ReplayFixture["partition"];
    readonly inputSha256: ReplayFixture["digests"];
  };
  readonly parameters: {
    readonly mode: "hybrid";
    readonly answerAtK: 5;
    readonly ranking: typeof SEARCH_RANKING_CONFIGURATION;
  };
  readonly validation: {
    readonly valid: boolean;
    readonly reviewRequired: boolean;
    readonly issues: readonly ReplayValidationIssue[];
  };
  readonly aggregate: {
    readonly totalQueries: number;
    readonly validQueries: number;
    readonly invalidQueries: number;
    readonly answerableQueries: number;
    readonly noAnswerQueries: number;
    readonly candidateMisses: number;
    readonly rankMisses: number;
    readonly noAnswerWithCandidates: number;
    readonly noAnswerWithoutCandidates: number;
    readonly candidateCoverage: RatioMetric;
    readonly answerAt5: RatioMetric;
    readonly meanReciprocalRank: MeanMetric;
  };
  readonly cases: readonly ReplayCaseReport[];
}

const roundMetric = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;

const ratioMetric = (hits: number, denominator: number): RatioMetric => ({
  hits,
  denominator,
  rate: denominator === 0 ? null : roundMetric(hits / denominator),
});

const baseReport = ({ query }: ReplayFixtureCase): ReplayCaseBase => ({
  queryId: query.id,
  query: query.text,
  category: query.category,
});

const hitIds = (hits: readonly SearchHit[]): readonly string[] => hits.map((hit) => hit.id);

const bestAnswerRank = (
  candidates: readonly string[],
  knownAnswerIds: ReadonlySet<string>,
): number | null => {
  const index = candidates.findIndex((candidateId) => knownAnswerIds.has(candidateId));
  return index === -1 ? null : index + 1;
};

const identifyCandidateMiss = (
  fixture: ReplayFixture,
  plan: SearchQueryPlan,
  truth: AnswerableTruth,
): AnswerableReplayCaseReport["candidateMissReason"] => {
  const knownAnswerIds = new Set(truth.answerEntryIds);
  const allMatches = searchEntriesDetailedWithPlan(
    fixture.rendered,
    fixture.rawMessages,
    plan,
    { relativeFloor: 0, cap: UNBOUNDED_CAP },
    "hybrid",
  );
  if (bestAnswerRank(hitIds(allMatches.hits), knownAnswerIds) === null) return "lexical-match";

  const afterFloor = searchEntriesDetailedWithPlan(
    fixture.rendered,
    fixture.rawMessages,
    plan,
    { relativeFloor: DEFAULT_SEARCH_TUNING.relativeFloor, cap: UNBOUNDED_CAP },
    "hybrid",
  );
  if (bestAnswerRank(hitIds(afterFloor.hits), knownAnswerIds) === null) return "relative-floor";
  return "candidate-cap";
};

const evaluateCase = (fixture: ReplayFixture, fixtureCase: ReplayFixtureCase): ReplayCaseReport => {
  const base = baseReport(fixtureCase);
  if (fixtureCase.truth.classification === "invalid") {
    return { ...base, outcome: "invalid", issues: fixtureCase.truth.issues };
  }

  const plan = planSearchQuery(fixtureCase.query.text);
  if (!plan || !plan.eligibleForReranking) {
    const queryIssue: ReplayValidationIssue = {
      code: "ineligible-query",
      queryId: fixtureCase.query.id,
      detail: "Query is outside the ordinary literal-text replay scope",
    };
    return { ...base, outcome: "invalid", issues: [queryIssue] };
  }

  const lexical = searchEntriesDetailedWithPlan(
    fixture.rendered,
    fixture.rawMessages,
    plan,
    undefined,
    "hybrid",
  );
  const candidateEntryIds = hitIds(lexical.hits);

  if (fixtureCase.truth.classification === "no-answer") {
    return {
      ...base,
      outcome: candidateEntryIds.length === 0 ? "no-answer-empty" : "no-answer-candidates",
      candidateEntryIds,
    };
  }

  const knownAnswerIds = new Set(fixtureCase.truth.answerEntryIds);
  const rank = bestAnswerRank(candidateEntryIds, knownAnswerIds);
  if (rank === null) {
    return {
      ...base,
      outcome: "candidate-miss",
      knownAnswerEntryIds: fixtureCase.truth.answerEntryIds,
      candidateEntryIds,
      bestKnownAnswerRank: null,
      reciprocalRank: 0,
      candidateMissReason: identifyCandidateMiss(fixture, plan, fixtureCase.truth),
    };
  }

  return {
    ...base,
    outcome: rank <= ANSWER_AT_K ? "answer-at-5" : "rank-miss",
    knownAnswerEntryIds: fixtureCase.truth.answerEntryIds,
    candidateEntryIds,
    bestKnownAnswerRank: rank,
    reciprocalRank: roundMetric(1 / rank),
    candidateMissReason: null,
  };
};

export const evaluateLexicalReplay = (
  fixture: ReplayFixture,
  implementation: ReplayImplementationProvenance,
): LexicalReplayReport => {
  const cases = fixture.cases.map((fixtureCase) => evaluateCase(fixture, fixtureCase));
  const caseIssues = cases.flatMap((caseReport) =>
    caseReport.outcome === "invalid" ? caseReport.issues : [],
  );
  const validationIssues = [...fixture.validationIssues, ...caseIssues];
  const answerable = cases.filter(
    (caseReport): caseReport is AnswerableReplayCaseReport =>
      caseReport.outcome === "answer-at-5" ||
      caseReport.outcome === "rank-miss" ||
      caseReport.outcome === "candidate-miss",
  );
  const noAnswer = cases.filter(
    (caseReport): caseReport is NoAnswerReplayCaseReport =>
      caseReport.outcome === "no-answer-empty" || caseReport.outcome === "no-answer-candidates",
  );
  const candidateHits = answerable.filter(
    (caseReport) => caseReport.outcome !== "candidate-miss",
  ).length;
  const firstPageHits = answerable.filter(
    (caseReport) => caseReport.outcome === "answer-at-5",
  ).length;
  const reciprocalRankSum = answerable.reduce(
    (sum, caseReport) =>
      sum + (caseReport.bestKnownAnswerRank === null ? 0 : 1 / caseReport.bestKnownAnswerRank),
    0,
  );

  return {
    manifestVersion: 1,
    evaluator: "lexical-replay-v1",
    implementation,
    fixture: {
      revision: fixture.revision,
      partition: fixture.partition,
      inputSha256: fixture.digests,
    },
    parameters: {
      mode: "hybrid",
      answerAtK: ANSWER_AT_K,
      ranking: SEARCH_RANKING_CONFIGURATION,
    },
    validation: {
      valid: validationIssues.length === 0,
      reviewRequired: validationIssues.length > 0,
      issues: validationIssues,
    },
    aggregate: {
      totalQueries: cases.length,
      validQueries:
        cases.length - cases.filter((caseReport) => caseReport.outcome === "invalid").length,
      invalidQueries: cases.filter((caseReport) => caseReport.outcome === "invalid").length,
      answerableQueries: answerable.length,
      noAnswerQueries: noAnswer.length,
      candidateMisses: answerable.filter((caseReport) => caseReport.outcome === "candidate-miss")
        .length,
      rankMisses: answerable.filter((caseReport) => caseReport.outcome === "rank-miss").length,
      noAnswerWithCandidates: noAnswer.filter(
        (caseReport) => caseReport.outcome === "no-answer-candidates",
      ).length,
      noAnswerWithoutCandidates: noAnswer.filter(
        (caseReport) => caseReport.outcome === "no-answer-empty",
      ).length,
      candidateCoverage: ratioMetric(candidateHits, answerable.length),
      answerAt5: ratioMetric(firstPageHits, answerable.length),
      meanReciprocalRank: {
        sum: roundMetric(reciprocalRankSum),
        denominator: answerable.length,
        value: answerable.length === 0 ? null : roundMetric(reciprocalRankSum / answerable.length),
      },
    },
    cases,
  };
};
