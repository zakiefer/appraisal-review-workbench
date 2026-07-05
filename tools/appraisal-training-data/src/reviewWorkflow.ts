import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertReadableDirectory, ensureDir, sha256, writeJson } from "./fileUtils.js";
import { redactAddress, redactSensitiveText } from "./redact.js";
import type { ComparableSale, JsonValue, TrainingCase } from "./types.js";
import type { ReviewPacket } from "./reviewPackets.js";

export type ReviewDecisionStatus = "approved" | "needs_revision" | "rejected" | "skipped";

export interface DecisionRow {
  case_id: string;
  status: ReviewDecisionStatus;
  reviewer: string | null;
  reviewed_at: string | null;
  notes: string | null;
}

export interface AdjustedPriceAuditDetail {
  case_id: string;
  comp_id: string;
  comp_index: number;
  classifications?: string[];
  classification?: string;
  values_conflict?: boolean;
  possible_index_misalignment?: boolean;
}

export interface ReviewCaseArtifacts {
  case_id: string;
  source_file_id: string;
  tier_1_status: string;
  tier_1_reasons: string[];
  tier_2_status: string;
  tier_2_reasons: string[];
  tier_3_status: string;
  tier_3_reasons: string[];
  subject_summary: JsonValue;
  selected_comparables_summary: JsonValue[];
  adjusted_sale_price_review: {
    manual_review_rows: number;
    rows: Array<{
      comp_id: string;
      comp_index: number;
      adjusted_sale_price_source: string;
      needs_manual_review: boolean;
      flags: string[];
    }>;
  };
  warnings: string[];
  missing_fields: string[];
  generated_training_input_case: TrainingCase["input_case"];
  generated_expert_answer: TrainingCase["expert_answer"];
  review_checklist: Array<{
    item: string;
    status: "unchecked";
    notes: null;
  }>;
  reviewer_decision: {
    status: "unreviewed";
    reviewer: null;
    reviewed_at: null;
    notes: null;
  };
}

const reviewChecklist = [
  "Subject facts are correct enough for Tier 1.",
  "Selected comps are correctly extracted.",
  "Sale prices are correct.",
  "Adjustments are correctly extracted.",
  "Adjusted sale prices are correct.",
  "Any local-filled adjusted sale prices were manually checked.",
  "Final opinion of value is correct.",
  "Reconciliation narrative is correct and appropriate.",
  "No private data leaked.",
  "Example is useful for Tier 1 selected comp / adjustment / reconciliation explanation.",
  "Example should not be used for Tier 2 or Tier 3 unless missing fields are later filled."
];

export async function loadReviewPackets(folder: string): Promise<ReviewPacket[]> {
  await assertReadableDirectory(folder);
  const packetFiles = await findReviewPacketFiles(folder);
  const packets: ReviewPacket[] = [];
  for (const packetFile of packetFiles) {
    packets.push(JSON.parse(await readFile(packetFile, "utf8")) as ReviewPacket);
  }
  return packets.sort((a, b) => a.case_id.localeCompare(b.case_id));
}

export async function loadAdjustedPriceAuditDetails(folder: string): Promise<AdjustedPriceAuditDetail[]> {
  const detailsPath = path.join(folder, "resolution_details.json");
  const parsed = JSON.parse(await readFile(detailsPath, "utf8")) as {
    details?: AdjustedPriceAuditDetail[];
  };
  return parsed.details ?? [];
}

export async function findReviewPacketFiles(folder: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (entry.isFile() && entry.name.endsWith(".review.json")) {
        files.push(entryPath);
      }
    }
  }
  await walk(folder);
  return files.sort((a, b) => a.localeCompare(b));
}

export function buildReviewCaseArtifacts(
  packet: ReviewPacket,
  auditDetails: AdjustedPriceAuditDetail[]
): ReviewCaseArtifacts {
  const normalized = packet.normalized_case;
  const trainingCase = packet.proposed_training_case;
  const notes: string[] = [];
  const detailsForCase = auditDetails.filter((detail) => detail.case_id === packet.case_id);
  const detailByCompIndex = new Map(detailsForCase.map((detail) => [detail.comp_index, detail]));
  const selectedComparables = normalized.comparables.map((comp, index) =>
    buildComparableReviewSummary(comp, index + 1, detailByCompIndex.get(index + 1))
  );

  return {
    case_id: packet.case_id,
    source_file_id: `source_${sha256(normalized.source.source_path_hash).slice(0, 12)}`,
    tier_1_status: packet.tier_status.tier_1_reconciliation_explanation,
    tier_1_reasons: packet.tier_reasons.tier_1_reconciliation_explanation,
    tier_2_status: packet.tier_status.tier_2_sales_comparison_analysis,
    tier_2_reasons: packet.tier_reasons.tier_2_sales_comparison_analysis,
    tier_3_status: packet.tier_status.tier_3_comp_selection,
    tier_3_reasons: packet.tier_reasons.tier_3_comp_selection,
    subject_summary: sanitizeJsonValue({
      property_type: normalized.subject.property_type,
      address_redacted: redactAddress(normalized.subject.address_redacted, notes),
      city: normalized.subject.city,
      state: normalized.subject.state,
      gla_sqft: normalized.subject.gla_sqft,
      bedrooms: normalized.subject.bedrooms,
      bathrooms: normalized.subject.bathrooms,
      condition: normalized.subject.condition,
      quality: normalized.subject.quality
    }) as JsonValue,
    selected_comparables_summary: selectedComparables.map((item) => sanitizeJsonValue(item) as JsonValue),
    adjusted_sale_price_review: {
      manual_review_rows: selectedComparables.filter((item) => item.needs_manual_review).length,
      rows: selectedComparables.map((item) => ({
        comp_id: item.comp_id,
        comp_index: item.comp_index,
        adjusted_sale_price_source: item.adjusted_sale_price_source,
        needs_manual_review: item.needs_manual_review,
        flags: item.adjusted_sale_price_flags
      }))
    },
    warnings: normalized.quality_flags.warnings,
    missing_fields: normalized.quality_flags.missing_fields,
    generated_training_input_case: sanitizeJsonValue(trainingCase.input_case) as TrainingCase["input_case"],
    generated_expert_answer: sanitizeJsonValue(trainingCase.expert_answer) as TrainingCase["expert_answer"],
    review_checklist: reviewChecklist.map((item) => ({
      item,
      status: "unchecked",
      notes: null
    })),
    reviewer_decision: {
      status: "unreviewed",
      reviewer: null,
      reviewed_at: null,
      notes: null
    }
  };
}

export function buildReviewMarkdown(artifacts: ReviewCaseArtifacts): string {
  return `# Tier 1 Human Review Packet

case_id: ${artifacts.case_id}
source_file_id: ${artifacts.source_file_id}

## Tier Status

| Tier | Status | Reasons |
| --- | --- | --- |
| Tier 1 | ${artifacts.tier_1_status} | ${formatListInline(artifacts.tier_1_reasons)} |
| Tier 2 | ${artifacts.tier_2_status} | ${formatListInline(artifacts.tier_2_reasons)} |
| Tier 3 | ${artifacts.tier_3_status} | ${formatListInline(artifacts.tier_3_reasons)} |

Tier 2/Tier 3 limitation: do not use this example for full sales-comparison analysis or comp selection unless missing fields are later filled and reviewed.

## Subject Summary

\`\`\`json
${JSON.stringify(artifacts.subject_summary, null, 2)}
\`\`\`

## Selected Comparables Summary

\`\`\`json
${JSON.stringify(artifacts.selected_comparables_summary, null, 2)}
\`\`\`

## Adjusted Sale Price Review

Manual adjusted-sale-price review rows: ${artifacts.adjusted_sale_price_review.manual_review_rows}

\`\`\`json
${JSON.stringify(artifacts.adjusted_sale_price_review.rows, null, 2)}
\`\`\`

## Final Opinion And Reconciliation

\`\`\`json
${JSON.stringify(artifacts.generated_expert_answer.reconciliation, null, 2)}
\`\`\`

## Warnings

${formatMarkdownList(artifacts.warnings)}

## Missing Fields

${formatMarkdownList(artifacts.missing_fields)}

## Generated Training Input Case

\`\`\`json
${JSON.stringify(artifacts.generated_training_input_case, null, 2)}
\`\`\`

## Generated Expert Answer

\`\`\`json
${JSON.stringify(artifacts.generated_expert_answer, null, 2)}
\`\`\`

## Review Checklist

${artifacts.review_checklist.map((item) => `- [ ] ${item.item}`).join("\n")}

## Reviewer Decision

status: unreviewed
reviewer:
reviewed_at:
notes:
`;
}

export function buildReviewInstructions(): string {
  return `# Tier 1 Human Review Instructions

Review each markdown packet in \`packets/\`. Do not approve a case unless a qualified human reviewer has checked the extracted facts and final answer.

Valid decision statuses:

- approved
- needs_revision
- rejected

Fill \`review_decisions.csv\` from \`review_decisions.template.csv\` using columns:

\`\`\`csv
case_id,status,reviewer,reviewed_at,notes
\`\`\`

Leave status blank for unreviewed cases. Use ISO timestamps when possible, for example \`2026-07-04T12:00:00-04:00\`.

Tier 1 review focuses on selected comps, adjustments, adjusted sale prices, final opinion of value, and reconciliation explanation. These packets are not sufficient for Tier 2 or Tier 3 unless missing condition/quality/GLA/candidate-pool data is later filled and reviewed.
`;
}

export function buildReviewIndex(artifacts: ReviewCaseArtifacts[]): string {
  const rows = artifacts
    .map(
      (item) =>
        `| ${item.case_id} | ${item.source_file_id} | ${item.tier_1_status} | ${item.adjusted_sale_price_review.manual_review_rows} | unreviewed |`
    )
    .join("\n");
  return `# Tier 1 Human Review Batch

Cases in batch: ${artifacts.length}

No cases are auto-approved. Fill \`review_decisions.csv\` explicitly before applying decisions.

| Case ID | Source File ID | Tier 1 Status | Adjusted Price Rows Needing Review | Decision |
| --- | --- | --- | ---: | --- |
${rows}
`;
}

export function buildReviewQueueCsv(artifacts: ReviewCaseArtifacts[]): string {
  return csvStringify([
    ["case_id", "source_file_id", "tier1_status", "adjusted_price_manual_review_rows", "warnings_count", "missing_fields_count"],
    ...artifacts.map((item) => [
      item.case_id,
      item.source_file_id,
      item.tier_1_status,
      String(item.adjusted_sale_price_review.manual_review_rows),
      String(item.warnings.length),
      String(item.missing_fields.length)
    ])
  ]);
}

export function buildDecisionTemplateCsv(artifacts: ReviewCaseArtifacts[]): string {
  return csvStringify([
    ["case_id", "status", "reviewer", "reviewed_at", "notes"],
    ...artifacts.map((item) => [item.case_id, "", "", "", ""])
  ]);
}

export function parseDecisionCsv(csv: string): DecisionRow[] {
  const rows = csvParse(csv);
  if (rows.length === 0) return [];
  const header = rows[0] ?? [];
  const indexes = Object.fromEntries(header.map((key, index) => [key, index]));
  for (const required of ["case_id", "status", "reviewer", "reviewed_at", "notes"]) {
    if (indexes[required] == null) throw new Error(`Missing required decisions CSV column: ${required}`);
  }

  const decisions: DecisionRow[] = [];
  for (const row of rows.slice(1)) {
    const caseId = (row[indexes.case_id] ?? "").trim();
    const status = (row[indexes.status] ?? "").trim();
    if (!caseId || !status) continue;
    if (!isReviewDecisionStatus(status)) {
      throw new Error(`Invalid review status for ${caseId}: ${status}`);
    }
    decisions.push({
      case_id: caseId,
      status,
      reviewer: nullableCell(row[indexes.reviewer]),
      reviewed_at: nullableCell(row[indexes.reviewed_at]),
      notes: nullableCell(row[indexes.notes])
    });
  }
  return decisions;
}

export async function writeReviewArtifacts(output: string, artifacts: ReviewCaseArtifacts[]): Promise<void> {
  await ensureDir(path.join(output, "packets"));
  await writeFile(path.join(output, "review_index.md"), buildReviewIndex(artifacts), "utf8");
  await writeFile(path.join(output, "review_queue.csv"), buildReviewQueueCsv(artifacts), "utf8");
  await writeFile(path.join(output, "review_decisions.template.csv"), buildDecisionTemplateCsv(artifacts), "utf8");
  await writeJson(path.join(output, "review_decisions.template.json"), {
    instructions: "Copy this file or use review_decisions.template.csv. Do not approve without human review.",
    valid_statuses: ["approved", "needs_revision", "rejected", "skipped"],
    decisions: artifacts.map((item) => ({
      case_id: item.case_id,
      status: "",
      reviewer: "",
      reviewed_at: "",
      notes: ""
    }))
  });
  await writeFile(path.join(output, "review_instructions.md"), buildReviewInstructions(), "utf8");
  await writeJson(path.join(output, "privacy_audit.json"), {
    raw_review_values_exported: true,
    output_folder_must_remain_private: true,
    real_source_filenames_exported: false,
    neutral_source_file_ids_only: true,
    full_addresses_exported: false,
    emails_phones_names_redacted: true,
    auto_approved_cases: 0
  });

  await Promise.all(
    artifacts.map(async (item) => {
      await writeJson(path.join(output, "packets", `${item.case_id}.review.json`), item);
      await writeFile(path.join(output, "packets", `${item.case_id}.review.md`), buildReviewMarkdown(item), "utf8");
    })
  );
}

export function assertPrivateOutput(output: string, label: string): void {
  const privateRoot = path.resolve("private");
  const resolvedOutput = path.resolve(output);
  if (resolvedOutput !== privateRoot && !resolvedOutput.startsWith(`${privateRoot}${path.sep}`)) {
    throw new Error(`${label} writes private review values and requires --output under ./private/`);
  }
}

function buildComparableReviewSummary(
  comp: ComparableSale,
  compIndex: number,
  auditDetail: AdjustedPriceAuditDetail | undefined
) {
  const flags = auditDetail?.classifications ?? (auditDetail?.classification ? [auditDetail.classification] : []);
  return {
    comp_id: comp.comp_id,
    comp_index: compIndex,
    address_redacted: comp.address_redacted,
    sale_price: comp.sale_price,
    net_adjustment: comp.net_adjustment,
    net_adjustment_percent: comp.net_adjustment_percent,
    gross_adjustment: comp.gross_adjustment,
    gross_adjustment_percent: comp.gross_adjustment_percent,
    adjusted_sale_price: comp.adjusted_sale_price,
    adjusted_sale_price_source: adjustedSalePriceSource(flags, auditDetail),
    needs_manual_review: adjustedSalePriceNeedsManualReview(flags, auditDetail),
    adjusted_sale_price_flags: flags,
    condition: comp.condition,
    quality: comp.quality,
    gla_sqft: comp.gla_sqft,
    total_rooms: comp.total_rooms,
    bedrooms: comp.bedrooms,
    bathrooms: comp.bathrooms,
    full_bathrooms: comp.full_bathrooms,
    half_bathrooms: comp.half_bathrooms,
    site_size: comp.site_size,
    view: comp.view,
    location: comp.location,
    property_rights: comp.property_rights,
    sales_concessions: comp.sales_concessions,
    financing_concessions: comp.financing_concessions,
    sales_price_per_gla: comp.sales_price_per_gla,
    sale_date: comp.sale_date,
    sale_date_raw: comp.sale_date_raw,
    contract_date: comp.contract_date,
    actual_age: comp.actual_age,
    year_built: comp.year_built,
    design_style: comp.design_style,
    basement_area_sqft: comp.basement_area_sqft,
    basement_finished_sqft: comp.basement_finished_sqft,
    basement_description: comp.basement_description,
    basement_finish: comp.basement_finish,
    functional_utility: comp.functional_utility,
    heating_cooling: comp.heating_cooling,
    energy_efficient: comp.energy_efficient,
    garage_carport: comp.garage_carport,
    garage_spaces: comp.garage_spaces,
    carport_spaces: comp.carport_spaces,
    porch_deck: comp.porch_deck,
    fireplaces: comp.fireplaces,
    other_features: comp.other_features,
    adjustments: comp.adjustments.map((adjustment) => ({
      field: adjustment.field,
      amount: adjustment.amount,
      description: adjustment.description
    }))
  };
}

function adjustedSalePriceSource(flags: string[], auditDetail: AdjustedPriceAuditDetail | undefined): string {
  if (flags.includes("local_filled_missing_builtin")) return "local_filled_missing_builtin";
  if (flags.includes("local_matches_arithmetic")) return "local_mapping_arithmetic_match";
  if (flags.includes("builtin_matches_arithmetic") && auditDetail?.values_conflict) return "built_in_conflict_policy";
  if (flags.includes("builtin_matches_arithmetic")) return "built_in";
  if (auditDetail?.values_conflict) return "built_in_conflict_policy";
  return "built_in_or_direct_extraction";
}

function adjustedSalePriceNeedsManualReview(flags: string[], auditDetail: AdjustedPriceAuditDetail | undefined): boolean {
  const resolvedByBuiltIn = flags.includes("builtin_matches_arithmetic");
  return (
    flags.includes("local_filled_missing_builtin") ||
    flags.includes("unresolved_needs_manual_review") ||
    flags.includes("neither_matches_arithmetic") ||
    (Boolean(auditDetail?.possible_index_misalignment) && !resolvedByBuiltIn)
  );
}

function sanitizeJsonValue(value: unknown): unknown {
  if (typeof value === "string") {
    const notes: string[] = [];
    return redactSensitiveText(value, notes);
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeJsonValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => {
        if (key.toLowerCase().includes("filename")) return [key, "[REDACTED SOURCE FILE]"];
        return [key, sanitizeJsonValue(child)];
      })
    );
  }
  return value;
}

function csvStringify(rows: string[][]): string {
  return `${rows.map((row) => row.map(csvEscape).join(",")).join("\n")}\n`;
}

function csvEscape(value: string): string {
  if (!/[",\n\r]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

function csvParse(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < csv.length; index += 1) {
    const char = csv[index];
    const next = csv[index + 1];
    if (inQuotes) {
      if (char === '"' && next === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") {
      cell += char;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((item) => item.some((cellValue) => cellValue.trim().length > 0));
}

function nullableCell(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function isReviewDecisionStatus(status: string): status is ReviewDecisionStatus {
  return ["approved", "needs_revision", "rejected", "skipped"].includes(status);
}

function formatMarkdownList(values: string[]): string {
  return values.length > 0 ? values.map((value) => `- ${value}`).join("\n") : "- None";
}

function formatListInline(values: string[]): string {
  return values.length > 0 ? values.join("; ") : "None";
}
