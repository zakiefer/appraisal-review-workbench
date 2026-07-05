import type { ComparableSale, NormalizedAppraisalCase } from "./types.js";
import { FIELD_ALIASES, type FieldAliasKey } from "./fieldAliases.js";

export interface FieldCoverageRow {
  field: string;
  populated: number;
  missing: number;
  total: number;
  coverage_pct: number;
  previous_populated?: number;
  previous_missing?: number;
  previous_coverage_pct?: number;
  coverage_delta_pct?: number;
  denominator: "cases" | "comparables";
  missing_warning_code: string | null;
  configured_aliases: string[];
}

interface CoverageDefinition {
  field: string;
  denominator: "cases" | "comparables";
  getCaseValue?: (normalizedCase: NormalizedAppraisalCase) => unknown;
  getComparableValue?: (comp: ComparableSale) => unknown;
  missingWarningCode: string | null;
}

const COVERAGE_FIELDS: CoverageDefinition[] = [
  caseField("metadata.effective_date", (item) => item.metadata.effective_date, null),
  caseField("metadata.report_type", (item) => item.metadata.report_type, null),
  caseField("subject.property_type", (item) => item.subject.property_type, null),
  caseField("subject.city", (item) => item.subject.city, null),
  caseField("subject.state", (item) => item.subject.state, null),
  caseField("subject.county", (item) => item.subject.county, null),
  caseField("subject.gla_sqft", (item) => item.subject.gla_sqft, "missing_subject_gla"),
  caseField("subject.bedrooms", (item) => item.subject.bedrooms, null),
  caseField("subject.bathrooms", (item) => item.subject.bathrooms, null),
  caseField("subject.year_built", (item) => item.subject.year_built, null),
  caseField("subject.condition", (item) => item.subject.condition, "missing_subject_condition"),
  caseField("subject.quality", (item) => item.subject.quality, null),
  caseField("subject.site_size", (item) => item.subject.site_size, null),
  caseField("market.market_conditions", (item) => item.market.market_conditions, null),
  caseField("comparables.count", (item) => item.comparables.length > 0 ? item.comparables.length : null, "missing_comparables"),
  comparableField("comparables.sale_price", (comp) => comp.sale_price, "missing_comparable_sale_price"),
  comparableField("comparables.sales_price_per_gla", (comp) => comp.sales_price_per_gla, null),
  comparableField("comparables.sale_date", (comp) => comp.sale_date, null),
  comparableField("comparables.contract_date", (comp) => comp.contract_date, null),
  comparableField("comparables.property_rights", (comp) => comp.property_rights, null),
  comparableField("comparables.financing_concessions", (comp) => comp.financing_concessions, null),
  comparableField("comparables.sales_concessions", (comp) => comp.sales_concessions, null),
  comparableField("comparables.gla_sqft", (comp) => comp.gla_sqft, null),
  comparableField("comparables.total_rooms", (comp) => comp.total_rooms, null),
  comparableField("comparables.bedrooms", (comp) => comp.bedrooms, null),
  comparableField("comparables.bathrooms", (comp) => comp.bathrooms, null),
  comparableField("comparables.full_bathrooms", (comp) => comp.full_bathrooms, null),
  comparableField("comparables.half_bathrooms", (comp) => comp.half_bathrooms, null),
  comparableField("comparables.site_size", (comp) => comp.site_size, null),
  comparableField("comparables.view", (comp) => comp.view, null),
  comparableField("comparables.location", (comp) => comp.location, null),
  comparableField("comparables.actual_age", (comp) => comp.actual_age, null),
  comparableField("comparables.condition", (comp) => comp.condition, null),
  comparableField("comparables.quality", (comp) => comp.quality, null),
  comparableField("comparables.design_style", (comp) => comp.design_style, null),
  comparableField("comparables.basement_area_sqft", (comp) => comp.basement_area_sqft, null),
  comparableField("comparables.basement_finished_sqft", (comp) => comp.basement_finished_sqft, null),
  comparableField("comparables.garage_carport", (comp) => comp.garage_carport, null),
  comparableField("comparables.garage_spaces", (comp) => comp.garage_spaces, null),
  comparableField("comparables.porch_deck", (comp) => comp.porch_deck, null),
  comparableField("comparables.fireplaces", (comp) => comp.fireplaces, null),
  comparableField("comparables.adjustments", (comp) => comp.adjustments.length > 0 ? comp.adjustments.length : null, null),
  comparableField("comparables.net_adjustment", (comp) => comp.net_adjustment, null),
  comparableField("comparables.net_adjustment_percent", (comp) => comp.net_adjustment_percent, null),
  comparableField("comparables.gross_adjustment_percent", (comp) => comp.gross_adjustment_percent, null),
  comparableField("comparables.adjusted_sale_price", (comp) => comp.adjusted_sale_price, "missing_adjusted_sale_price"),
  caseField(
    "reconciliation.final_opinion_of_value",
    (item) => item.reconciliation.final_opinion_of_value,
    "missing_final_opinion_of_value"
  ),
  caseField("reconciliation.narrative", (item) => item.reconciliation.narrative, "reconciliation_narrative_missing")
];

export function buildFieldCoverage(cases: NormalizedAppraisalCase[], previousRows: FieldCoverageRow[] = []): FieldCoverageRow[] {
  const previousByField = new Map(previousRows.map((row) => [row.field, row]));
  return COVERAGE_FIELDS.map((definition) => buildCoverageRow(definition, cases, previousByField.get(definition.field)));
}

export function buildFieldCoverageMarkdown(rows: FieldCoverageRow[]): string {
  const sortedRows = [...rows].sort((a, b) => a.coverage_pct - b.coverage_pct || a.field.localeCompare(b.field));
  const priorityRows = rows
    .filter((row) => priorityFields.has(row.field) && row.missing > 0)
    .sort((a, b) => a.coverage_pct - b.coverage_pct || b.missing - a.missing);
  return `# Field Coverage

Coverage is calculated across normalized cases for case-level fields and across all selected comparables for comparable-level fields.

| Field | Populated | Missing | Coverage | Previous Coverage | Delta | Denominator | Missing Warning |
|---|---:|---:|---:|---:|---:|---|---|
${sortedRows
  .map(
    (row) =>
      `| ${row.field} | ${row.populated} | ${row.missing} | ${row.coverage_pct.toFixed(1)}% | ${
        row.previous_coverage_pct == null ? "" : `${row.previous_coverage_pct.toFixed(1)}%`
      } | ${row.coverage_delta_pct == null ? "" : `${row.coverage_delta_pct >= 0 ? "+" : ""}${row.coverage_delta_pct.toFixed(1)}%`} | ${
        row.denominator
      } | ${
        row.missing_warning_code ?? ""
      } |`
  )
  .join("\n")}

## Highest-priority missing mappings

${
  priorityRows.length > 0
    ? priorityRows
        .map(
          (row) =>
            `- ${row.field}: ${row.missing} missing (${row.coverage_pct.toFixed(1)}% coverage)${
              row.missing_warning_code ? `, warning ${row.missing_warning_code}` : ""
            }`
        )
        .join("\n")
    : "- None of the tracked high-priority fields are missing."
}

Fields with low coverage are the best candidates for new XML aliases in \`tools/appraisal-training-data/src/fieldAliases.ts\`.
`;
}

function buildCoverageRow(
  definition: CoverageDefinition,
  cases: NormalizedAppraisalCase[],
  previousRow: FieldCoverageRow | undefined
): FieldCoverageRow {
  const values =
    definition.denominator === "cases"
      ? cases.map((normalizedCase) => definition.getCaseValue?.(normalizedCase))
      : cases.flatMap((normalizedCase) =>
          normalizedCase.comparables.map((comp) => definition.getComparableValue?.(comp))
        );

  const total = values.length;
  const populated = values.filter(hasValue).length;
  const missing = total - populated;
  const aliases = definition.field in FIELD_ALIASES ? [...FIELD_ALIASES[definition.field as FieldAliasKey]] : [];

  const row: FieldCoverageRow = {
    field: definition.field,
    populated,
    missing,
    total,
    coverage_pct: total === 0 ? 0 : (populated / total) * 100,
    denominator: definition.denominator,
    missing_warning_code: definition.missingWarningCode,
    configured_aliases: aliases
  };

  if (previousRow) {
    row.previous_populated = previousRow.populated;
    row.previous_missing = previousRow.missing;
    row.previous_coverage_pct = previousRow.coverage_pct;
    row.coverage_delta_pct = row.coverage_pct - previousRow.coverage_pct;
  }

  return row;
}

function caseField(
  field: string,
  getCaseValue: (normalizedCase: NormalizedAppraisalCase) => unknown,
  missingWarningCode: string | null
): CoverageDefinition {
  return {
    field,
    denominator: "cases",
    getCaseValue,
    missingWarningCode
  };
}

function comparableField(
  field: string,
  getComparableValue: (comp: ComparableSale) => unknown,
  missingWarningCode: string | null
): CoverageDefinition {
  return {
    field,
    denominator: "comparables",
    getComparableValue,
    missingWarningCode
  };
}

function hasValue(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

const priorityFields = new Set([
  "subject.condition",
  "subject.quality",
  "comparables.condition",
  "comparables.quality",
  "comparables.gla_sqft",
  "comparables.total_rooms",
  "comparables.bedrooms",
  "comparables.bathrooms",
  "comparables.site_size",
  "comparables.view",
  "comparables.location",
  "comparables.actual_age",
  "comparables.garage_carport",
  "comparables.sale_date",
  "comparables.adjusted_sale_price",
  "reconciliation.final_opinion_of_value",
  "reconciliation.narrative"
]);
