import type { NormalizedAppraisalCase, QualityStatus } from "./types.js";
import { evaluateTierQuality } from "./tierQuality.js";
import { countMeaningfulValues } from "./xmlValueFinder.js";

export function validateNormalizedCase(normalizedCase: NormalizedAppraisalCase): NormalizedAppraisalCase {
  const copy = structuredClone(normalizedCase);
  const warnings = new Set(copy.quality_flags.warnings);
  const missingFields = new Set(copy.quality_flags.missing_fields);

  const subjectMeaningfulFields = countMeaningfulValues(copy.subject);
  if (subjectMeaningfulFields < 3) {
    warnings.add("subject_has_fewer_than_three_meaningful_fields");
    missingFields.add("minimum_subject_fields");
  }

  if (copy.comparables.length === 0) {
    warnings.add("missing_comparables");
    missingFields.add("comparables");
  }

  const hasReconciliationObject = copy.reconciliation != null && typeof copy.reconciliation === "object";
  if (!hasReconciliationObject) {
    warnings.add("missing_reconciliation");
    missingFields.add("reconciliation");
  }

  const hasAnyAppraisalSignal =
    subjectMeaningfulFields > 0 ||
    copy.comparables.length > 0 ||
    Object.values(copy.reconciliation).some((value) => value !== null && value !== undefined);

  let status: QualityStatus = "needs_review";
  const meetsMinimumCandidate =
    Boolean(copy.case_id) &&
    Boolean(copy.source.filename) &&
    subjectMeaningfulFields >= 3 &&
    copy.comparables.length >= 1 &&
    hasReconciliationObject;

  if (!hasAnyAppraisalSignal) {
    status = "rejected";
    warnings.add("no_usable_appraisal_data_found");
  } else if (meetsMinimumCandidate && copy.quality_flags.parser_notes.length === 0) {
    status = hasReviewTriggeringWarnings(warnings) ? "needs_review" : "candidate";
  } else if (meetsMinimumCandidate) {
    status = "needs_review";
  }

  copy.quality_flags = {
    ...copy.quality_flags,
    status,
    warnings: [...warnings],
    missing_fields: [...missingFields]
  };
  const tierQuality = evaluateTierQuality(copy);
  copy.quality_flags.tier_status = tierQuality.tierStatus;
  copy.quality_flags.tier_reasons = tierQuality.tierReasons;

  return copy;
}

function hasReviewTriggeringWarnings(warnings: Set<string>): boolean {
  const reviewWarnings = new Set([
    "missing_subject_gla",
    "missing_subject_condition",
    "missing_subject_quality",
    "missing_comparable_sale_price",
    "missing_comparable_gla",
    "missing_adjusted_sale_price",
    "missing_final_opinion_of_value",
    "unknown_xml_format",
    "reconciliation_narrative_missing",
    "parse_path_low_confidence",
    "redaction_uncertain",
    "subject_has_fewer_than_three_meaningful_fields"
  ]);

  return [...warnings].some((warning) => reviewWarnings.has(warning));
}
