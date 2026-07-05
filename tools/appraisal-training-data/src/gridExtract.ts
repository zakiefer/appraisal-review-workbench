import type { ComparableSale, SubjectProperty } from "./types.js";
import { GRID_ROW_ALIASES, type GridRowAliasKey } from "./fieldAliases.js";
import {
  normalizeCurrency,
  normalizeDate,
  normalizeKey,
  normalizeNumber,
  normalizeSquareFeet,
  textValue,
  type XmlNode
} from "./xmlValueFinder.js";

export interface GridExtractedComparable {
  comp_id?: string;
  sale_price?: string | null;
  sale_date?: string | null;
  gla_sqft?: string | null;
  bedrooms?: string | null;
  bathrooms?: string | null;
  year_built?: string | null;
  condition?: string | null;
  quality?: string | null;
  site_size?: string | null;
  view?: string | null;
  location?: string | null;
  net_adjustment?: string | null;
  gross_adjustment?: string | null;
  adjusted_sale_price?: string | null;
}

export interface GridExtractionResult {
  subject: Partial<Pick<SubjectProperty, "condition" | "quality">>;
  comparables: GridExtractedComparable[];
  parserNotes: string[];
}

export interface GridInventoryRow {
  row_label: string;
  likely_fields: string[];
  row_path: string;
  row_count: number;
  possible_cell_count: number;
}

export interface SafeValueProfileRow {
  field: string;
  row_label: string;
  path: string;
  count: number;
  samples: string[];
}

type GridComparableField = keyof GridExtractedComparable;

const labelKeys = new Set([
  "label",
  "rowlabel",
  "field",
  "lineitem",
  "description",
  "type",
  "_type",
  "_description",
  "propertyfeaturedescription"
]);

const ignoredCellKeys = new Set([
  "#text",
  "text",
  "_text",
  "value",
  "_value",
  "label",
  "rowlabel",
  "field",
  "lineitem",
  "description",
  "type",
  "_type",
  "_description",
  "propertyfeaturedescription"
]);

const subjectColumnKeys = new Set(["subject", "subjectproperty", "subj"]);

const gridFieldToComparableField: Partial<Record<GridRowAliasKey, GridComparableField>> = {
  "comparables.condition": "condition",
  "comparables.quality": "quality",
  "comparables.gla_sqft": "gla_sqft",
  "comparables.sale_date": "sale_date",
  "comparables.adjusted_sale_price": "adjusted_sale_price",
  "comparables.sale_price": "sale_price",
  "comparables.net_adjustment": "net_adjustment",
  "comparables.gross_adjustment": "gross_adjustment",
  "comparables.bedrooms": "bedrooms",
  "comparables.bathrooms": "bathrooms",
  "comparables.year_built": "year_built",
  "comparables.site_size": "site_size",
  "comparables.view": "view",
  "comparables.location": "location"
};

const safeLabelOrder = [
  "gross living area",
  "gla",
  "above grade living area",
  "condition",
  "quality",
  "actual age",
  "year built",
  "site",
  "view",
  "location",
  "sale price",
  "sale date",
  "date of sale",
  "adjusted sale price",
  "net adjustment",
  "gross adjustment",
  "room count",
  "bedrooms",
  "bathrooms"
];

export function extractGridValues(root: XmlNode): GridExtractionResult {
  const result: GridExtractionResult = {
    subject: {},
    comparables: [],
    parserNotes: []
  };

  for (const row of findGridRows(root)) {
    const fields = fieldsForGridLabel(row.normalizedLabel);
    if (fields.length === 0) continue;

    for (const [columnKey, rawValue] of row.cells) {
      if (!rawValue) continue;
      if (subjectColumnKeys.has(normalizeKey(columnKey))) {
        if (fields.includes("subject.condition") && !result.subject.condition) {
          result.subject.condition = rawValue;
          result.parserNotes.push("grid_row_filled_subject_condition");
        }
        if (fields.includes("subject.quality") && !result.subject.quality) {
          result.subject.quality = rawValue;
          result.parserNotes.push("grid_row_filled_subject_quality");
        }
        continue;
      }

      const compIndex = comparableIndexFromColumn(columnKey);
      if (compIndex == null) continue;
      const comparable = ensureComparable(result.comparables, compIndex);

      for (const field of fields) {
        const comparableField = gridFieldToComparableField[field];
        if (!comparableField || comparable[comparableField]) continue;
        comparable[comparableField] = rawValue;
        result.parserNotes.push(`grid_row_filled_${field.replace(".", "_")}`);
      }
    }
  }

  result.parserNotes = [...new Set(result.parserNotes)];
  return result;
}

export function inspectGridInventory(root: XmlNode): GridInventoryRow[] {
  const aggregate = new Map<string, GridInventoryRow>();

  for (const row of findGridRows(root)) {
    const fields = fieldsForGridLabel(row.normalizedLabel);
    if (fields.length === 0) continue;

    const key = `${row.path}:${row.normalizedLabel}`;
    const existing = aggregate.get(key);
    if (existing) {
      existing.row_count += 1;
      existing.possible_cell_count += row.cells.length;
    } else {
      aggregate.set(key, {
        row_label: row.normalizedLabel,
        likely_fields: fields,
        row_path: row.path,
        row_count: 1,
        possible_cell_count: row.cells.length
      });
    }
  }

  return [...aggregate.values()].sort((a, b) => b.row_count - a.row_count || a.row_label.localeCompare(b.row_label));
}

export function collectSafeValueProfiles(root: XmlNode): SafeValueProfileRow[] {
  const aggregate = new Map<string, SafeValueProfileRow>();

  for (const row of findGridRows(root)) {
    const fields = fieldsForGridLabel(row.normalizedLabel);
    if (fields.length === 0) continue;

    for (const [, rawValue] of row.cells) {
      const safeValue = sanitizeSafeProfileValue(rawValue, fields);
      if (!safeValue) continue;

      for (const field of fields) {
        const key = `${field}:${row.path}:${row.normalizedLabel}`;
        const existing =
          aggregate.get(key) ??
          {
            field,
            row_label: row.normalizedLabel,
            path: row.path,
            count: 0,
            samples: []
          };
        existing.count += 1;
        if (!existing.samples.includes(safeValue) && existing.samples.length < 8) {
          existing.samples.push(safeValue);
        }
        aggregate.set(key, existing);
      }
    }
  }

  return [...aggregate.values()].sort((a, b) => b.count - a.count || a.field.localeCompare(b.field));
}

export function normalizeGridLabel(label: string | null | undefined): string | null {
  if (!label) return null;
  const normalized = normalizeLoose(label);
  if (!normalized) return null;

  for (const safeLabel of safeLabelOrder) {
    if (normalized === normalizeLoose(safeLabel)) return safeLabel;
  }

  for (const aliases of Object.values(GRID_ROW_ALIASES)) {
    for (const alias of aliases) {
      if (normalized === normalizeLoose(alias)) {
        return alias;
      }
    }
  }

  return null;
}

export function mergeGridComparable(
  direct: ComparableSale,
  grid: GridExtractedComparable | undefined
): { comparable: ComparableSale; parserNotes: string[]; warnings: string[] } {
  if (!grid) return { comparable: direct, parserNotes: [], warnings: [] };

  const comparable = structuredClone(direct);
  const parserNotes: string[] = [];
  const warnings: string[] = [];

  mergeField(comparable, grid, "condition", parserNotes, warnings);
  mergeField(comparable, grid, "quality", parserNotes, warnings);
  mergeField(comparable, grid, "gla_sqft", parserNotes, warnings);
  mergeField(comparable, grid, "sale_date", parserNotes, warnings);
  mergeField(comparable, grid, "adjusted_sale_price", parserNotes, warnings);
  mergeField(comparable, grid, "sale_price", parserNotes, warnings);
  mergeField(comparable, grid, "net_adjustment", parserNotes, warnings);
  mergeField(comparable, grid, "gross_adjustment", parserNotes, warnings);
  mergeField(comparable, grid, "bedrooms", parserNotes, warnings);
  mergeField(comparable, grid, "bathrooms", parserNotes, warnings);
  mergeField(comparable, grid, "year_built", parserNotes, warnings);
  mergeField(comparable, grid, "site_size", parserNotes, warnings);
  mergeField(comparable, grid, "view", parserNotes, warnings);
  mergeField(comparable, grid, "location", parserNotes, warnings);

  return { comparable, parserNotes, warnings };
}

interface GridRow {
  normalizedLabel: string;
  path: string;
  cells: Array<[string, string]>;
}

function findGridRows(root: XmlNode): GridRow[] {
  const rows: GridRow[] = [];

  function visit(node: XmlNode, pathParts: string[]): void {
    if (!node || typeof node !== "object") return;

    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, [...pathParts, String(index)]));
      return;
    }

    const record = node as Record<string, XmlNode>;
    const explicitLabel = findExplicitLabel(record);
    const pathLabel = normalizeGridLabel(pathParts.at(-1));
    const normalizedLabel = explicitLabel ?? pathLabel;
    if (normalizedLabel) {
      const cells = collectCells(record);
      if (cells.length > 0) {
        rows.push({
          normalizedLabel,
          path: pathParts.join("."),
          cells
        });
      }
    }

    for (const [key, child] of Object.entries(record)) {
      visit(child, [...pathParts, key]);
    }
  }

  visit(root, []);
  return rows;
}

function findExplicitLabel(record: Record<string, XmlNode>): string | null {
  for (const [key, child] of Object.entries(record)) {
    if (labelKeys.has(normalizeKey(key))) {
      const normalized = normalizeGridLabel(textValue(child));
      if (normalized) return normalized;
    }
  }
  return null;
}

function collectCells(record: Record<string, XmlNode>): Array<[string, string]> {
  const cells: Array<[string, string]> = [];

  for (const [key, child] of Object.entries(record)) {
    if (ignoredCellKeys.has(normalizeKey(key))) continue;

    if (Array.isArray(child)) {
      child.forEach((item, index) => {
        const cellKey = cellKeyFromRecord(item, `${key}${index + 1}`);
        const value = textValue(item);
        if (value) cells.push([cellKey, value]);
      });
      continue;
    }

    const value = textValue(child);
    if (value) cells.push([key, value]);
  }

  return cells;
}

function cellKeyFromRecord(value: XmlNode, fallback: string): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  const record = value as Record<string, XmlNode>;
  for (const key of ["@_index", "@_Index", "@_column", "@_Column", "@_SequenceIdentifier", "_SequenceIdentifier"]) {
    const text = textValue(record[key]);
    if (text) return `Comp${text}`;
  }
  return fallback;
}

function fieldsForGridLabel(label: string): GridRowAliasKey[] {
  const normalized = normalizeLoose(label);
  const fields: GridRowAliasKey[] = [];

  for (const [field, aliases] of Object.entries(GRID_ROW_ALIASES) as Array<[GridRowAliasKey, readonly string[]]>) {
    if (aliases.some((alias) => normalizeLoose(alias) === normalized)) {
      fields.push(field);
    }
  }

  return fields;
}

function comparableIndexFromColumn(columnKey: string): number | null {
  const normalized = normalizeKey(columnKey);
  if (subjectColumnKeys.has(normalized)) return null;

  const match = normalized.match(/(?:comp|comparable|sale|column|c)(\d+)/);
  if (match) return Number(match[1]) - 1;

  if (/^\d+$/.test(normalized)) return Number(normalized) - 1;
  return null;
}

function ensureComparable(comparables: GridExtractedComparable[], index: number): GridExtractedComparable {
  while (comparables.length <= index) {
    comparables.push({ comp_id: `comp_${comparables.length + 1}` });
  }
  return comparables[index] as GridExtractedComparable;
}

function mergeField(
  direct: ComparableSale,
  grid: GridExtractedComparable,
  field: GridComparableField,
  parserNotes: string[],
  warnings: string[]
): void {
  const gridValue = grid[field];
  if (gridValue == null || gridValue === "") return;

  if (direct[field] == null || direct[field] === "") {
    (direct as unknown as Record<string, unknown>)[field] = convertGridValue(field, gridValue);
    parserNotes.push(`grid_row_filled_comparables_${String(field)}`);
    return;
  }

  const converted = convertGridValue(field, gridValue);
  if (String(direct[field]) !== String(converted)) {
    warnings.push(`grid_row_conflict_comparables_${String(field)}`);
  }
}

function convertGridValue(field: GridComparableField, value: string): string | number | null {
  if (["sale_price", "adjusted_sale_price", "net_adjustment", "gross_adjustment"].includes(field)) {
    return normalizeCurrency(value);
  }
  if (field === "gla_sqft") return normalizeSquareFeet(value);
  if (["bedrooms", "bathrooms", "year_built"].includes(field)) return normalizeNumber(value);
  if (field === "sale_date") return normalizeDate(value);
  return value;
}

function sanitizeSafeProfileValue(rawValue: string, fields: GridRowAliasKey[]): string | null {
  const value = rawValue.trim();
  if (!value || looksPrivate(value)) return null;

  if (fields.some((field) => field.endsWith(".condition")) && /^C[1-6]$/i.test(value)) return value.toUpperCase();
  if (fields.some((field) => field.endsWith(".quality")) && /^Q[1-6]$/i.test(value)) return value.toUpperCase();
  if (fields.some((field) => field.includes("gla") || field.endsWith(".bedrooms") || field.endsWith(".bathrooms"))) {
    const numeric = value.match(/^\d{1,5}(?:\.\d+)?$/);
    if (numeric) return numeric[0];
  }
  if (fields.some((field) => field.includes("price") || field.includes("adjustment"))) {
    const currency = value.match(/^-?\$?\d{1,3}(?:,\d{3})*(?:\.\d+)?$|^-?\d+(?:\.\d+)?$/);
    if (currency) return currency[0];
  }
  if (fields.some((field) => field.endsWith(".sale_date"))) {
    const date = value.match(/^\d{4}-\d{1,2}-\d{1,2}$|^\d{1,2}\/\d{1,2}\/\d{2,4}$|^\d{8}$/);
    if (date) return date[0];
  }

  return null;
}

function looksPrivate(value: string): boolean {
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(value)) return true;
  if (/(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/.test(value)) return true;
  if (/\b\d{1,6}\s+[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,5}\s+(?:st|street|ave|avenue|rd|road|dr|drive|ln|lane|ct|court|cir|circle|blvd|boulevard|pkwy|parkway|pl|place|ter|terrace|way)\b\.?/i.test(value)) {
    return true;
  }
  if (/\b(?:borrower|client|appraiser|license|parcel|loan)\b/i.test(value)) return true;
  return false;
}

function normalizeLoose(value: string): string {
  return value
    .replace(/[_-]/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
