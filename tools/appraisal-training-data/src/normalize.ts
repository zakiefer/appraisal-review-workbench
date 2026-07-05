import path from "node:path";
import {
  DEFAULT_ADJUSTED_PRICE_CONFLICT_POLICY,
  emptyAdjustedPriceConflictStats
} from "./adjustedPricePolicy.js";
import type {
  AdjustedPriceConflictPolicy,
  AppraisalMetadata,
  AppraiserComments,
  ComparableAdjustment,
  ComparableSale,
  MarketInfo,
  NormalizedAppraisalCase,
  QualityFlags,
  Reconciliation,
  SubjectProperty
} from "./types.js";
import { PARSER_VERSION } from "./types.js";
import type { ParsedXmlDocument } from "./parseXml.js";
import { safeBasename, sha256, stableCaseId } from "./fileUtils.js";
import { aliasesFor, aliasPathParts, aliasTerminalNames, SECTION_ALIASES, type FieldAliasKey } from "./fieldAliases.js";
import {
  extractGridValues,
  mergeGridComparable,
  type GridExtractedComparable,
  type GridExtractionResult
} from "./gridExtract.js";
import { applyLocalMappings, type VerifiedLocalMapping } from "./localMapping.js";
import { emptyTierReasons, emptyTierStatus } from "./tierQuality.js";
import {
  findFirstByAliases,
  findFirstByPaths,
  findFirstNodeByAliases,
  findNodesByAliases,
  normalizeCurrency,
  normalizeDate,
  normalizeNumber,
  normalizeSquareFeet,
  textValue,
  type XmlNode
} from "./xmlValueFinder.js";

export interface NormalizeOptions {
  localFieldMappings?: VerifiedLocalMapping[];
  adjustedPriceConflictPolicy?: AdjustedPriceConflictPolicy;
}

export function normalizeParsedXml(
  parsed: ParsedXmlDocument,
  sourcePath: string,
  parsedAt = new Date(),
  options: NormalizeOptions = {}
): NormalizedAppraisalCase {
  const parserNotes = [...parsed.parserNotes];
  const root = parsed.root;
  const adjustedPriceConflictPolicy =
    options.adjustedPriceConflictPolicy ?? DEFAULT_ADJUSTED_PRICE_CONFLICT_POLICY;
  let adjustedPriceConflictStats = emptyAdjustedPriceConflictStats(adjustedPriceConflictPolicy);
  const subjectNode = findFirstNodeByAliases(root, [...SECTION_ALIASES.subject]);
  const marketNode = findFirstNodeByAliases(root, [...SECTION_ALIASES.market]);
  const reconciliationNode = findFirstNodeByAliases(root, [...SECTION_ALIASES.reconciliation]);
  const commentsNode = findFirstNodeByAliases(root, [...SECTION_ALIASES.comments]);

  if (!subjectNode) parserNotes.push("subject_path_not_found");
  if (!reconciliationNode) parserNotes.push("reconciliation_path_not_found");

  const gridExtraction = extractGridValues(root);
  parserNotes.push(...gridExtraction.parserNotes);

  const metadata = buildMetadata(root);
  const subject = mergeGridSubject(buildSubject(subjectNode ?? root), gridExtraction, parserNotes);
  const market = buildMarket(marketNode ?? root);
  const { comparables, parserNotes: comparableParserNotes, warnings: gridWarnings } = mergeGridComparables(
    buildComparables(root),
    gridExtraction
  );
  parserNotes.push(...comparableParserNotes);
  const reconciliation = buildReconciliation(reconciliationNode ?? root, root);
  const appraiserComments = buildComments(commentsNode ?? root);
  const warningSeed = [...gridWarnings];
  let normalizedCase: NormalizedAppraisalCase = {
    case_id: stableCaseId(sourcePath),
    source: {
      filename: safeBasename(sourcePath),
      source_path_hash: sha256(path.resolve(sourcePath)),
      source_format: "xml",
      detected_xml_type: parsed.detectedXmlType,
      parsed_at: parsedAt.toISOString(),
      parser_version: PARSER_VERSION
    },
    metadata,
    subject,
    market,
    comparables,
    reconciliation,
    appraiser_comments: appraiserComments,
    quality_flags: {
      status: "needs_review",
      tier_status: emptyTierStatus("needs_review"),
      tier_reasons: emptyTierReasons(),
      adjusted_price_conflict_stats: adjustedPriceConflictStats,
      warnings: [],
      missing_fields: [],
      redaction_notes: [],
      parser_notes: []
    }
  };

  if (options.localFieldMappings && options.localFieldMappings.length > 0) {
    const localMappingResult = applyLocalMappings(normalizedCase, root, options.localFieldMappings, {
      adjustedPriceConflictPolicy
    });
    normalizedCase = localMappingResult.normalizedCase;
    adjustedPriceConflictStats = localMappingResult.adjustedPriceConflictStats;
    parserNotes.push(...localMappingResult.parserNotes);
    warningSeed.push(...localMappingResult.warnings);
  }

  const missingFields = inferMissingFields(normalizedCase.subject, normalizedCase.comparables, normalizedCase.reconciliation);
  const warnings = [...missingFields, ...warningSeed];
  parserNotes.push(...buildMissingFieldParserNotes(missingFields, normalizedCase.comparables));

  if (parsed.detectedXmlType === "unknown_xml") warnings.push("unknown_xml_format");
  if (normalizedCase.comparables.length > 0) warnings.push("selected_comps_only_candidate_pool_unavailable");
  if (subjectNode == null || reconciliationNode == null) warnings.push("parse_path_low_confidence");

  const qualityFlags: QualityFlags = {
    status: "needs_review",
    tier_status: emptyTierStatus("needs_review"),
    tier_reasons: emptyTierReasons(),
    adjusted_price_conflict_stats: adjustedPriceConflictStats,
    warnings: dedupe(warnings),
    missing_fields: dedupe(missingFields),
    redaction_notes: [],
    parser_notes: dedupe(parserNotes)
  };

  normalizedCase.quality_flags = qualityFlags;
  return normalizedCase;
}

function buildMetadata(root: XmlNode): AppraisalMetadata {
  return {
    report_type: field(root, "metadata.report_type"),
    form_type: field(root, "metadata.form_type"),
    loan_purpose: field(root, "metadata.loan_purpose"),
    appraisal_purpose: field(root, "metadata.appraisal_purpose"),
    effective_date: normalizeDate(field(root, "metadata.effective_date")),
    inspection_date: normalizeDate(field(root, "metadata.inspection_date")),
    report_date: normalizeDate(field(root, "metadata.report_date"))
  };
}

function buildSubject(node: XmlNode): SubjectProperty {
  return {
    property_type: field(node, "subject.property_type"),
    address_redacted: field(node, "subject.address_redacted"),
    city: field(node, "subject.city"),
    state: field(node, "subject.state"),
    postal_code_redacted: field(node, "subject.postal_code_redacted"),
    county: field(node, "subject.county"),
    neighborhood: field(node, "subject.neighborhood"),
    site_size: field(node, "subject.site_size"),
    gla_sqft: normalizeSquareFeet(field(node, "subject.gla_sqft")),
    bedrooms: normalizeNumber(field(node, "subject.bedrooms")),
    bathrooms: normalizeNumber(field(node, "subject.bathrooms")),
    year_built: normalizeNumber(field(node, "subject.year_built")),
    condition: field(node, "subject.condition"),
    quality: field(node, "subject.quality"),
    view: field(node, "subject.view"),
    design_style: field(node, "subject.design_style"),
    basement: field(node, "subject.basement"),
    garage_carport: field(node, "subject.garage_carport")
  };
}

function buildMarket(node: XmlNode): MarketInfo {
  return {
    market_conditions: field(node, "market.market_conditions"),
    marketing_time: field(node, "market.marketing_time"),
    neighborhood_price_trend: field(node, "market.neighborhood_price_trend"),
    supply_demand: field(node, "market.supply_demand"),
    location_description: field(node, "market.location_description")
  };
}

function buildComparables(root: XmlNode): ComparableSale[] {
  return findNodesByAliases(root, [...SECTION_ALIASES.comparable])
    .filter((node) => node && typeof node === "object")
    .map((node, index) => buildComparable(node, index + 1))
    .filter((comp) => hasComparableSignal(comp));
}

function buildComparable(node: XmlNode, index: number): ComparableSale {
  return {
    comp_id: field(node, "comparables.comp_id") ?? `comp_${index}`,
    address_redacted: field(node, "comparables.address_redacted"),
    city: field(node, "comparables.city"),
    state: field(node, "comparables.state"),
    postal_code_redacted: field(node, "comparables.postal_code_redacted"),
    distance_miles: normalizeNumber(field(node, "comparables.distance_miles")),
    sale_price: normalizeCurrency(field(node, "comparables.sale_price")),
    sale_date: normalizeDate(field(node, "comparables.sale_date")),
    data_source: field(node, "comparables.data_source"),
    verification_source: field(node, "comparables.verification_source"),
    gla_sqft: normalizeSquareFeet(field(node, "comparables.gla_sqft")),
    bedrooms: normalizeNumber(field(node, "comparables.bedrooms")),
    bathrooms: normalizeNumber(field(node, "comparables.bathrooms")),
    year_built: normalizeNumber(field(node, "comparables.year_built")),
    condition: field(node, "comparables.condition"),
    quality: field(node, "comparables.quality"),
    site_size: field(node, "comparables.site_size"),
    view: field(node, "comparables.view"),
    location: field(node, "comparables.location"),
    adjustments: buildAdjustments(node),
    net_adjustment: normalizeCurrency(field(node, "comparables.net_adjustment")),
    gross_adjustment: normalizeCurrency(field(node, "comparables.gross_adjustment")),
    adjusted_sale_price: normalizeCurrency(field(node, "comparables.adjusted_sale_price")),
    appraiser_comment: field(node, "comparables.appraiser_comment")
  };
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
    sale_date: null,
    data_source: null,
    verification_source: null,
    gla_sqft: null,
    bedrooms: null,
    bathrooms: null,
    year_built: null,
    condition: null,
    quality: null,
    site_size: null,
    view: null,
    location: null,
    adjustments: [],
    net_adjustment: null,
    gross_adjustment: null,
    adjusted_sale_price: null,
    appraiser_comment: null
  };
}

function mergeGridSubject(
  subject: SubjectProperty,
  gridExtraction: GridExtractionResult,
  parserNotes: string[]
): SubjectProperty {
  const merged = { ...subject };
  if (!merged.condition && gridExtraction.subject.condition) {
    merged.condition = gridExtraction.subject.condition;
    parserNotes.push("grid_row_filled_subject_condition");
  }
  if (!merged.quality && gridExtraction.subject.quality) {
    merged.quality = gridExtraction.subject.quality;
    parserNotes.push("grid_row_filled_subject_quality");
  }
  return merged;
}

function mergeGridComparables(
  directComparables: ComparableSale[],
  gridExtraction: GridExtractionResult
): { comparables: ComparableSale[]; parserNotes: string[]; warnings: string[] } {
  const gridComparables = gridExtraction.comparables.filter(hasGridComparableSignal);
  const maxCount = Math.max(directComparables.length, gridComparables.length);
  const comparables: ComparableSale[] = [];
  const parserNotes: string[] = [];
  const warnings: string[] = [];

  for (let index = 0; index < maxCount; index += 1) {
    const direct = directComparables[index] ?? emptyComparable(index + 1);
    const merged = mergeGridComparable(direct, gridComparables[index]);
    comparables.push(merged.comparable);
    parserNotes.push(...merged.parserNotes);
    warnings.push(...merged.warnings);
  }

  return {
    comparables: comparables.filter(hasComparableSignal),
    parserNotes: dedupe(parserNotes),
    warnings: dedupe(warnings)
  };
}

function hasGridComparableSignal(comp: GridExtractedComparable): boolean {
  return Boolean(
    comp.sale_price ??
      comp.adjusted_sale_price ??
      comp.sale_date ??
      comp.gla_sqft ??
      comp.condition ??
      comp.quality ??
      comp.net_adjustment ??
      comp.gross_adjustment
  );
}

function buildAdjustments(node: XmlNode): ComparableAdjustment[] {
  const adjustmentNodes = findNodesByAliases(node, aliasesFor("adjustments.node"));

  return adjustmentNodes
    .map((adjustmentNode) => {
      const rawValue = textValue(adjustmentNode);
      const fieldName = field(adjustmentNode, "adjustments.field") ?? "unknown";
      return {
        field: fieldName,
        amount: normalizeCurrency(field(adjustmentNode, "adjustments.amount")),
        description: field(adjustmentNode, "adjustments.description"),
        raw_value: rawValue
      };
    })
    .filter((adjustment) => {
      return adjustment.field !== "unknown" || adjustment.amount !== null || adjustment.description !== null;
    });
}

function buildReconciliation(node: XmlNode, root: XmlNode): Reconciliation {
  return {
    indicated_value_low: normalizeCurrency(fieldWithRootFallback(node, root, "reconciliation.indicated_value_low")),
    indicated_value_high: normalizeCurrency(fieldWithRootFallback(node, root, "reconciliation.indicated_value_high")),
    final_opinion_of_value: normalizeCurrency(fieldWithRootFallback(node, root, "reconciliation.final_opinion_of_value")),
    sales_comparison_indicated_value: normalizeCurrency(
      fieldWithRootFallback(node, root, "reconciliation.sales_comparison_indicated_value")
    ),
    cost_approach_indicated_value: normalizeCurrency(
      fieldWithRootFallback(node, root, "reconciliation.cost_approach_indicated_value")
    ),
    income_approach_indicated_value: normalizeCurrency(
      fieldWithRootFallback(node, root, "reconciliation.income_approach_indicated_value")
    ),
    narrative: fieldWithRootFallback(node, root, "reconciliation.narrative"),
    confidence: fieldWithRootFallback(node, root, "reconciliation.confidence")
  };
}

function buildComments(node: XmlNode): AppraiserComments {
  return {
    subject_comments: field(node, "appraiser_comments.subject_comments"),
    comp_comments: field(node, "appraiser_comments.comp_comments"),
    market_comments: field(node, "appraiser_comments.market_comments"),
    reconciliation_comments: field(node, "appraiser_comments.reconciliation_comments"),
    extra_comments: field(node, "appraiser_comments.extra_comments")
  };
}

function field(node: XmlNode, fieldKey: FieldAliasKey): string | null {
  const byPath = findFirstByPaths(node, aliasPathParts(fieldKey));
  if (byPath) return cleanText(byPath);
  return cleanText(findFirstByAliases(node, aliasTerminalNames(fieldKey)));
}

function fieldWithRootFallback(node: XmlNode, root: XmlNode, fieldKey: FieldAliasKey): string | null {
  return field(node, fieldKey) ?? field(root, fieldKey);
}

function cleanText(value: string | null): string | null {
  if (!value) return null;
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned.length > 0 ? cleaned : null;
}

function hasComparableSignal(comp: ComparableSale): boolean {
  return Boolean(
    comp.sale_price ??
      comp.adjusted_sale_price ??
      comp.address_redacted ??
      comp.sale_date ??
      comp.gla_sqft ??
      (comp.adjustments.length > 0 ? 1 : null)
  );
}

function inferMissingFields(
  subject: SubjectProperty,
  comparables: ComparableSale[],
  reconciliation: Reconciliation
): string[] {
  const warnings: string[] = [];

  if (subject.gla_sqft == null) warnings.push("missing_subject_gla");
  if (subject.condition == null) warnings.push("missing_subject_condition");
  if (subject.quality == null) warnings.push("missing_subject_quality");
  if (comparables.length === 0) warnings.push("missing_comparables");
  if (comparables.some((comp) => comp.sale_price == null)) warnings.push("missing_comparable_sale_price");
  if (comparables.some((comp) => comp.gla_sqft == null)) warnings.push("missing_comparable_gla");
  if (comparables.some((comp) => comp.adjusted_sale_price == null)) warnings.push("missing_adjusted_sale_price");
  if (reconciliation.final_opinion_of_value == null) warnings.push("missing_final_opinion_of_value");
  if (reconciliation.narrative == null) warnings.push("reconciliation_narrative_missing");

  return warnings;
}

function buildMissingFieldParserNotes(missingFields: string[], comparables: ComparableSale[]): string[] {
  const notes: string[] = [];
  const noteMap: Record<string, string> = {
    missing_subject_gla: "missing_subject_gla_no_alias_matched",
    missing_subject_condition: "missing_subject_condition_no_alias_matched",
    missing_subject_quality: "missing_subject_quality_no_alias_matched",
    missing_comparables: "missing_comparables_no_alias_matched",
    missing_comparable_sale_price: "comparable_sale_price_missing",
    missing_comparable_gla: "missing_comparable_gla_no_alias_matched",
    missing_adjusted_sale_price: "missing_adjusted_sale_price_no_alias_matched",
    missing_final_opinion_of_value: "missing_final_value_no_alias_matched",
    reconciliation_narrative_missing: "no_reconciliation_narrative_found"
  };

  for (const missingField of missingFields) {
    const note = noteMap[missingField];
    if (note) notes.push(note);
  }

  if (comparables.length > 0 && comparables.every((comp) => comp.adjustments.length === 0)) {
    notes.push("comparable_adjustments_empty");
  }

  return notes;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
