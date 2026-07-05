import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { LocalFieldMappingFile } from "./localMapping.js";
import type { PrivacyScanResult, ReviewProgress } from "./reviewUiData.js";

export interface ReviewWorkbenchOptions {
  reviewBatch: string;
  reviewPackets: string;
  conflictAudit: string;
  output: string;
  workspaceRoot?: string;
}

export interface WorkbenchState {
  generated_at: string;
  paths: {
    input_folder: string | null;
    review_batch: string;
    review_packets: string;
    conflict_audit: string;
    session_output: string;
    training_output: string;
    inspection_output: string | null;
    mapping_file: string | null;
    mapping_review: string | null;
    mapping_validation: string | null;
    approved_export: string | null;
  };
  pipeline: {
    run_id: string | null;
    target_tier: string | null;
    redaction_enabled: boolean | null;
    counts: Record<string, number>;
    tier_counts: Record<string, Record<string, number>>;
    adjusted_price_conflict_policy: string | null;
    adjusted_price_conflict_stats: Record<string, unknown> | null;
    warnings_by_type: Array<{ warning: string; count: number }>;
  };
  intake: {
    xml_files_found: number | null;
    parsed: number | null;
    parse_failures: number | null;
    inspection_grid_rows: number | null;
    safe_value_profile_rows: number | null;
    discovery_candidates: number | null;
  };
  mapping: {
    verified_count: number;
    verified_fields: Array<{ field: string; count: number }>;
    verified_mappings: Array<{
      field: string;
      path: string;
      strategy: string;
      confidence: string | null;
      notes: string | null;
    }>;
    review_targets: Array<{
      target: string;
      candidates: number;
      likely_accept: number;
      needs_manual_review: number;
      likely_reject: number;
      top_candidates: Array<{
        path: string;
        score: number;
        context: string;
        recommendation: string;
        dominant_shape: string | null;
      }>;
    }>;
    validation: {
      xml_files_found: number | null;
      parsed: number | null;
      parse_failures: number | null;
      verified_mappings_loaded: number | null;
      applications: Array<{
        field: string;
        path: string;
        value_count: number;
        filled_count: number;
        conflict_count: number;
      }>;
      target_coverage: Array<{
        field: string;
        before_pct: number | null;
        after_pct: number | null;
        delta_pct: number | null;
      }>;
    };
  };
  review: {
    progress: ReviewProgress;
    packet_files: number;
    decision_file: string;
  };
  repairs: {
    red_cases: number;
    needs_revision_cases: number;
    parser_warning_cases: number;
    adjusted_attention_rows: number;
    top_blockers: Array<{ blocker: string; count: number }>;
  };
  export: {
    approved_manifest: Record<string, unknown> | null;
    train_lines: number | null;
    eval_lines: number | null;
    all_lines: number | null;
  };
  audit: {
    privacy_sources: Array<{ name: string; total: number; details: Record<string, unknown> }>;
    privacy_total: number;
    final_value_leakage_cases: number | null;
    raw_xml_included: boolean | null;
    conflict_summary: Record<string, unknown> | null;
  };
  stages: Array<{
    id: string;
    label: string;
    status: "ready" | "attention" | "blocked";
    detail: string;
  }>;
}

const targetFields = [
  "subject.condition",
  "subject.quality",
  "comparables.gla_sqft",
  "comparables.condition",
  "comparables.quality",
  "comparables.sale_date",
  "comparables.adjusted_sale_price",
  "reconciliation.final_opinion_of_value",
  "reconciliation.narrative"
];

export async function buildWorkbenchState(
  options: ReviewWorkbenchOptions,
  progress: ReviewProgress,
  privacy: PrivacyScanResult
): Promise<WorkbenchState> {
  const workspaceRoot = options.workspaceRoot ?? process.cwd();
  const trainingOutput = path.resolve(path.dirname(options.reviewPackets));
  const reportsRoot = path.join(trainingOutput, "reports");
  const manifest = asRecord(await readJsonIfExists(path.join(reportsRoot, "manifest.json")));
  const fieldCoverage = asRecordArray(await readJsonIfExists(path.join(reportsRoot, "field_coverage.json")));
  const inspectionOutput = await firstExistingDirectory([
    path.join(workspaceRoot, "private", "appraisal-xml-inspection-real"),
    path.join(workspaceRoot, "private", "appraisal-xml-inspection-synthetic")
  ]);
  const mappingFile = await firstExistingFile([path.join(workspaceRoot, "private", "appraisal-field-mapping.local.json")]);
  const mappingReviewOutput = await firstExistingDirectory([
    path.join(workspaceRoot, "private", "appraisal-mapping-review"),
    path.join(workspaceRoot, "private", "appraisal-mapping-review-with-values")
  ]);
  const mappingValidationOutput = await firstExistingDirectory([
    path.join(workspaceRoot, "private", "appraisal-mapping-validation")
  ]);
  const approvedExportOutput = await firstExistingDirectory([
    path.join(workspaceRoot, "private", "approved-training-export"),
    path.join(workspaceRoot, "private", "approved-training-export-empty")
  ]);

  const mappingFileJson = mappingFile ? (asRecord(await readJsonIfExists(mappingFile)) as unknown as LocalFieldMappingFile) : null;
  const verifiedMappings = summarizeVerifiedMappings(mappingFileJson);
  const mappingReview = mappingReviewOutput
    ? summarizeMappingReview(asRecord(await readJsonIfExists(path.join(mappingReviewOutput, "mapping_review_packets.json"))))
    : [];
  const validation = mappingValidationOutput
    ? summarizeMappingValidation(
        asRecord(await readJsonIfExists(path.join(mappingValidationOutput, "mapping_validation.json"))),
        fieldCoverage
      )
    : emptyMappingValidation();
  const approvedManifest = approvedExportOutput
    ? asRecord(await readJsonIfExists(path.join(approvedExportOutput, "reports", "approved_manifest.json")))
    : null;
  const inspectionGridRows = inspectionOutput
    ? asRecordArray(await readJsonIfExists(path.join(inspectionOutput, "grid_inventory.json"))).length
    : null;
  const safeValueProfileRows = inspectionOutput
    ? asRecordArray(await readJsonIfExists(path.join(inspectionOutput, "safe_value_profile.json"))).length
    : null;
  const discoveryCandidates = await countJsonArrayFile(path.join(workspaceRoot, "private", "appraisal-field-discovery", "discovery_candidates.json"));
  const conflictSummary = asRecord(await readJsonIfExists(path.join(path.resolve(options.conflictAudit), "index_alignment_check.json"))) ??
    asRecord(await readJsonIfExists(path.join(path.resolve(options.conflictAudit), "privacy_audit.json")));
  const privacySources = await collectPrivacySources([
    ["Review batch", path.join(path.resolve(options.reviewBatch), "privacy_audit.json")],
    ["Review UI", path.join(path.resolve(options.output), "privacy_audit.json")],
    ["Inspection", inspectionOutput ? path.join(inspectionOutput, "privacy_audit.json") : null],
    ["Mapping review", mappingReviewOutput ? path.join(mappingReviewOutput, "privacy_audit.json") : null],
    ["Mapping validation", mappingValidationOutput ? path.join(mappingValidationOutput, "privacy_audit.json") : null]
  ]);

  const packetFiles = await countReviewPacketFiles(options.reviewPackets);
  const warningsByType = warningEntries(asRecord(manifest?.warnings_by_type));
  const manifestCounts = asRecord(manifest?.counts);
  const xmlFilesFound = numberOrNull(manifestCounts?.xml_files_found);
  const parsed = numberOrNull(manifestCounts?.parsed);
  const paths = {
    input_folder: stringOrNull(manifest?.input_folder),
    review_batch: path.resolve(options.reviewBatch),
    review_packets: path.resolve(options.reviewPackets),
    conflict_audit: path.resolve(options.conflictAudit),
    session_output: path.resolve(options.output),
    training_output: trainingOutput,
    inspection_output: inspectionOutput,
    mapping_file: mappingFile,
    mapping_review: mappingReviewOutput,
    mapping_validation: mappingValidationOutput,
    approved_export: approvedExportOutput
  };

  const state: WorkbenchState = {
    generated_at: new Date().toISOString(),
    paths,
    pipeline: {
      run_id: stringOrNull(manifest?.run_id),
      target_tier: stringOrNull(manifest?.target_tier),
      redaction_enabled: typeof manifest?.redaction_enabled === "boolean" ? manifest.redaction_enabled : null,
      counts: numberRecord(manifest?.counts),
      tier_counts: nestedNumberRecord(manifest?.tier_counts),
      adjusted_price_conflict_policy: stringOrNull(manifest?.adjusted_price_conflict_policy),
      adjusted_price_conflict_stats: asRecord(manifest?.adjusted_price_conflict_stats),
      warnings_by_type: warningsByType
    },
    intake: {
      xml_files_found: xmlFilesFound,
      parsed,
      parse_failures: xmlFilesFound != null && parsed != null
        ? Math.max(0, xmlFilesFound - parsed)
        : null,
      inspection_grid_rows: inspectionGridRows,
      safe_value_profile_rows: safeValueProfileRows,
      discovery_candidates: discoveryCandidates
    },
    mapping: {
      verified_count: verifiedMappings.length,
      verified_fields: summarizeVerifiedFields(verifiedMappings),
      verified_mappings: verifiedMappings,
      review_targets: mappingReview,
      validation
    },
    review: {
      progress,
      packet_files: packetFiles,
      decision_file: path.join(path.resolve(options.output), "review_decisions.csv")
    },
    repairs: {
      red_cases: progress.red,
      needs_revision_cases: progress.needs_revision,
      parser_warning_cases: warningsByType.reduce((sum, item) => sum + (item.warning.includes("parse") ? item.count : 0), 0),
      adjusted_attention_rows: progress.adjusted_price_rows_needing_attention,
      top_blockers: warningsByType.slice(0, 8).map((item) => ({ blocker: item.warning, count: item.count }))
    },
    export: {
      approved_manifest: approvedManifest,
      train_lines: approvedExportOutput ? await countJsonlLines(path.join(approvedExportOutput, "exports", "train.jsonl")) : null,
      eval_lines: approvedExportOutput ? await countJsonlLines(path.join(approvedExportOutput, "exports", "eval.jsonl")) : null,
      all_lines: approvedExportOutput ? await countJsonlLines(path.join(approvedExportOutput, "exports", "all.jsonl")) : null
    },
    audit: {
      privacy_sources: privacySources,
      privacy_total: privacySources.reduce((sum, item) => sum + item.total, 0),
      final_value_leakage_cases: numberOrNull(asRecord(await readJsonIfExists(path.join(path.resolve(options.output), "privacy_audit.json")))?.final_value_leakage_cases),
      raw_xml_included: booleanOrNull(asRecord(await readJsonIfExists(path.join(path.resolve(options.output), "privacy_audit.json")))?.raw_xml_included),
      conflict_summary: conflictSummary
    },
    stages: []
  };

  state.stages = buildStages(state, privacy);
  return state;
}

function buildStages(state: WorkbenchState, privacy: PrivacyScanResult): WorkbenchState["stages"] {
  const privacyTotal = Object.values(privacy).reduce((sum, value) => sum + value, 0) + state.audit.privacy_total;
  return [
    {
      id: "intake",
      label: "Import & inspect",
      status: state.intake.xml_files_found && state.intake.parsed === state.intake.xml_files_found ? "ready" : "attention",
      detail: `${state.intake.parsed ?? 0}/${state.intake.xml_files_found ?? 0} XMLs parsed`
    },
    {
      id: "mapping",
      label: "Mapping",
      status: state.mapping.verified_count > 0 ? "ready" : "attention",
      detail: `${state.mapping.verified_count} verified mapping${state.mapping.verified_count === 1 ? "" : "s"}`
    },
    {
      id: "review",
      label: "Tier review",
      status: state.review.progress.unreviewed === 0 ? "ready" : "attention",
      detail: `${state.review.progress.reviewed}/${state.review.progress.total} reviewed`
    },
    {
      id: "repairs",
      label: "Repairs",
      status: state.repairs.red_cases === 0 && state.repairs.adjusted_attention_rows === 0 ? "ready" : "attention",
      detail: `${state.repairs.red_cases} red case${state.repairs.red_cases === 1 ? "" : "s"}`
    },
    {
      id: "export",
      label: "Approved export",
      status: state.export.all_lines && state.export.all_lines > 0 ? "ready" : "attention",
      detail: `${state.export.all_lines ?? 0} approved line${state.export.all_lines === 1 ? "" : "s"}`
    },
    {
      id: "audit",
      label: "Privacy audit",
      status: privacyTotal === 0 && state.audit.final_value_leakage_cases === 0 ? "ready" : "blocked",
      detail: privacyTotal === 0 ? "No patterns found" : `${privacyTotal} privacy pattern${privacyTotal === 1 ? "" : "s"}`
    }
  ];
}

function summarizeVerifiedMappings(mappingFile: LocalFieldMappingFile | null): WorkbenchState["mapping"]["verified_mappings"] {
  const mappings = mappingFile?.mappings ?? {};
  const output: WorkbenchState["mapping"]["verified_mappings"] = [];
  for (const [field, entries] of Object.entries(mappings)) {
    for (const entry of entries ?? []) {
      if (!entry.verified && entry.confidence !== "manual_verified") continue;
      output.push({
        field,
        path: entry.path,
        strategy: entry.strategy,
        confidence: entry.confidence ?? null,
        notes: entry.notes ?? null
      });
    }
  }
  return output.sort((a, b) => a.field.localeCompare(b.field) || a.path.localeCompare(b.path));
}

function summarizeVerifiedFields(
  mappings: WorkbenchState["mapping"]["verified_mappings"]
): WorkbenchState["mapping"]["verified_fields"] {
  const counts = new Map<string, number>();
  for (const mapping of mappings) counts.set(mapping.field, (counts.get(mapping.field) ?? 0) + 1);
  return [...counts.entries()].map(([field, count]) => ({ field, count })).sort((a, b) => a.field.localeCompare(b.field));
}

function summarizeMappingReview(root: Record<string, unknown> | null): WorkbenchState["mapping"]["review_targets"] {
  const packets = asRecordArray(root?.packets);
  return packets.map((packet) => {
    const candidates = asRecordArray(packet.candidates);
    return {
      target: stringOrNull(packet.target) ?? "unknown",
      candidates: candidates.length,
      likely_accept: candidates.filter((item) => item.recommendation === "likely_accept").length,
      needs_manual_review: candidates.filter((item) => item.recommendation === "needs_manual_review").length,
      likely_reject: candidates.filter((item) => item.recommendation === "likely_reject").length,
      top_candidates: candidates.slice(0, 4).map((item) => ({
        path: stringOrNull(item.path) ?? "",
        score: numberOrNull(item.score) ?? 0,
        context: stringOrNull(item.context) ?? "unknown",
        recommendation: stringOrNull(item.recommendation) ?? "unknown",
        dominant_shape: stringOrNull(asRecord(item.value_shape_summary)?.dominant_shape)
      }))
    };
  });
}

function summarizeMappingValidation(
  root: Record<string, unknown> | null,
  currentCoverage: Array<Record<string, unknown>>
): WorkbenchState["mapping"]["validation"] {
  const before = coverageMap(asRecordArray(root?.coverage_before));
  const withMapping = coverageMap(asRecordArray(root?.coverage_with_mapping));
  const fallback = coverageMap(currentCoverage);
  return {
    xml_files_found: numberOrNull(root?.xml_files_found),
    parsed: numberOrNull(root?.parsed),
    parse_failures: numberOrNull(root?.parse_failures),
    verified_mappings_loaded: numberOrNull(root?.verified_mappings_loaded),
    applications: asRecordArray(root?.mapping_applications).slice(0, 20).map((item) => ({
      field: stringOrNull(item.field) ?? "",
      path: stringOrNull(item.path) ?? "",
      value_count: numberOrNull(item.value_count) ?? 0,
      filled_count: numberOrNull(item.filled_count) ?? 0,
      conflict_count: numberOrNull(item.conflict_count) ?? 0
    })),
    target_coverage: targetFields.map((field) => {
      const beforePct = before.get(field) ?? fallback.get(field) ?? null;
      const afterPct = withMapping.get(field) ?? fallback.get(field) ?? null;
      return {
        field,
        before_pct: beforePct,
        after_pct: afterPct,
        delta_pct: beforePct != null && afterPct != null ? afterPct - beforePct : null
      };
    })
  };
}

function emptyMappingValidation(): WorkbenchState["mapping"]["validation"] {
  return {
    xml_files_found: null,
    parsed: null,
    parse_failures: null,
    verified_mappings_loaded: null,
    applications: [],
    target_coverage: targetFields.map((field) => ({
      field,
      before_pct: null,
      after_pct: null,
      delta_pct: null
    }))
  };
}

function coverageMap(rows: Array<Record<string, unknown>>): Map<string, number> {
  const map = new Map<string, number>();
  for (const row of rows) {
    const field = stringOrNull(row.field);
    const coverage = numberOrNull(row.coverage_pct);
    if (field && coverage != null) map.set(field, coverage);
  }
  return map;
}

async function collectPrivacySources(
  sources: Array<[string, string | null]>
): Promise<WorkbenchState["audit"]["privacy_sources"]> {
  const output: WorkbenchState["audit"]["privacy_sources"] = [];
  for (const [name, filePath] of sources) {
    if (!filePath) continue;
    const details = asRecord(await readJsonIfExists(filePath));
    if (!details) continue;
    output.push({
      name,
      total: privacyTotal(details),
      details
    });
  }
  return output;
}

function privacyTotal(record: Record<string, unknown>): number {
  if (typeof record.privacy_pattern_total === "number") return record.privacy_pattern_total;
  const counts = asRecord(record.privacy_pattern_counts);
  if (counts) {
    return Object.values(counts).reduce<number>((sum, value) => sum + (typeof value === "number" ? value : 0), 0);
  }
  return 0;
}

function warningEntries(record: Record<string, unknown> | null): Array<{ warning: string; count: number }> {
  return Object.entries(record ?? {})
    .map(([warning, count]) => ({ warning, count: typeof count === "number" ? count : 0 }))
    .filter((item) => item.count > 0)
    .sort((a, b) => b.count - a.count || a.warning.localeCompare(b.warning));
}

async function countReviewPacketFiles(folder: string): Promise<number> {
  try {
    const files = await listFilesRecursive(path.resolve(folder));
    return files.filter((file) => file.endsWith(".review.json")).length;
  } catch {
    return 0;
  }
}

async function countJsonArrayFile(filePath: string): Promise<number | null> {
  const parsed = await readJsonIfExists(filePath);
  if (Array.isArray(parsed)) return parsed.length;
  if (isRecord(parsed)) {
    const candidates = asRecordArray(parsed.candidates);
    if (candidates.length > 0) return candidates.length;
  }
  return null;
}

async function countJsonlLines(filePath: string): Promise<number | null> {
  try {
    const text = await readFile(filePath, "utf8");
    return text.split("\n").filter((line) => line.trim().length > 0).length;
  } catch {
    return null;
  }
}

async function listFilesRecursive(folder: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(entryPath);
      else if (entry.isFile()) files.push(entryPath);
    }
  }
  await walk(folder);
  return files.sort((a, b) => a.localeCompare(b));
}

async function firstExistingDirectory(candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isDirectory()) return path.resolve(candidate);
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

async function firstExistingFile(candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) return path.resolve(candidate);
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

async function readJsonIfExists(filePath: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberRecord(value: unknown): Record<string, number> {
  const record = asRecord(value);
  if (!record) return {};
  return Object.fromEntries(
    Object.entries(record).filter((entry): entry is [string, number] => typeof entry[1] === "number")
  );
}

function nestedNumberRecord(value: unknown): Record<string, Record<string, number>> {
  const record = asRecord(value);
  if (!record) return {};
  const output: Record<string, Record<string, number>> = {};
  for (const [key, child] of Object.entries(record)) output[key] = numberRecord(child);
  return output;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}
