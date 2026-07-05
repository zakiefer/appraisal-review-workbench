import { assertNoInputLeakage } from "./buildTrainingCase.js";
import type { ReviewPacket } from "./reviewPackets.js";
import {
  buildReviewCaseArtifacts,
  type AdjustedPriceAuditDetail,
  type DecisionRow,
  type ReviewCaseArtifacts,
  type ReviewDecisionStatus
} from "./reviewWorkflow.js";

export type ReviewRecommendationLevel = "green" | "yellow" | "red";
export type ReviewUiStatus = ReviewDecisionStatus | "unreviewed";

export interface ReviewDecisionDraft {
  case_id: string;
  status: ReviewDecisionStatus;
  reviewer?: string | null;
  reviewed_at?: string | null;
  notes?: string | null;
}

export interface ReviewUiCase {
  case_id: string;
  source_file_id: string;
  decision_status: ReviewUiStatus;
  decision: {
    status: ReviewUiStatus;
    reviewer: string | null;
    reviewed_at: string | null;
    notes: string | null;
  };
  recommendation: {
    level: ReviewRecommendationLevel;
    label: string;
    reasons: string[];
  };
  tier: {
    tier1_status: string;
    tier1_reasons: string[];
    tier2_status: string;
    tier2_reasons: string[];
    tier3_status: string;
    tier3_reasons: string[];
  };
  subject: ReviewCaseArtifacts["subject_summary"];
  comps: Array<{
    comp_id: string;
    comp_index: number;
    sale_price: number | null;
    sales_price_per_gla: number | null;
    net_adjustment: number | null;
    net_adjustment_percent: number | null;
    gross_adjustment: number | null;
    gross_adjustment_percent: number | null;
    expected_adjusted_sale_price: number | null;
    adjusted_sale_price: number | null;
    adjusted_price_source: "built-in" | "local-filled" | "arithmetic-resolved" | "unresolved" | "missing";
    adjusted_price_badge:
      | "Pass"
      | "Filled missing"
      | "Conflict resolved by built-in"
      | "Needs human check"
      | "Missing";
    needs_manual_attention: boolean;
    condition: string | null;
    quality: string | null;
    gla_sqft: number | null;
    total_rooms: number | null;
    bedrooms: number | null;
    bathrooms: number | null;
    full_bathrooms: number | null;
    half_bathrooms: number | null;
    site_size: string | null;
    view: string | null;
    location: string | null;
    property_rights: string | null;
    sales_concessions: string | null;
    financing_concessions: string | null;
    sale_date: string | null;
    sale_date_raw: string | null;
    contract_date: string | null;
    actual_age: number | null;
    year_built: number | null;
    design_style: string | null;
    basement_area_sqft: number | null;
    basement_finished_sqft: number | null;
    basement_description: string | null;
    basement_finish: string | null;
    functional_utility: string | null;
    heating_cooling: string | null;
    energy_efficient: string | null;
    garage_carport: string | null;
    garage_spaces: number | null;
    carport_spaces: number | null;
    porch_deck: string | null;
    fireplaces: string | null;
    other_features: string[];
    warning_badge: string | null;
  }>;
  adjustment_sanity: Array<{
    comp_id: string;
    comp_index: number;
    sale_price: number | null;
    net_adjustment: number | null;
    expected_adjusted_sale_price: number | null;
    adjusted_sale_price: number | null;
    badge: string;
  }>;
  reconciliation: {
    final_opinion_of_value: number | null;
    narrative: string | null;
    caveats: string[];
  };
  warnings: string[];
  missing_fields: string[];
  training_example: {
    input_case: ReviewCaseArtifacts["generated_training_input_case"];
    expert_answer: ReviewCaseArtifacts["generated_expert_answer"];
  };
  privacy: PrivacyScanResult;
  final_value_leakage: boolean;
}

export interface ReviewUiState {
  generated_at: string;
  cases: ReviewUiCase[];
  progress: ReviewProgress;
  privacy: PrivacyScanResult;
}

export interface ReviewProgress {
  total: number;
  reviewed: number;
  approved: number;
  needs_revision: number;
  rejected: number;
  skipped: number;
  unreviewed: number;
  green: number;
  yellow: number;
  red: number;
  adjusted_price_rows_needing_attention: number;
}

export interface PrivacyScanResult {
  email: number;
  phone: number;
  full_street_address: number;
  private_name_label: number;
  license_or_private_id: number;
}

const decisionStatuses = new Set<ReviewDecisionStatus>(["approved", "needs_revision", "rejected", "skipped"]);
const benignTierOneWarnings = new Set([
  "missing_subject_condition",
  "missing_subject_quality",
  "missing_subject_gla",
  "missing_comparable_gla",
  "selected_comps_only_candidate_pool_unavailable",
  "redacted_postal_code",
  "redacted_street_address"
]);

export function buildReviewUiState(input: {
  packets: ReviewPacket[];
  auditDetails: AdjustedPriceAuditDetail[];
  decisions?: DecisionRow[];
  generatedAt?: Date;
}): ReviewUiState {
  const decisionByCaseId = new Map((input.decisions ?? []).map((decision) => [decision.case_id, decision]));
  const cases = input.packets
    .map((packet) => buildReviewCaseArtifacts(packet, input.auditDetails))
    .map((artifacts) => buildReviewUiCase(artifacts, decisionByCaseId.get(artifacts.case_id)))
    .sort((a, b) => a.case_id.localeCompare(b.case_id));
  return {
    generated_at: (input.generatedAt ?? new Date()).toISOString(),
    cases,
    progress: buildReviewProgress(cases),
    privacy: scanPrivacyRisk(cases)
  };
}

export function buildReviewUiCase(artifacts: ReviewCaseArtifacts, decision?: DecisionRow): ReviewUiCase {
  const comps = artifacts.selected_comparables_summary.map((item) => {
    const comp = item as Record<string, unknown>;
    const salePrice = numberOrNull(comp.sale_price);
    const netAdjustment = numberOrNull(comp.net_adjustment);
    const adjustedSalePrice = numberOrNull(comp.adjusted_sale_price);
    const expected = salePrice != null && netAdjustment != null ? salePrice + netAdjustment : null;
    const flags = stringArray(comp.adjusted_sale_price_flags);
    const source = adjustedPriceSourceLabel(String(comp.adjusted_sale_price_source ?? ""), adjustedSalePrice);
    const needsManualAttention = Boolean(comp.needs_manual_review);
    const badge = adjustedPriceBadge({
      source,
      needsManualAttention,
      expected,
      adjustedSalePrice,
      flags
    });
    return {
      comp_id: String(comp.comp_id ?? ""),
      comp_index: Number(comp.comp_index ?? 0),
      sale_price: salePrice,
      sales_price_per_gla: numberOrNull(comp.sales_price_per_gla),
      net_adjustment: netAdjustment,
      net_adjustment_percent: numberOrNull(comp.net_adjustment_percent),
      gross_adjustment: numberOrNull(comp.gross_adjustment),
      gross_adjustment_percent: numberOrNull(comp.gross_adjustment_percent),
      expected_adjusted_sale_price: expected,
      adjusted_sale_price: adjustedSalePrice,
      adjusted_price_source: source,
      adjusted_price_badge: badge,
      needs_manual_attention: needsManualAttention,
      condition: stringOrNull(comp.condition),
      quality: stringOrNull(comp.quality),
      gla_sqft: numberOrNull(comp.gla_sqft),
      total_rooms: numberOrNull(comp.total_rooms),
      bedrooms: numberOrNull(comp.bedrooms),
      bathrooms: numberOrNull(comp.bathrooms),
      full_bathrooms: numberOrNull(comp.full_bathrooms),
      half_bathrooms: numberOrNull(comp.half_bathrooms),
      site_size: stringOrNull(comp.site_size),
      view: stringOrNull(comp.view),
      location: stringOrNull(comp.location),
      property_rights: stringOrNull(comp.property_rights),
      sales_concessions: stringOrNull(comp.sales_concessions),
      financing_concessions: stringOrNull(comp.financing_concessions),
      sale_date: stringOrNull(comp.sale_date),
      sale_date_raw: stringOrNull(comp.sale_date_raw),
      contract_date: stringOrNull(comp.contract_date),
      actual_age: numberOrNull(comp.actual_age),
      year_built: numberOrNull(comp.year_built),
      design_style: stringOrNull(comp.design_style),
      basement_area_sqft: numberOrNull(comp.basement_area_sqft),
      basement_finished_sqft: numberOrNull(comp.basement_finished_sqft),
      basement_description: stringOrNull(comp.basement_description),
      basement_finish: stringOrNull(comp.basement_finish),
      functional_utility: stringOrNull(comp.functional_utility),
      heating_cooling: stringOrNull(comp.heating_cooling),
      energy_efficient: stringOrNull(comp.energy_efficient),
      garage_carport: stringOrNull(comp.garage_carport),
      garage_spaces: numberOrNull(comp.garage_spaces),
      carport_spaces: numberOrNull(comp.carport_spaces),
      porch_deck: stringOrNull(comp.porch_deck),
      fireplaces: stringOrNull(comp.fireplaces),
      other_features: stringArray(comp.other_features),
      warning_badge: needsManualAttention ? "Needs human check" : null
    };
  });

  const inputLeakage = hasInputLeakage(artifacts.generated_training_input_case);
  const privacy = scanPrivacyRisk(artifacts);
  const warnings = artifacts.warnings;
  const missingFields = artifacts.missing_fields;
  const recommendation = recommendCase({
    tier1Status: artifacts.tier_1_status,
    finalValue: artifacts.generated_expert_answer.reconciliation.final_opinion_of_value,
    narrative: artifacts.generated_expert_answer.reconciliation.narrative,
    comparableCount: comps.length,
    adjustedPresent: comps.some((comp) => comp.adjusted_sale_price != null),
    manualAdjustedRows: comps.filter((comp) => comp.needs_manual_attention).length,
    unresolvedAdjustedRows: comps.filter((comp) => comp.adjusted_price_source === "unresolved").length,
    warnings,
    missingFields,
    inputLeakage,
    privacy
  });

  return {
    case_id: artifacts.case_id,
    source_file_id: artifacts.source_file_id,
    decision_status: decision?.status ?? "unreviewed",
    decision: {
      status: decision?.status ?? "unreviewed",
      reviewer: decision?.reviewer ?? null,
      reviewed_at: decision?.reviewed_at ?? null,
      notes: decision?.notes ?? null
    },
    recommendation,
    tier: {
      tier1_status: artifacts.tier_1_status,
      tier1_reasons: artifacts.tier_1_reasons,
      tier2_status: artifacts.tier_2_status,
      tier2_reasons: artifacts.tier_2_reasons,
      tier3_status: artifacts.tier_3_status,
      tier3_reasons: artifacts.tier_3_reasons
    },
    subject: artifacts.subject_summary,
    comps,
    adjustment_sanity: comps.map((comp) => ({
      comp_id: comp.comp_id,
      comp_index: comp.comp_index,
      sale_price: comp.sale_price,
      net_adjustment: comp.net_adjustment,
      expected_adjusted_sale_price: comp.expected_adjusted_sale_price,
      adjusted_sale_price: comp.adjusted_sale_price,
      badge: comp.adjusted_price_badge
    })),
    reconciliation: {
      final_opinion_of_value: artifacts.generated_expert_answer.reconciliation.final_opinion_of_value,
      narrative: artifacts.generated_expert_answer.reconciliation.narrative,
      caveats: artifacts.generated_expert_answer.caveats
    },
    warnings,
    missing_fields: missingFields,
    training_example: {
      input_case: artifacts.generated_training_input_case,
      expert_answer: artifacts.generated_expert_answer
    },
    privacy,
    final_value_leakage: inputLeakage
  };
}

export function recommendCase(input: {
  tier1Status: string;
  finalValue: unknown;
  narrative: unknown;
  comparableCount: number;
  adjustedPresent: boolean;
  manualAdjustedRows: number;
  unresolvedAdjustedRows: number;
  warnings: string[];
  missingFields: string[];
  inputLeakage: boolean;
  privacy: PrivacyScanResult;
}): ReviewUiCase["recommendation"] {
  const reasons: string[] = [];
  const finalValuePresent = input.finalValue != null;
  const narrativePresent = typeof input.narrative === "string" && input.narrative.trim().length > 0;
  const privacyRisk = privacyTotal(input.privacy) > 0;
  const severeWarnings = input.warnings.filter((warning) =>
    ["unknown_xml_format", "no_usable_appraisal_data_found", "redaction_uncertain", "parse_path_low_confidence"].includes(warning)
  );

  if (input.comparableCount === 0) reasons.push("No selected comparables were extracted.");
  if (!finalValuePresent && !narrativePresent) reasons.push("No final value or reconciliation narrative was extracted.");
  if (severeWarnings.length > 0) reasons.push(`Severe warning: ${severeWarnings.join(", ")}`);
  if (privacyRisk) reasons.push("Potential privacy pattern detected in review data.");
  if (input.inputLeakage) reasons.push("Final value appears in the generated input_case.");
  if (input.unresolvedAdjustedRows > 0) reasons.push("One or more adjusted sale prices are unresolved.");

  if (reasons.length > 0) {
    return {
      level: "red",
      label: "Likely reject or needs fix",
      reasons
    };
  }

  const yellowReasons: string[] = [];
  if (input.manualAdjustedRows > 0) yellowReasons.push("Local-filled adjusted sale price rows need human checking.");
  if (!narrativePresent) yellowReasons.push("Reconciliation narrative is missing.");
  if (!finalValuePresent) yellowReasons.push("Final opinion of value is missing.");
  if (input.tier1Status !== "candidate") yellowReasons.push(`Tier 1 status is ${input.tier1Status}.`);
  const importantWarnings = input.warnings.filter((warning) => !benignTierOneWarnings.has(warning));
  if (importantWarnings.length > 0) yellowReasons.push(`Review warning: ${importantWarnings.join(", ")}`);
  if (input.missingFields.includes("missing_adjusted_sale_price")) {
    yellowReasons.push("Adjusted sale price is missing for at least one comparable.");
  }

  if (yellowReasons.length > 0) {
    return {
      level: "yellow",
      label: "Needs attention before approval",
      reasons: yellowReasons
    };
  }

  if (
    input.tier1Status === "candidate" &&
    finalValuePresent &&
    narrativePresent &&
    input.comparableCount > 0 &&
    input.adjustedPresent
  ) {
    return {
      level: "green",
      label: "Looks suitable for Tier 1 review",
      reasons: ["Tier 1 facts are present and no automatic blockers were found."]
    };
  }

  return {
    level: "yellow",
    label: "Needs attention before approval",
    reasons: ["Review this case before approval."]
  };
}

export function validateDecisionDraft(decision: ReviewDecisionDraft): string[] {
  const errors: string[] = [];
  if (!decision.case_id) errors.push("Missing case_id.");
  if (!decisionStatuses.has(decision.status)) errors.push(`Invalid status: ${decision.status}`);
  if (
    ["needs_revision", "rejected"].includes(decision.status) &&
    (!decision.notes || decision.notes.trim().length === 0)
  ) {
    errors.push("Notes are required for Needs Fix and Reject.");
  }
  return errors;
}

export function normalizeDecisionDraft(decision: ReviewDecisionDraft, now = new Date()): DecisionRow {
  const errors = validateDecisionDraft(decision);
  if (errors.length > 0) throw new Error(errors.join(" "));
  return {
    case_id: decision.case_id,
    status: decision.status,
    reviewer: decision.reviewer?.trim() || "Zachary",
    reviewed_at: decision.reviewed_at?.trim() || now.toISOString(),
    notes: decision.notes?.trim() || null
  };
}

export function bulkApproveGreenCases(
  state: ReviewUiState,
  existingDecisions: DecisionRow[] = [],
  reviewer = "Zachary",
  now = new Date()
): DecisionRow[] {
  const decisions = new Map(existingDecisions.map((decision) => [decision.case_id, decision]));
  for (const item of state.cases) {
    if (item.recommendation.level !== "green") continue;
    const existing = decisions.get(item.case_id);
    if (existing && existing.status !== "skipped") continue;
    decisions.set(item.case_id, {
      case_id: item.case_id,
      status: "approved",
      reviewer,
      reviewed_at: now.toISOString(),
      notes: "Bulk approved after reviewer confirmation."
    });
  }
  return [...decisions.values()].sort((a, b) => a.case_id.localeCompare(b.case_id));
}

export function decisionsToCsv(decisions: DecisionRow[], allCaseIds: string[] = []): string {
  const decisionByCaseId = new Map(decisions.map((decision) => [decision.case_id, decision]));
  const caseIds = allCaseIds.length > 0 ? allCaseIds : [...decisionByCaseId.keys()].sort((a, b) => a.localeCompare(b));
  const rows = [["case_id", "status", "reviewer", "reviewed_at", "notes"]];
  for (const caseId of caseIds) {
    const decision = decisionByCaseId.get(caseId);
    rows.push([
      caseId,
      decision?.status ?? "",
      decision?.reviewer ?? "",
      decision?.reviewed_at ?? "",
      decision?.notes ?? ""
    ]);
  }
  return `${rows.map((row) => row.map(csvEscape).join(",")).join("\n")}\n`;
}

export function decisionsToJson(decisions: DecisionRow[]): {
  decisions: DecisionRow[];
} {
  return { decisions: decisions.sort((a, b) => a.case_id.localeCompare(b.case_id)) };
}

export function buildReviewProgress(cases: ReviewUiCase[]): ReviewProgress {
  return {
    total: cases.length,
    reviewed: cases.filter((item) => item.decision_status !== "unreviewed").length,
    approved: cases.filter((item) => item.decision_status === "approved").length,
    needs_revision: cases.filter((item) => item.decision_status === "needs_revision").length,
    rejected: cases.filter((item) => item.decision_status === "rejected").length,
    skipped: cases.filter((item) => item.decision_status === "skipped").length,
    unreviewed: cases.filter((item) => item.decision_status === "unreviewed").length,
    green: cases.filter((item) => item.recommendation.level === "green").length,
    yellow: cases.filter((item) => item.recommendation.level === "yellow").length,
    red: cases.filter((item) => item.recommendation.level === "red").length,
    adjusted_price_rows_needing_attention: cases.reduce(
      (sum, item) => sum + item.comps.filter((comp) => comp.needs_manual_attention).length,
      0
    )
  };
}

export function scanPrivacyRisk(value: unknown): PrivacyScanResult {
  const text = JSON.stringify(value);
  return {
    email: countMatches(text, /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi),
    phone: countMatches(text, /(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/g),
    full_street_address: countMatches(
      text,
      /\b\d{1,6}\s+[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,5}\s+(?:st|street|ave|avenue|rd|road|dr|drive|ln|lane|ct|court|cir|circle|blvd|boulevard|pkwy|parkway|pl|place|ter|terrace|way)\b\.?/gi
    ),
    private_name_label: countMatches(text, /\b(?:borrower|client|appraiser)\s*[:\-]\s*[A-Z][A-Za-z'.-]+/gi),
    license_or_private_id: countMatches(
      text,
      /\b(?:license|lic\.?|certification|cert\.?|loan|file|client|borrower|parcel)\s*(?:#|id|number|no\.?)?\s*[:\-]?\s*[A-Z0-9-]{4,}\b/gi
    )
  };
}

export function privacyTotal(result: PrivacyScanResult): number {
  return Object.values(result).reduce((sum, value) => sum + value, 0);
}

function adjustedPriceSourceLabel(
  source: string,
  adjustedSalePrice: number | null
): ReviewUiCase["comps"][number]["adjusted_price_source"] {
  if (adjustedSalePrice == null) return "missing";
  if (source === "local_filled_missing_builtin") return "local-filled";
  if (source === "local_mapping_arithmetic_match") return "arithmetic-resolved";
  if (source === "built_in_conflict_policy" || source === "built_in" || source === "built_in_or_direct_extraction") {
    return "built-in";
  }
  return "unresolved";
}

function adjustedPriceBadge(input: {
  source: ReviewUiCase["comps"][number]["adjusted_price_source"];
  needsManualAttention: boolean;
  expected: number | null;
  adjustedSalePrice: number | null;
  flags: string[];
}): ReviewUiCase["comps"][number]["adjusted_price_badge"] {
  if (input.adjustedSalePrice == null) return "Missing";
  if (input.needsManualAttention) return input.source === "local-filled" ? "Filled missing" : "Needs human check";
  if (input.flags.includes("builtin_matches_arithmetic") && input.flags.includes("possible_index_misalignment")) {
    return "Conflict resolved by built-in";
  }
  if (input.expected != null && Math.abs((input.adjustedSalePrice ?? 0) - input.expected) <= 5) return "Pass";
  if (input.source === "built-in") return "Pass";
  return "Needs human check";
}

function hasInputLeakage(inputCase: unknown): boolean {
  try {
    assertNoInputLeakage(inputCase);
    return false;
  } catch {
    return true;
  }
}

function countMatches(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function csvEscape(value: string): string {
  if (!/[",\n\r]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}
