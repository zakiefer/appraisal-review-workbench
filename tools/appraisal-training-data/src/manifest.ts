import path from "node:path";
import {
  DEFAULT_ADJUSTED_PRICE_CONFLICT_POLICY,
  mergeAdjustedPriceConflictStats
} from "./adjustedPricePolicy.js";
import type {
  AdjustedPriceConflictPolicy,
  Manifest,
  NormalizedAppraisalCase,
  QualityStatus,
  RejectedFile,
  TrainingCase,
  WarningReportEntry
} from "./types.js";
import { PARSER_VERSION } from "./types.js";
import { tierKeys } from "./tierQuality.js";

export interface BuildManifestInput {
  inputFolder: string;
  outputFolder: string;
  redactionEnabled: boolean;
  evalRatio: number;
  seed: number;
  xmlFilesFound: number;
  parsed: number;
  normalizedCases: NormalizedAppraisalCase[];
  rejectedFiles: RejectedFile[];
  trainCases: TrainingCase[];
  evalCases: TrainingCase[];
  targetTier?: Manifest["target_tier"];
  adjustedPriceConflictPolicy?: AdjustedPriceConflictPolicy;
  createdAt?: Date;
}

export function buildManifest(input: BuildManifestInput): Manifest {
  const createdAt = input.createdAt ?? new Date();
  const adjustedPriceConflictPolicy =
    input.adjustedPriceConflictPolicy ??
    input.normalizedCases[0]?.quality_flags.adjusted_price_conflict_stats.policy ??
    DEFAULT_ADJUSTED_PRICE_CONFLICT_POLICY;
  const rejectedCount =
    input.rejectedFiles.length + input.normalizedCases.filter((item) => item.quality_flags.status === "rejected").length;

  return {
    run_id: `run_${createdAt.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`,
    created_at: createdAt.toISOString(),
    parser_version: PARSER_VERSION,
    input_folder: path.resolve(input.inputFolder),
    output_folder: path.resolve(input.outputFolder),
    redaction_enabled: input.redactionEnabled,
    eval_ratio: input.evalRatio,
    seed: input.seed,
    counts: {
      xml_files_found: input.xmlFilesFound,
      parsed: input.parsed,
      normalized: input.normalizedCases.length,
      candidate: input.normalizedCases.filter((item) => item.quality_flags.status === "candidate").length,
      needs_review: input.normalizedCases.filter((item) => item.quality_flags.status === "needs_review").length,
      rejected: rejectedCount,
      train_lines: input.trainCases.length,
      eval_lines: input.evalCases.length
    },
    target_tier: input.targetTier ?? "overall",
    tier_counts: buildTierCounts(input.normalizedCases),
    adjusted_price_conflict_policy: adjustedPriceConflictPolicy,
    adjusted_price_conflict_stats: mergeAdjustedPriceConflictStats(
      input.normalizedCases.map((item) => item.quality_flags.adjusted_price_conflict_stats),
      adjustedPriceConflictPolicy
    ),
    warnings_by_type: buildWarningsByType(input.normalizedCases),
    rejected_files: [
      ...input.rejectedFiles,
      ...input.normalizedCases
        .filter((item) => item.quality_flags.status === "rejected")
        .map((item) => ({
          filename: item.source.filename,
          reason: item.quality_flags.warnings.join(", ") || "rejected"
        }))
    ]
  };
}

export function buildWarningReport(cases: NormalizedAppraisalCase[]): WarningReportEntry[] {
  return cases.map((normalizedCase) => ({
    case_id: normalizedCase.case_id,
    filename: normalizedCase.source.filename,
    status: normalizedCase.quality_flags.status,
    warnings: normalizedCase.quality_flags.warnings,
    missing_fields: normalizedCase.quality_flags.missing_fields,
    redaction_notes: normalizedCase.quality_flags.redaction_notes,
    parser_notes: normalizedCase.quality_flags.parser_notes,
    tier_status: normalizedCase.quality_flags.tier_status,
    tier_reasons: normalizedCase.quality_flags.tier_reasons
  }));
}

function buildTierCounts(cases: NormalizedAppraisalCase[]): Manifest["tier_counts"] {
  const makeEmptyCounts = (): Record<QualityStatus, number> => ({
    candidate: 0,
    needs_review: 0,
    rejected: 0
  });
  const counts = Object.fromEntries(tierKeys.map((tier) => [tier, makeEmptyCounts()])) as Manifest["tier_counts"];
  for (const normalizedCase of cases) {
    for (const tier of tierKeys) {
      counts[tier][normalizedCase.quality_flags.tier_status[tier]] += 1;
    }
  }
  return counts;
}

function buildWarningsByType(cases: NormalizedAppraisalCase[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const normalizedCase of cases) {
    for (const warning of normalizedCase.quality_flags.warnings) {
      counts[warning] = (counts[warning] ?? 0) + 1;
    }
    for (const note of normalizedCase.quality_flags.redaction_notes) {
      counts[note] = (counts[note] ?? 0) + 1;
    }
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}
