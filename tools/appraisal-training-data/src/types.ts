export const PARSER_VERSION = "appraisal-training-data-v0.1.0";

export type DetectedXmlType =
  | "uad_like"
  | "mismo_like"
  | "generic_appraisal_xml"
  | "unknown_xml";

export type QualityStatus = "candidate" | "needs_review" | "rejected";
export type TierKey =
  | "tier_1_reconciliation_explanation"
  | "tier_2_sales_comparison_analysis"
  | "tier_3_comp_selection";
export type TargetTier = "overall" | "tier1" | "tier2" | "tier3";
export type AdjustedPriceConflictPolicy =
  | "audit_only"
  | "local_override"
  | "builtin_wins"
  | "arithmetic_resolver"
  | "disable_local";

export interface AdjustedPriceConflictStats {
  policy: AdjustedPriceConflictPolicy;
  tolerance_dollars: number;
  comparable_rows_checked: number;
  arithmetic_checks_available: number;
  conflicts_count: number;
  conflicts_resolved_by_local: number;
  conflicts_resolved_by_builtin: number;
  conflicts_resolved_by_arithmetic: number;
  conflicts_unresolved: number;
  local_mapping_filled_missing_count: number;
  local_mapping_disabled_count: number;
  possible_index_misalignment_count: number;
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface AppraisalSource {
  filename: string;
  source_path_hash: string;
  source_format: "xml";
  detected_xml_type: DetectedXmlType | null;
  parsed_at: string;
  parser_version: string;
}

export interface AppraisalMetadata {
  report_type: string | null;
  form_type: string | null;
  loan_purpose: string | null;
  appraisal_purpose: string | null;
  effective_date: string | null;
  inspection_date: string | null;
  report_date: string | null;
}

export interface SubjectProperty {
  property_type: string | null;
  address_redacted: string | null;
  city: string | null;
  state: string | null;
  postal_code_redacted: string | null;
  county: string | null;
  neighborhood: string | null;
  site_size: string | null;
  gla_sqft: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  year_built: number | null;
  condition: string | null;
  quality: string | null;
  view: string | null;
  design_style: string | null;
  basement: string | null;
  garage_carport: string | null;
}

export interface MarketInfo {
  market_conditions: string | null;
  marketing_time: string | null;
  neighborhood_price_trend: string | null;
  supply_demand: string | null;
  location_description: string | null;
}

export interface ComparableAdjustment {
  field: string;
  amount: number | null;
  description: string | null;
  raw_value: string | null;
}

export interface ComparableSale {
  comp_id: string;
  address_redacted: string | null;
  city: string | null;
  state: string | null;
  postal_code_redacted: string | null;
  distance_miles: number | null;
  sale_price: number | null;
  sales_price_per_gla?: number | null;
  sale_date: string | null;
  sale_date_raw?: string | null;
  contract_date?: string | null;
  data_source: string | null;
  verification_source: string | null;
  property_rights?: string | null;
  sales_concessions?: string | null;
  financing_concessions?: string | null;
  gla_sqft: number | null;
  total_rooms?: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  full_bathrooms?: number | null;
  half_bathrooms?: number | null;
  year_built: number | null;
  actual_age?: number | null;
  condition: string | null;
  quality: string | null;
  site_size: string | null;
  view: string | null;
  location: string | null;
  design_style?: string | null;
  basement_area_sqft?: number | null;
  basement_finished_sqft?: number | null;
  basement_description?: string | null;
  basement_finish?: string | null;
  functional_utility?: string | null;
  heating_cooling?: string | null;
  energy_efficient?: string | null;
  garage_carport?: string | null;
  garage_spaces?: number | null;
  carport_spaces?: number | null;
  porch_deck?: string | null;
  fireplaces?: string | null;
  other_features?: string[] | null;
  adjustments: ComparableAdjustment[];
  net_adjustment: number | null;
  net_adjustment_percent?: number | null;
  gross_adjustment: number | null;
  gross_adjustment_percent?: number | null;
  adjusted_sale_price: number | null;
  appraiser_comment: string | null;
}

export interface Reconciliation {
  indicated_value_low: number | null;
  indicated_value_high: number | null;
  final_opinion_of_value: number | null;
  sales_comparison_indicated_value: number | null;
  cost_approach_indicated_value: number | null;
  income_approach_indicated_value: number | null;
  narrative: string | null;
  confidence: string | null;
}

export interface AppraiserComments {
  subject_comments: string | null;
  comp_comments: string | null;
  market_comments: string | null;
  reconciliation_comments: string | null;
  extra_comments: string | null;
}

export interface QualityFlags {
  status: QualityStatus;
  tier_status: Record<TierKey, QualityStatus>;
  tier_reasons: Record<TierKey, string[]>;
  adjusted_price_conflict_stats: AdjustedPriceConflictStats;
  warnings: string[];
  missing_fields: string[];
  redaction_notes: string[];
  parser_notes: string[];
}

export interface NormalizedAppraisalCase {
  case_id: string;
  source: AppraisalSource;
  metadata: AppraisalMetadata;
  subject: SubjectProperty;
  market: MarketInfo;
  comparables: ComparableSale[];
  reconciliation: Reconciliation;
  appraiser_comments: AppraiserComments;
  quality_flags: QualityFlags;
}

export interface TrainingInputCase {
  metadata: Pick<
    AppraisalMetadata,
    "report_type" | "form_type" | "effective_date" | "inspection_date"
  >;
  subject: SubjectProperty;
  market: MarketInfo;
  selected_comparables: ComparableSale[];
  available_context: {
    note: string;
  };
}

export interface TrainingCase {
  case_id: string;
  task: "explain_selected_comps_adjustments_and_reconciliation";
  input_case: TrainingInputCase;
  expert_answer: {
    selected_comp_summary: JsonValue[];
    adjustment_summary: JsonValue[];
    reconciliation: Pick<
      Reconciliation,
      "final_opinion_of_value" | "indicated_value_low" | "indicated_value_high" | "narrative"
    >;
    caveats: string[];
  };
  quality: {
    status: QualityStatus;
    target_tier: TargetTier;
    tier_status: Record<TierKey, QualityStatus>;
    tier_reasons: Record<TierKey, string[]>;
    warnings: string[];
  };
}

export interface JsonlMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface JsonlTrainingLine {
  messages: JsonlMessage[];
  metadata: {
    case_id: string;
    task: TrainingCase["task"];
    quality_status: QualityStatus;
    target_tier: TargetTier;
    tier_status: Record<TierKey, QualityStatus>;
  };
}

export interface RejectedFile {
  filename: string;
  reason: string;
}

export interface Manifest {
  run_id: string;
  created_at: string;
  parser_version: string;
  input_folder: string;
  output_folder: string;
  redaction_enabled: boolean;
  eval_ratio: number;
  seed: number;
  counts: {
    xml_files_found: number;
    parsed: number;
    normalized: number;
    candidate: number;
    needs_review: number;
    rejected: number;
    train_lines: number;
    eval_lines: number;
  };
  target_tier: TargetTier;
  tier_counts: Record<TierKey, Record<QualityStatus, number>>;
  adjusted_price_conflict_policy: AdjustedPriceConflictPolicy;
  adjusted_price_conflict_stats: AdjustedPriceConflictStats;
  warnings_by_type: Record<string, number>;
  rejected_files: RejectedFile[];
}

export interface WarningReportEntry {
  case_id: string;
  filename: string;
  status: QualityStatus;
  warnings: string[];
  missing_fields: string[];
  redaction_notes: string[];
  parser_notes: string[];
  tier_status: Record<TierKey, QualityStatus>;
  tier_reasons: Record<TierKey, string[]>;
}

export interface CliOptions {
  input: string;
  output: string;
  evalRatio: number;
  seed: number;
  redact: boolean;
  includeNeedsReview: boolean;
  allowUnredactedOutput?: boolean;
  emitReviewPackets?: boolean;
  mapping?: string | null;
  repairs?: string | null;
  targetTier?: TargetTier;
  adjustedPriceConflictPolicy?: AdjustedPriceConflictPolicy;
}
