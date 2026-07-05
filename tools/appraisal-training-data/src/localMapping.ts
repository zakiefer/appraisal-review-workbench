import { readFile } from "node:fs/promises";
import {
  DEFAULT_ADJUSTED_PRICE_CONFLICT_POLICY,
  arithmeticAdjustedSalePrice,
  emptyAdjustedPriceConflictStats,
  mergeAdjustedPriceConflictStats,
  resolveAdjustedPriceConflict
} from "./adjustedPricePolicy.js";
import type {
  AdjustedPriceConflictPolicy,
  AdjustedPriceConflictStats,
  ComparableSale,
  NormalizedAppraisalCase
} from "./types.js";
import {
  normalizeCurrency,
  normalizeDate,
  normalizeKey,
  normalizeNumber,
  normalizeSquareFeet,
  textValue,
  type XmlNode
} from "./xmlValueFinder.js";

export type MappingStrategy = "direct" | "grid_row";
export type MappingConfidence = "candidate" | "manual_verified";

export interface LocalFieldMappingEntry {
  path: string;
  strategy: MappingStrategy;
  confidence?: MappingConfidence | string;
  verified?: boolean;
  score?: number;
  notes?: string;
}

export interface LocalFieldMappingFile {
  version: number;
  instructions?: string;
  mappings?: Record<string, LocalFieldMappingEntry[]>;
}

export interface VerifiedLocalMapping {
  field: string;
  path: string;
  strategy: MappingStrategy;
  confidence: MappingConfidence | string;
  manualVerified: boolean;
}

export interface LocalMappingApplyResult {
  normalizedCase: NormalizedAppraisalCase;
  parserNotes: string[];
  warnings: string[];
  adjustedPriceConflictStats: AdjustedPriceConflictStats;
  appliedMappings: Array<{
    field: string;
    path: string;
    value_count: number;
    filled_count: number;
    conflict_count: number;
  }>;
}

export interface LocalMappingOptions {
  adjustedPriceConflictPolicy?: AdjustedPriceConflictPolicy;
}

export async function loadLocalFieldMappings(mappingPath: string | null | undefined): Promise<VerifiedLocalMapping[]> {
  if (!mappingPath) return [];
  const parsed = JSON.parse(await readFile(mappingPath, "utf8")) as LocalFieldMappingFile;
  const mappings = parsed.mappings ?? {};
  const verified: VerifiedLocalMapping[] = [];

  for (const [field, entries] of Object.entries(mappings)) {
    for (const entry of entries ?? []) {
      const manualVerified = entry.confidence === "manual_verified";
      if (!entry.verified && !manualVerified) continue;
      if (!entry.path || !entry.strategy) continue;
      verified.push({
        field,
        path: entry.path,
        strategy: entry.strategy,
        confidence: entry.confidence ?? "candidate",
        manualVerified
      });
    }
  }

  return verified;
}

export function applyLocalMappings(
  normalizedCase: NormalizedAppraisalCase,
  root: XmlNode,
  mappings: VerifiedLocalMapping[],
  options: LocalMappingOptions = {}
): LocalMappingApplyResult {
  const copy = structuredClone(normalizedCase);
  const parserNotes: string[] = [];
  const warnings: string[] = [];
  const appliedMappings: LocalMappingApplyResult["appliedMappings"] = [];
  const adjustedPriceConflictPolicy =
    options.adjustedPriceConflictPolicy ?? DEFAULT_ADJUSTED_PRICE_CONFLICT_POLICY;
  let adjustedPriceConflictStats = emptyAdjustedPriceConflictStats(adjustedPriceConflictPolicy);

  for (const mapping of mappings) {
    const values = collectValuesAtPath(root, mapping.path);
    let filledCount = 0;
    let conflictCount = 0;

    if (values.length > 0) {
      const result = applyMappingValues(copy, mapping, values, { adjustedPriceConflictPolicy });
      filledCount = result.filledCount;
      conflictCount = result.conflictCount;
      parserNotes.push(...result.parserNotes);
      warnings.push(...result.warnings);
      adjustedPriceConflictStats = mergeAdjustedPriceConflictStats(
        [adjustedPriceConflictStats, result.adjustedPriceConflictStats],
        adjustedPriceConflictPolicy
      );
      if (filledCount > 0) {
        parserNotes.push(`local_mapping_filled_${mapping.field.replace(/\./g, "_")}`);
      }
      if (conflictCount > 0) {
        warnings.push(`local_mapping_conflict_${mapping.field.replace(/\./g, "_")}`);
      }
    }

    appliedMappings.push({
      field: mapping.field,
      path: mapping.path,
      value_count: values.length,
      filled_count: filledCount,
      conflict_count: conflictCount
    });
  }

  copy.quality_flags.parser_notes = dedupe([...copy.quality_flags.parser_notes, ...parserNotes]);
  copy.quality_flags.warnings = dedupe([...copy.quality_flags.warnings, ...warnings]);
  copy.quality_flags.adjusted_price_conflict_stats = adjustedPriceConflictStats;

  return {
    normalizedCase: copy,
    parserNotes: dedupe(parserNotes),
    warnings: dedupe(warnings),
    adjustedPriceConflictStats,
    appliedMappings
  };
}

export function collectValuesAtPath(root: XmlNode, pathExpression: string): string[] {
  const pathParts = pathExpression.split(".").filter(Boolean);
  if (pathParts.length === 0) return [];

  const values: string[] = [];

  function walk(node: XmlNode, index: number): void {
    if (node == null) return;

    if (Array.isArray(node)) {
      for (const item of node) walk(item, index);
      return;
    }

    if (index >= pathParts.length) {
      const text = textValue(node);
      if (text) values.push(text);
      return;
    }

    if (typeof node !== "object") return;

    const record = node as Record<string, XmlNode>;
    const expected = normalizeKey(pathParts[index] ?? "");
    for (const [key, child] of Object.entries(record)) {
      if (normalizeKey(key) === expected) {
        walk(child, index + 1);
      }
    }
  }

  walk(root, 0);
  return values;
}

function applyMappingValues(
  normalizedCase: NormalizedAppraisalCase,
  mapping: VerifiedLocalMapping,
  values: string[],
  options: Required<LocalMappingOptions>
): {
  filledCount: number;
  conflictCount: number;
  parserNotes: string[];
  warnings: string[];
  adjustedPriceConflictStats: AdjustedPriceConflictStats;
} {
  let filledCount = 0;
  let conflictCount = 0;
  const parserNotes: string[] = [];
  const warnings: string[] = [];
  let adjustedPriceConflictStats = emptyAdjustedPriceConflictStats(options.adjustedPriceConflictPolicy);
  const override = mapping.manualVerified;

  if (mapping.field === "subject.condition") {
    const result = setScalar(normalizedCase.subject as unknown as Record<string, unknown>, "condition", normalizeString(values[0]), override);
    return toResult(result, mapping.field, options.adjustedPriceConflictPolicy);
  }
  if (mapping.field === "subject.quality") {
    const result = setScalar(normalizedCase.subject as unknown as Record<string, unknown>, "quality", normalizeString(values[0]), override);
    return toResult(result, mapping.field, options.adjustedPriceConflictPolicy);
  }

  if (mapping.field.startsWith("comparables.")) {
    const comparableField = mapping.field.split(".")[1] as keyof ComparableSale | undefined;
    if (!comparableField) {
      return {
        filledCount,
        conflictCount,
        parserNotes,
        warnings,
        adjustedPriceConflictStats
      };
    }
    ensureComparableCount(normalizedCase, values.length);
    if (comparableField === "adjusted_sale_price") {
      const arithmeticValuesByIndex = normalizedCase.comparables.map((comp) => arithmeticAdjustedSalePrice(comp).value);
      values.forEach((value, index) => {
        const comp = normalizedCase.comparables[index];
        if (!comp) return;
        const localValue = normalizeCurrency(value);
        const result = resolveAdjustedPriceConflict({
          policy: options.adjustedPriceConflictPolicy,
          comparable: comp,
          localValue,
          compIndex: index,
          arithmeticValuesByIndex
        });
        comp.adjusted_sale_price = result.value;
        if (result.filledMissing) filledCount += 1;
        if (result.conflict) conflictCount += 1;
        parserNotes.push(...result.parserNotes);
        warnings.push(...result.warnings);
        adjustedPriceConflictStats = mergeAdjustedPriceConflictStats(
          [adjustedPriceConflictStats, result.stats],
          options.adjustedPriceConflictPolicy
        );
      });
      return {
        filledCount,
        conflictCount,
        parserNotes,
        warnings: dedupe(warnings),
        adjustedPriceConflictStats
      };
    }
    values.forEach((value, index) => {
      const comp = normalizedCase.comparables[index];
      if (!comp) return;
      const converted = convertComparableValue(comparableField, value);
      const result = setScalar(comp as unknown as Record<string, unknown>, comparableField, converted, override);
      if (result.filled) filledCount += 1;
      if (result.conflict) conflictCount += 1;
    });
  }

  if (conflictCount > 0) warnings.push(`local_mapping_conflict_${mapping.field.replace(/\./g, "_")}`);
  return {
    filledCount,
    conflictCount,
    parserNotes,
    warnings,
    adjustedPriceConflictStats
  };
}

function toResult(
  result: { filled: boolean; conflict: boolean },
  field: string,
  adjustedPriceConflictPolicy: AdjustedPriceConflictPolicy
): {
  filledCount: number;
  conflictCount: number;
  parserNotes: string[];
  warnings: string[];
  adjustedPriceConflictStats: AdjustedPriceConflictStats;
} {
  return {
    filledCount: result.filled ? 1 : 0,
    conflictCount: result.conflict ? 1 : 0,
    parserNotes: [],
    warnings: result.conflict ? [`local_mapping_conflict_${field.replace(/\./g, "_")}`] : [],
    adjustedPriceConflictStats: emptyAdjustedPriceConflictStats(adjustedPriceConflictPolicy)
  };
}

function setScalar(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
  override: boolean
): { filled: boolean; conflict: boolean } {
  if (value == null || value === "") return { filled: false, conflict: false };
  const existing = target[key];
  if (existing == null || existing === "") {
    target[key] = value;
    return { filled: true, conflict: false };
  }
  if (String(existing) !== String(value)) {
    if (override) {
      target[key] = value;
      return { filled: true, conflict: true };
    }
    return { filled: false, conflict: true };
  }
  return { filled: false, conflict: false };
}

function convertComparableValue(field: keyof ComparableSale, value: string): unknown {
  if (["gla_sqft", "basement_area_sqft", "basement_finished_sqft"].includes(String(field))) {
    return normalizeSquareFeet(value);
  }
  if (["sale_price", "adjusted_sale_price", "net_adjustment", "gross_adjustment"].includes(String(field))) {
    return normalizeCurrency(value);
  }
  if (
    [
      "bedrooms",
      "bathrooms",
      "full_bathrooms",
      "half_bathrooms",
      "total_rooms",
      "year_built",
      "actual_age",
      "distance_miles",
      "sales_price_per_gla",
      "garage_spaces",
      "carport_spaces",
      "net_adjustment_percent",
      "gross_adjustment_percent"
    ].includes(String(field))
  ) {
    return normalizeNumber(value);
  }
  if (field === "sale_date" || field === "contract_date") return normalizeDate(value);
  return normalizeString(value);
}

function normalizeString(value: string | undefined): string | null {
  const cleaned = value?.trim();
  return cleaned ? cleaned : null;
}

function ensureComparableCount(normalizedCase: NormalizedAppraisalCase, count: number): void {
  while (normalizedCase.comparables.length < count) {
    normalizedCase.comparables.push(emptyComparable(normalizedCase.comparables.length + 1));
  }
}

function emptyComparable(index: number): ComparableSale {
  return {
    comp_id: `comp_${index}`,
    address_redacted: null,
    city: null,
    state: null,
    postal_code_redacted: null,
    distance_miles: null,
    sale_price: null,
    sales_price_per_gla: null,
    sale_date: null,
    sale_date_raw: null,
    contract_date: null,
    data_source: null,
    verification_source: null,
    property_rights: null,
    sales_concessions: null,
    financing_concessions: null,
    gla_sqft: null,
    total_rooms: null,
    bedrooms: null,
    bathrooms: null,
    full_bathrooms: null,
    half_bathrooms: null,
    year_built: null,
    actual_age: null,
    condition: null,
    quality: null,
    site_size: null,
    view: null,
    location: null,
    design_style: null,
    basement_area_sqft: null,
    basement_finished_sqft: null,
    basement_description: null,
    basement_finish: null,
    functional_utility: null,
    heating_cooling: null,
    energy_efficient: null,
    garage_carport: null,
    garage_spaces: null,
    carport_spaces: null,
    porch_deck: null,
    fireplaces: null,
    other_features: null,
    adjustments: [],
    net_adjustment: null,
    net_adjustment_percent: null,
    gross_adjustment: null,
    gross_adjustment_percent: null,
    adjusted_sale_price: null,
    appraiser_comment: null
  };
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
