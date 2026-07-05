import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ComparableSale, JsonValue, NormalizedAppraisalCase } from "./types.js";
import {
  normalizeCurrency,
  normalizeDate,
  normalizeNumber,
  normalizeSquareFeet
} from "./xmlValueFinder.js";

export type CaseRepairStatus = "applied" | "needs_mapping" | "ignored";

export interface CaseRepairEntry {
  id?: string;
  target: string;
  comp_index?: number | null;
  value?: JsonValue;
  status?: CaseRepairStatus;
  reviewer?: string | null;
  note?: string | null;
  source?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface CaseRepairOverlay {
  version: 1;
  case_id: string;
  source_file_id?: string | null;
  reviewer?: string | null;
  updated_at: string;
  repairs: CaseRepairEntry[];
}

export interface ApplyRepairResult {
  normalizedCase: NormalizedAppraisalCase;
  appliedCount: number;
  parserNotes: string[];
  warnings: string[];
}

const comparableNumericFields = new Set<keyof ComparableSale>([
  "distance_miles",
  "sales_price_per_gla",
  "gla_sqft",
  "total_rooms",
  "bedrooms",
  "bathrooms",
  "full_bathrooms",
  "half_bathrooms",
  "year_built",
  "actual_age",
  "basement_area_sqft",
  "basement_finished_sqft",
  "garage_spaces",
  "carport_spaces",
  "net_adjustment_percent",
  "gross_adjustment_percent"
]);

const comparableCurrencyFields = new Set<keyof ComparableSale>([
  "sale_price",
  "net_adjustment",
  "gross_adjustment",
  "adjusted_sale_price"
]);

const comparableDateFields = new Set<keyof ComparableSale>(["sale_date", "contract_date"]);

export async function loadCaseRepairOverlays(
  repairPath: string | null | undefined
): Promise<Map<string, CaseRepairOverlay>> {
  const overlays = new Map<string, CaseRepairOverlay>();
  if (!repairPath) return overlays;

  const files = await findRepairFiles(repairPath);
  for (const file of files) {
    const parsed = JSON.parse(await readFile(file, "utf8")) as CaseRepairOverlay;
    if (!parsed.case_id) continue;
    overlays.set(parsed.case_id, normalizeRepairOverlay(parsed));
  }
  return overlays;
}

export async function writeCaseRepairOverlay(
  repairFolder: string,
  overlay: CaseRepairOverlay
): Promise<CaseRepairOverlay> {
  await mkdir(repairFolder, { recursive: true });
  const normalized = normalizeRepairOverlay(overlay);
  await writeFile(repairOverlayPath(repairFolder, normalized.case_id), `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  return normalized;
}

export async function upsertCaseRepairEntry(
  repairFolder: string,
  entry: CaseRepairEntry & { case_id: string; source_file_id?: string | null }
): Promise<CaseRepairOverlay> {
  const existing = await readCaseRepairOverlay(repairFolder, entry.case_id);
  const now = new Date().toISOString();
  const { case_id: caseId, source_file_id: sourceFileId, ...repairFields } = entry;
  const repair: CaseRepairEntry = {
    ...repairFields,
    status: entry.status ?? "applied",
    updated_at: now,
    created_at: entry.created_at ?? now
  };
  const key = repairKey(repair);
  const repairs = existing.repairs.filter((item) => repairKey(item) !== key);
  repairs.push(repair);

  return writeCaseRepairOverlay(repairFolder, {
    version: 1,
    case_id: caseId,
    source_file_id: sourceFileId ?? existing.source_file_id ?? null,
    reviewer: entry.reviewer ?? existing.reviewer ?? null,
    updated_at: now,
    repairs
  });
}

export async function readCaseRepairOverlay(repairFolder: string, caseId: string): Promise<CaseRepairOverlay> {
  try {
    return normalizeRepairOverlay(
      JSON.parse(await readFile(repairOverlayPath(repairFolder, caseId), "utf8")) as CaseRepairOverlay
    );
  } catch {
    return {
      version: 1,
      case_id: caseId,
      source_file_id: null,
      reviewer: null,
      updated_at: new Date().toISOString(),
      repairs: []
    };
  }
}

export function applyCaseRepairOverlay(
  normalizedCase: NormalizedAppraisalCase,
  overlay: CaseRepairOverlay | null | undefined
): ApplyRepairResult {
  if (!overlay || overlay.repairs.length === 0) {
    return { normalizedCase, appliedCount: 0, parserNotes: [], warnings: [] };
  }

  const copy = structuredClone(normalizedCase);
  const parserNotes: string[] = [];
  const warnings: string[] = [];
  let appliedCount = 0;

  if (overlay.case_id !== copy.case_id) {
    warnings.push("repair_overlay_case_id_mismatch");
    return { normalizedCase: copy, appliedCount, parserNotes, warnings };
  }

  for (const repair of overlay.repairs) {
    if ((repair.status ?? "applied") !== "applied") continue;
    const applied = applyRepairEntry(copy, repair, parserNotes, warnings);
    if (applied) appliedCount += 1;
  }

  return {
    normalizedCase: copy,
    appliedCount,
    parserNotes: dedupe(parserNotes),
    warnings: dedupe(warnings)
  };
}

export function repairOverlayPath(repairFolder: string, caseId: string): string {
  return path.join(repairFolder, `${caseId}.repair.json`);
}

function applyRepairEntry(
  normalizedCase: NormalizedAppraisalCase,
  repair: CaseRepairEntry,
  parserNotes: string[],
  warnings: string[]
): boolean {
  const target = repair.target.trim();
  if (!target) return false;

  if (target.startsWith("subject.")) {
    const key = target.slice("subject.".length) as keyof NormalizedAppraisalCase["subject"];
    const value = convertSubjectValue(key, repair.value);
    return setValue(normalizedCase.subject as unknown as Record<string, unknown>, key, value, target, parserNotes);
  }

  if (target.startsWith("reconciliation.")) {
    const key = target.slice("reconciliation.".length) as keyof NormalizedAppraisalCase["reconciliation"];
    const value = convertReconciliationValue(key, repair.value);
    return setValue(
      normalizedCase.reconciliation as unknown as Record<string, unknown>,
      key,
      value,
      target,
      parserNotes
    );
  }

  if (target.startsWith("comparables.")) {
    const compIndex = repair.comp_index ?? null;
    if (!compIndex || compIndex < 1) {
      warnings.push(`repair_overlay_missing_comp_index_${target.replace(/\./g, "_")}`);
      return false;
    }
    const comp = normalizedCase.comparables[compIndex - 1];
    if (!comp) {
      warnings.push(`repair_overlay_comp_not_found_${compIndex}`);
      return false;
    }
    const key = target.slice("comparables.".length) as keyof ComparableSale;
    const value = convertComparableValue(key, repair.value);
    return setValue(comp as unknown as Record<string, unknown>, key, value, target, parserNotes, compIndex);
  }

  warnings.push(`repair_overlay_unknown_target_${target.replace(/\./g, "_")}`);
  return false;
}

function setValue(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
  targetName: string,
  parserNotes: string[],
  compIndex?: number
): boolean {
  if (value == null || value === "") return false;
  target[key] = value;
  parserNotes.push(
    compIndex
      ? `repair_overlay_applied_${targetName.replace(/\./g, "_")}_comp_${compIndex}`
      : `repair_overlay_applied_${targetName.replace(/\./g, "_")}`
  );
  return true;
}

function convertSubjectValue(key: keyof NormalizedAppraisalCase["subject"], value: JsonValue | undefined): unknown {
  if (key === "gla_sqft") return normalizeSquareFeet(scalarToString(value));
  if (["bedrooms", "bathrooms", "year_built"].includes(String(key))) return normalizeNumber(scalarToString(value));
  if (key === "condition") return normalizeRating(scalarToString(value), "C");
  if (key === "quality") return normalizeRating(scalarToString(value), "Q");
  return normalizeString(value);
}

function convertReconciliationValue(
  key: keyof NormalizedAppraisalCase["reconciliation"],
  value: JsonValue | undefined
): unknown {
  if (
    [
      "indicated_value_low",
      "indicated_value_high",
      "final_opinion_of_value",
      "sales_comparison_indicated_value",
      "cost_approach_indicated_value",
      "income_approach_indicated_value"
    ].includes(String(key))
  ) {
    return normalizeCurrency(scalarToString(value));
  }
  return normalizeString(value);
}

function convertComparableValue(key: keyof ComparableSale, value: JsonValue | undefined): unknown {
  if (comparableDateFields.has(key)) return normalizeDate(scalarToString(value));
  if (comparableCurrencyFields.has(key)) return normalizeCurrency(scalarToString(value));
  if (comparableNumericFields.has(key)) return normalizeNumber(scalarToString(value));
  if (key === "condition") return normalizeRating(scalarToString(value), "C");
  if (key === "quality") return normalizeRating(scalarToString(value), "Q");
  if (key === "other_features") {
    if (Array.isArray(value)) return value.map((item) => normalizeString(item)).filter(Boolean);
    const text = normalizeString(value);
    return text ? [text] : null;
  }
  return normalizeString(value);
}

function normalizeRating(value: string | null, prefix: "C" | "Q"): string | null {
  const match = value?.match(new RegExp(`\\b${prefix}[1-5]\\b`, "i"));
  return match ? match[0].toUpperCase() : null;
}

function normalizeString(value: JsonValue | undefined): string | null {
  const text = scalarToString(value);
  return text && text.trim().length > 0 ? text.trim() : null;
}

function scalarToString(value: JsonValue | undefined): string | null {
  if (value == null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function normalizeRepairOverlay(overlay: CaseRepairOverlay): CaseRepairOverlay {
  return {
    version: 1,
    case_id: overlay.case_id,
    source_file_id: overlay.source_file_id ?? null,
    reviewer: overlay.reviewer ?? null,
    updated_at: overlay.updated_at ?? new Date().toISOString(),
    repairs: [...(overlay.repairs ?? [])].sort((a, b) => repairKey(a).localeCompare(repairKey(b)))
  };
}

function repairKey(repair: CaseRepairEntry): string {
  return `${repair.target}:${repair.comp_index ?? ""}`;
}

async function findRepairFiles(repairPath: string): Promise<string[]> {
  const resolved = path.resolve(repairPath);
  let info;
  try {
    info = await stat(resolved);
  } catch {
    return [];
  }
  if (info.isFile()) return [resolved];

  const files: string[] = [];
  async function walk(folder: string): Promise<void> {
    const entries = await readdir(folder, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (entry.isFile() && entry.name.endsWith(".repair.json")) {
        files.push(entryPath);
      }
    }
  }

  await walk(resolved);
  return files.sort((a, b) => a.localeCompare(b));
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
