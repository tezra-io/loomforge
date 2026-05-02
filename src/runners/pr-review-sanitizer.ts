import type { PrReviewFinding, PrReviewResult, ProjectCompletionIssue } from "../workflow/types.js";

const MIN_NGRAM_WORDS = 8;

export interface SanitizationReport {
  removedFindings: number;
  summaryRedacted: boolean;
}

export interface SanitizationOutcome {
  result: PrReviewResult;
  report: SanitizationReport;
}

export function sanitizePrReview(
  review: PrReviewResult,
  issues: ProjectCompletionIssue[],
): SanitizationOutcome {
  const forbidden = collectForbiddenTexts(issues);
  if (forbidden.length === 0) {
    return { result: review, report: { removedFindings: 0, summaryRedacted: false } };
  }

  const kept: PrReviewFinding[] = [];
  let removed = 0;
  for (const finding of review.findings) {
    if (findingLeaks(finding, forbidden)) {
      removed += 1;
      continue;
    }
    kept.push(finding);
  }

  const summaryLeaks = textLeaks(review.summary, forbidden);
  const summary = summaryLeaks
    ? "Reviewer summary suppressed: contained Linear issue text."
    : review.summary;
  const outcome = kept.length === 0 && review.outcome === "findings" ? "pass" : review.outcome;

  return {
    result: { ...review, outcome, findings: kept, summary },
    report: { removedFindings: removed, summaryRedacted: summaryLeaks },
  };
}

function findingLeaks(finding: PrReviewFinding, forbidden: string[][]): boolean {
  return textLeaks(finding.title, forbidden) || textLeaks(finding.detail, forbidden);
}

function textLeaks(text: string, forbidden: string[][]): boolean {
  const words = normalize(text);
  if (words.length < MIN_NGRAM_WORDS) return false;
  const grams = ngrams(words, MIN_NGRAM_WORDS);
  for (const banned of forbidden) {
    for (const gram of grams) {
      if (banned.includes(gram)) return true;
    }
  }
  return false;
}

function collectForbiddenTexts(issues: ProjectCompletionIssue[]): string[][] {
  const forbidden: string[][] = [];
  for (const issue of issues) {
    pushNgrams(forbidden, issue.description);
    pushNgrams(forbidden, issue.acceptanceCriteria);
  }
  return forbidden;
}

function pushNgrams(target: string[][], source: string | null): void {
  if (!source) return;
  const words = normalize(source);
  if (words.length < MIN_NGRAM_WORDS) return;
  target.push(ngrams(words, MIN_NGRAM_WORDS));
}

function normalize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0);
}

function ngrams(words: string[], n: number): string[] {
  const result: string[] = [];
  for (let i = 0; i + n <= words.length; i += 1) {
    result.push(words.slice(i, i + n).join(" "));
  }
  return result;
}
