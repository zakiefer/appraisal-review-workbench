import type { NormalizedAppraisalCase, QualityStatus, TargetTier, TierKey } from "./types.js";
import { countMeaningfulValues } from "./xmlValueFinder.js";

export const tierKeys = [
  "tier_1_reconciliation_explanation",
  "tier_2_sales_comparison_analysis",
  "tier_3_comp_selection"
] as const satisfies readonly TierKey[];

export const targetTierToKey: Record<Exclude<TargetTier, "overall">, TierKey> = {
  tier1: "tier_1_reconciliation_explanation",
  tier2: "tier_2_sales_comparison_analysis",
  tier3: "tier_3_comp_selection"
};

export function emptyTierStatus(status: QualityStatus = "needs_review"): Record<TierKey, QualityStatus> {
  return {
    tier_1_reconciliation_explanation: status,
    tier_2_sales_comparison_analysis: status,
    tier_3_comp_selection: status
  };
}

export function emptyTierReasons(): Record<TierKey, string[]> {
  return {
    tier_1_reconciliation_explanation: [],
    tier_2_sales_comparison_analysis: [],
    tier_3_comp_selection: []
  };
}

export function evaluateTierQuality(normalizedCase: NormalizedAppraisalCase): {
  tierStatus: Record<TierKey, QualityStatus>;
  tierReasons: Record<TierKey, string[]>;
} {
  const tierReasons = emptyTierReasons();
  const tierStatus = emptyTierStatus("needs_review");

  const subjectMeaningfulFields = countMeaningfulValues(normalizedCase.subject);
  const comparableCount = normalizedCase.comparables.length;
  const hasComparables = comparableCount > 0;
  const hasSalePrice = normalizedCase.comparables.some((comp) => comp.sale_price != null);
  const hasAdjustedSalePrice = normalizedCase.comparables.some((comp) => comp.adjusted_sale_price != null);
  const hasAdjustments = normalizedCase.comparables.some((comp) => comp.adjustments.length > 0);
  const hasFinalValue = normalizedCase.reconciliation.final_opinion_of_value != null;
  const hasNarrative = Boolean(normalizedCase.reconciliation.narrative?.trim());
  const severeWarnings = normalizedCase.quality_flags.warnings.filter((warning) =>
    ["unknown_xml_format", "no_usable_appraisal_data_found", "redaction_uncertain"].includes(warning)
  );

  pushIf(tierReasons.tier_1_reconciliation_explanation, subjectMeaningfulFields < 3, "subject_has_fewer_than_three_meaningful_fields");
  pushIf(tierReasons.tier_1_reconciliation_explanation, !hasComparables, "missing_selected_comparables");
  pushIf(
    tierReasons.tier_1_reconciliation_explanation,
    !hasSalePrice && !hasAdjustedSalePrice,
    "missing_comparable_sale_or_adjusted_price"
  );
  pushIf(
    tierReasons.tier_1_reconciliation_explanation,
    !hasAdjustments && !hasAdjustedSalePrice,
    "missing_adjustments_or_adjusted_values"
  );
  pushIf(tierReasons.tier_1_reconciliation_explanation, !hasFinalValue && !hasNarrative, "missing_final_value_or_reconciliation_narrative");
  tierReasons.tier_1_reconciliation_explanation.push(...severeWarnings);

  tierStatus.tier_1_reconciliation_explanation =
    normalizedCase.quality_flags.status === "rejected"
      ? "rejected"
      : tierReasons.tier_1_reconciliation_explanation.length === 0
        ? "candidate"
        : "needs_review";

  if (tierStatus.tier_1_reconciliation_explanation !== "candidate") {
    tierReasons.tier_2_sales_comparison_analysis.push("tier_1_not_candidate");
  }
  pushIf(
    tierReasons.tier_2_sales_comparison_analysis,
    normalizedCase.subject.condition == null && normalizedCase.subject.quality == null,
    "missing_subject_condition_or_quality"
  );
  pushIf(
    tierReasons.tier_2_sales_comparison_analysis,
    comparableCoverage(normalizedCase, (comp) => comp.condition) < 0.8,
    "insufficient_comparable_condition_coverage"
  );
  pushIf(
    tierReasons.tier_2_sales_comparison_analysis,
    comparableCoverage(normalizedCase, (comp) => comp.quality) < 0.8,
    "insufficient_comparable_quality_coverage"
  );
  pushIf(
    tierReasons.tier_2_sales_comparison_analysis,
    comparableCoverage(normalizedCase, (comp) => comp.gla_sqft) < 0.8,
    "insufficient_comparable_gla_coverage"
  );
  pushIf(
    tierReasons.tier_2_sales_comparison_analysis,
    comparableCoverage(normalizedCase, (comp) => comp.sale_date) < 0.8,
    "insufficient_comparable_sale_date_coverage"
  );
  pushIf(tierReasons.tier_2_sales_comparison_analysis, !hasFinalValue && !hasNarrative, "missing_final_value_or_reconciliation_narrative");

  tierStatus.tier_2_sales_comparison_analysis =
    normalizedCase.quality_flags.status === "rejected"
      ? "rejected"
      : tierReasons.tier_2_sales_comparison_analysis.length === 0
        ? "candidate"
        : "needs_review";

  if (tierStatus.tier_2_sales_comparison_analysis !== "candidate") {
    tierReasons.tier_3_comp_selection.push("tier_2_not_candidate");
  }
  if (!hasCandidateCompPool(normalizedCase)) {
    tierReasons.tier_3_comp_selection.push("candidate_or_rejected_comp_pool_unavailable");
  }

  tierStatus.tier_3_comp_selection =
    normalizedCase.quality_flags.status === "rejected"
      ? "rejected"
      : tierReasons.tier_3_comp_selection.length === 0
        ? "candidate"
        : "needs_review";

  return { tierStatus, tierReasons };
}

export function statusForTargetTier(normalizedCase: NormalizedAppraisalCase, targetTier: TargetTier): QualityStatus {
  if (targetTier === "overall") return normalizedCase.quality_flags.status;
  return normalizedCase.quality_flags.tier_status[targetTierToKey[targetTier]];
}

function pushIf(reasons: string[], condition: boolean, reason: string): void {
  if (condition) reasons.push(reason);
}

function comparableCoverage(normalizedCase: NormalizedAppraisalCase, getValue: (comp: NormalizedAppraisalCase["comparables"][number]) => unknown): number {
  if (normalizedCase.comparables.length === 0) return 0;
  const populated = normalizedCase.comparables.filter((comp) => hasValue(getValue(comp))).length;
  return populated / normalizedCase.comparables.length;
}

function hasValue(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function hasCandidateCompPool(normalizedCase: NormalizedAppraisalCase): boolean {
  return !normalizedCase.quality_flags.warnings.includes("selected_comps_only_candidate_pool_unavailable");
}
