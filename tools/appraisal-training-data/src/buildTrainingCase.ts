import type { JsonValue, NormalizedAppraisalCase, TargetTier, TrainingCase } from "./types.js";
import { statusForTargetTier } from "./tierQuality.js";

const TASK = "explain_selected_comps_adjustments_and_reconciliation" as const;
const forbiddenInputKeys = new Set([
  "final_opinion_of_value",
  "finalOpinionOfValue",
  "appraised_value",
  "appraisedValue",
  "opinion_of_value",
  "opinionOfValue",
  "reconciled_value",
  "reconciledValue",
  "reconciliation_narrative",
  "reconciliationNarrative",
  "final_value",
  "finalValue"
]);

export function buildTrainingCase(normalizedCase: NormalizedAppraisalCase, targetTier: TargetTier = "overall"): TrainingCase {
  const inputCase = {
    metadata: {
      report_type: normalizedCase.metadata.report_type,
      form_type: normalizedCase.metadata.form_type,
      effective_date: normalizedCase.metadata.effective_date,
      inspection_date: normalizedCase.metadata.inspection_date
    },
    subject: normalizedCase.subject,
    market: normalizedCase.market,
    selected_comparables: normalizedCase.comparables,
    available_context: {
      note: "XML-derived case. Candidate/rejected comp pool may be unavailable unless explicitly present in source XML."
    }
  };

  assertNoInputLeakage(inputCase);

  return {
    case_id: normalizedCase.case_id,
    task: TASK,
    input_case: inputCase,
    expert_answer: {
      selected_comp_summary: normalizedCase.comparables.map((comp) => ({
        comp_id: comp.comp_id,
        sale_price: comp.sale_price,
        adjusted_sale_price: comp.adjusted_sale_price,
        distance_miles: comp.distance_miles,
        gla_sqft: comp.gla_sqft,
        total_rooms: comp.total_rooms,
        bedrooms: comp.bedrooms,
        bathrooms: comp.bathrooms,
        site_size: comp.site_size,
        view: comp.view,
        location: comp.location,
        actual_age: comp.actual_age,
        condition: comp.condition,
        quality: comp.quality,
        sale_date: comp.sale_date,
        financing_concessions: comp.financing_concessions,
        garage_carport: comp.garage_carport,
        basement_area_sqft: comp.basement_area_sqft,
        appraiser_comment: comp.appraiser_comment
      })) as JsonValue[],
      adjustment_summary: normalizedCase.comparables.flatMap((comp) =>
        comp.adjustments.map((adjustment) => ({
          comp_id: comp.comp_id,
          field: adjustment.field,
          amount: adjustment.amount,
          description: adjustment.description,
          raw_value: adjustment.raw_value
        }))
      ) as JsonValue[],
      reconciliation: {
        final_opinion_of_value: normalizedCase.reconciliation.final_opinion_of_value,
        indicated_value_low: normalizedCase.reconciliation.indicated_value_low,
        indicated_value_high: normalizedCase.reconciliation.indicated_value_high,
        narrative: normalizedCase.reconciliation.narrative
      },
      caveats: buildCaveats(normalizedCase)
    },
    quality: {
      status: statusForTargetTier(normalizedCase, targetTier),
      target_tier: targetTier,
      tier_status: normalizedCase.quality_flags.tier_status,
      tier_reasons: normalizedCase.quality_flags.tier_reasons,
      warnings: normalizedCase.quality_flags.warnings
    }
  };
}

export function assertNoInputLeakage(value: unknown): void {
  scanForForbiddenKeys(value, []);
}

function scanForForbiddenKeys(value: unknown, path: string[]): void {
  if (!value || typeof value !== "object") return;

  if (Array.isArray(value)) {
    value.forEach((item, index) => scanForForbiddenKeys(item, [...path, String(index)]));
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    if (forbiddenInputKeys.has(key)) {
      throw new Error(`Training input leakage detected at ${[...path, key].join(".")}`);
    }
    if (key === "reconciliation" && child && typeof child === "object") {
      const record = child as Record<string, unknown>;
      if (typeof record.narrative === "string" && record.narrative.trim().length > 0) {
        throw new Error(`Training input leakage detected at ${[...path, key, "narrative"].join(".")}`);
      }
    }
    scanForForbiddenKeys(child, [...path, key]);
  }
}

function buildCaveats(normalizedCase: NormalizedAppraisalCase): string[] {
  const caveats = new Set<string>();
  caveats.add("Candidate XML-derived training data requires review by a qualified human appraiser before use.");
  caveats.add("Selected comparables only do not teach full comparable selection unless a candidate/rejected comp pool is present.");

  for (const warning of normalizedCase.quality_flags.warnings) {
    caveats.add(`Warning: ${warning}`);
  }

  return [...caveats];
}
