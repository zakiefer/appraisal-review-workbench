import path from "node:path";
import type { NormalizedAppraisalCase, QualityStatus, TierKey, TrainingCase } from "./types.js";
import { ensureDir, writeJson } from "./fileUtils.js";

export interface ReviewPacket {
  case_id: string;
  normalized_case: NormalizedAppraisalCase;
  proposed_training_case: TrainingCase;
  warnings: string[];
  missing_fields: string[];
  tier_status: Record<TierKey, QualityStatus>;
  tier_reasons: Record<TierKey, string[]>;
  review_checklist: Array<{
    item: string;
    status: "unchecked";
    notes: null;
  }>;
  reviewer_decision: {
    status: "unreviewed" | "approved" | "rejected" | "needs_revision" | "needs_changes" | "skipped";
    reviewer: string | null;
    reviewed_at: string | null;
    notes: string | null;
  };
}

const checklistSections: Record<string, string[]> = {
  "Tier 1 selected comp / reconciliation explanation": [
    "Subject basics sufficient for context?",
    "Selected comps extracted correctly?",
    "Sale or adjusted sale prices correct?",
    "Adjustments or adjusted values correct?",
    "Final value or reconciliation narrative correct?",
    "Caveats explain missing Tier 2 facts?"
  ],
  "Tier 2 full sales comparison analysis": [
    "Subject condition or quality present?",
    "Comparable condition and quality present?",
    "Comparable GLA present for most comps?",
    "Comparable sale dates present for most comps?",
    "Full sales comparison facts sufficient?"
  ],
  "Tier 3 comp selection": [
    "Candidate/rejected comp pool available?",
    "Rejected comps or selection alternatives present?",
    "Market data supports comp-selection reasoning?"
  ],
  "Privacy and approval": [
    "No private data leaked?",
    "Safe for candidate training/eval?",
    "Human appraiser approved this packet?"
  ]
};

export function buildReviewPacket(normalizedCase: NormalizedAppraisalCase, trainingCase: TrainingCase): ReviewPacket {
  return {
    case_id: normalizedCase.case_id,
    normalized_case: normalizedCase,
    proposed_training_case: trainingCase,
    warnings: normalizedCase.quality_flags.warnings,
    missing_fields: normalizedCase.quality_flags.missing_fields,
    tier_status: normalizedCase.quality_flags.tier_status,
    tier_reasons: normalizedCase.quality_flags.tier_reasons,
    review_checklist: Object.entries(checklistSections).flatMap(([section, items]) =>
      items.map((item) => ({
        item: `${section}: ${item}`,
        status: "unchecked" as const,
        notes: null
      }))
    ),
    reviewer_decision: {
      status: "unreviewed",
      reviewer: null,
      reviewed_at: null,
      notes: null
    }
  };
}

export async function writeReviewPackets(
  outputFolder: string,
  pairs: Array<{ normalizedCase: NormalizedAppraisalCase; trainingCase: TrainingCase }>
): Promise<void> {
  const reviewDir = path.join(outputFolder, "review_packets");
  await ensureDir(reviewDir);
  await Promise.all(
    pairs.map(({ normalizedCase, trainingCase }) =>
      writeJson(path.join(reviewDir, `${normalizedCase.case_id}.review.json`), buildReviewPacket(normalizedCase, trainingCase))
    )
  );
}
