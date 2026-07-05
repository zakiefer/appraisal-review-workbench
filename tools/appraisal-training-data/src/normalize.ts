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
  normalizeKey,
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
  const subjectResult = buildSubject(subjectNode ?? root, root);
  parserNotes.push(...subjectResult.parserNotes);
  const subject = mergeGridSubject(subjectResult.subject, gridExtraction, parserNotes);
  const market = buildMarket(marketNode ?? root);
  const directComparableResult = buildComparables(root);
  parserNotes.push(...directComparableResult.parserNotes);
  const { comparables, parserNotes: comparableParserNotes, warnings: gridWarnings } = mergeGridComparables(
    directComparableResult.comparables,
    gridExtraction
  );
  parserNotes.push(...comparableParserNotes);
  const reconciliation = buildReconciliation(reconciliationNode ?? root, root);
  const appraiserComments = buildComments(commentsNode ?? root);
  const warningSeed = [...gridWarnings, ...subjectResult.warnings];
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

function buildSubject(node: XmlNode, root: XmlNode): { subject: SubjectProperty; parserNotes: string[]; warnings: string[] } {
  const subject: SubjectProperty = {
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
  return promoteSubjectAnalysisFacts(subject, node, root);
}

function promoteSubjectAnalysisFacts(
  subject: SubjectProperty,
  node: XmlNode,
  root: XmlNode
): { subject: SubjectProperty; parserNotes: string[]; warnings: string[] } {
  const merged = { ...subject };
  const parserNotes: string[] = [];
  const warnings: string[] = [];
  const rows = findPropertyAnalysisRows(node);
  const propertyConditionCodes = rows
    .filter((row) => normalizeKey(row.type ?? "").includes("propertycondition"))
    .map((row) => normalizeConditionRating(row.comment))
    .filter((value): value is string => Boolean(value));
  const qualityAppearanceRows = rows.filter((row) => normalizeKey(row.type ?? "").includes("qualityandappearance"));
  const qualityAppearanceConditionCodes = qualityAppearanceRows
    .map((row) => normalizeConditionRating(row.comment))
    .filter((value): value is string => Boolean(value));
  const qualityAppearanceQualityCodes = qualityAppearanceRows
    .map((row) => normalizeQualityRating(row.comment))
    .filter((value): value is string => Boolean(value));
  const costQualityCode = normalizeQualityRating(findFirstByAliases(root, ["CostServiceQualityRatingDescription"]));

  const preferredCondition = propertyConditionCodes[0] ?? qualityAppearanceConditionCodes[0] ?? null;
  const preferredQuality = qualityAppearanceQualityCodes[0] ?? costQualityCode;

  if (!merged.condition && preferredCondition) {
    merged.condition = preferredCondition;
    parserNotes.push("subject_analysis_filled_subject_condition");
  }
  if (!merged.quality && preferredQuality) {
    merged.quality = preferredQuality;
    parserNotes.push("subject_analysis_filled_subject_quality");
  }

  const conditionCandidates = dedupe([...propertyConditionCodes, ...qualityAppearanceConditionCodes]);
  const qualityCandidates = dedupe([...qualityAppearanceQualityCodes, ...(costQualityCode ? [costQualityCode] : [])]);
  if (conditionCandidates.length > 1) warnings.push("subject_condition_analysis_conflict");
  if (qualityCandidates.length > 1) warnings.push("subject_quality_analysis_conflict");

  return {
    subject: merged,
    parserNotes: dedupe(parserNotes),
    warnings: dedupe(warnings)
  };
}

function findPropertyAnalysisRows(node: XmlNode): Array<{ type: string | null; comment: string | null }> {
  const rows: Array<{ type: string | null; comment: string | null }> = [];

  function visit(current: XmlNode): void {
    if (!current || typeof current !== "object") return;
    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }

    const record = current as Record<string, XmlNode>;
    for (const [key, child] of Object.entries(record)) {
      if (normalizeKey(key) === "propertyanalysis") {
        const analysisRows = Array.isArray(child) ? child : [child];
        for (const row of analysisRows) {
          if (!row || typeof row !== "object" || Array.isArray(row)) continue;
          const rowRecord = row as Record<string, XmlNode>;
          rows.push({
            type: textByNormalizedKey(rowRecord, "type"),
            comment: textByNormalizedKey(rowRecord, "comment")
          });
        }
      }
      visit(child);
    }
  }

  visit(node);
  return rows;
}

function textByNormalizedKey(record: Record<string, XmlNode>, expectedKey: string): string | null {
  for (const [key, value] of Object.entries(record)) {
    if (normalizeKey(key) === expectedKey) return cleanText(textValue(value));
  }
  return null;
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

function buildComparables(root: XmlNode): { comparables: ComparableSale[]; parserNotes: string[] } {
  const parserNotes: string[] = [];
  const comparables = findNodesByAliases(root, [...SECTION_ALIASES.comparable])
    .filter((node) => node && typeof node === "object")
    .map((node, index) => {
      const result = buildComparable(node, index + 1);
      parserNotes.push(...result.parserNotes);
      return result.comparable;
    })
    .filter((comp) => hasComparableSignal(comp));

  return {
    comparables,
    parserNotes: dedupe(parserNotes)
  };
}

function buildComparable(node: XmlNode, index: number): { comparable: ComparableSale; parserNotes: string[] } {
  const bathrooms = normalizeNumber(field(node, "comparables.bathrooms"));
  const bathroomBreakdown = deriveBathroomBreakdown(bathrooms);
  const saleDateValue = field(node, "comparables.sale_date");
  const saleDateRaw = field(node, "comparables.sale_date_raw") ?? saleDateValue;
  const parsedSaleDates = parseUadDateOfSale(saleDateRaw);
  const base: ComparableSale = {
    comp_id: field(node, "comparables.comp_id") ?? `comp_${index}`,
    address_redacted: field(node, "comparables.address_redacted"),
    city: field(node, "comparables.city"),
    state: field(node, "comparables.state"),
    postal_code_redacted: field(node, "comparables.postal_code_redacted"),
    distance_miles: normalizeNumber(field(node, "comparables.distance_miles")),
    sale_price: normalizeCurrency(field(node, "comparables.sale_price")),
    sales_price_per_gla: normalizeCurrency(field(node, "comparables.sales_price_per_gla")),
    sale_date: parsedSaleDates.saleDate ?? normalizeDate(saleDateValue),
    sale_date_raw: saleDateRaw,
    contract_date: normalizeDate(field(node, "comparables.contract_date")) ?? parsedSaleDates.contractDate,
    data_source: field(node, "comparables.data_source"),
    verification_source: field(node, "comparables.verification_source"),
    property_rights: field(node, "comparables.property_rights"),
    sales_concessions: field(node, "comparables.sales_concessions"),
    financing_concessions: field(node, "comparables.financing_concessions"),
    gla_sqft: normalizeSquareFeet(field(node, "comparables.gla_sqft")),
    total_rooms: normalizeNumber(field(node, "comparables.total_rooms")),
    bedrooms: normalizeNumber(field(node, "comparables.bedrooms")),
    bathrooms,
    full_bathrooms: normalizeNumber(field(node, "comparables.full_bathrooms")) ?? bathroomBreakdown.full,
    half_bathrooms: normalizeNumber(field(node, "comparables.half_bathrooms")) ?? bathroomBreakdown.half,
    year_built: normalizeNumber(field(node, "comparables.year_built")),
    actual_age: normalizeNumber(field(node, "comparables.actual_age")),
    condition: field(node, "comparables.condition"),
    quality: field(node, "comparables.quality"),
    site_size: field(node, "comparables.site_size"),
    view: field(node, "comparables.view"),
    location: field(node, "comparables.location"),
    design_style: field(node, "comparables.design_style"),
    basement_area_sqft: normalizeSquareFeet(field(node, "comparables.basement_area_sqft")),
    basement_finished_sqft: normalizeSquareFeet(field(node, "comparables.basement_finished_sqft")),
    basement_description: field(node, "comparables.basement_description"),
    basement_finish: field(node, "comparables.basement_finish"),
    functional_utility: field(node, "comparables.functional_utility"),
    heating_cooling: field(node, "comparables.heating_cooling"),
    energy_efficient: field(node, "comparables.energy_efficient"),
    garage_carport: field(node, "comparables.garage_carport"),
    garage_spaces: normalizeNumber(field(node, "comparables.garage_spaces")),
    carport_spaces: normalizeNumber(field(node, "comparables.carport_spaces")),
    porch_deck: field(node, "comparables.porch_deck"),
    fireplaces: field(node, "comparables.fireplaces"),
    adjustments: buildAdjustments(node),
    net_adjustment: normalizeCurrency(field(node, "comparables.net_adjustment")),
    net_adjustment_percent: normalizeNumber(field(node, "comparables.net_adjustment_percent")),
    gross_adjustment: normalizeCurrency(field(node, "comparables.gross_adjustment")),
    gross_adjustment_percent: normalizeNumber(field(node, "comparables.gross_adjustment_percent")),
    adjusted_sale_price: normalizeCurrency(field(node, "comparables.adjusted_sale_price")),
    appraiser_comment: field(node, "comparables.appraiser_comment")
  };
  return promoteComparableAdjustmentFacts(base);
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
      comp.site_size ??
      comp.view ??
      comp.location ??
      comp.property_rights ??
      comp.financing_concessions ??
      comp.total_rooms ??
      comp.bedrooms ??
      comp.bathrooms ??
      comp.actual_age ??
      comp.design_style ??
      comp.basement_area_sqft ??
      comp.garage_carport ??
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

function promoteComparableAdjustmentFacts(
  comparable: ComparableSale
): { comparable: ComparableSale; parserNotes: string[] } {
  const parserNotes: string[] = [];

  const noteFor = (field: keyof ComparableSale): string => `adjustment_row_filled_comparables_${String(field)}`;
  const setFact = <K extends keyof ComparableSale>(fieldKey: K, value: ComparableSale[K] | null | undefined): void => {
    if (!hasUsefulValue(value)) return;
    if (!hasUsefulValue(comparable[fieldKey])) {
      comparable[fieldKey] = value as ComparableSale[K];
      parserNotes.push(noteFor(fieldKey));
    }
  };

  const bathroomBreakdown = deriveBathroomBreakdown(comparable.bathrooms);
  setFact("full_bathrooms", bathroomBreakdown.full);
  setFact("half_bathrooms", bathroomBreakdown.half);

  for (const adjustment of comparable.adjustments) {
    const fieldKey = normalizeComparableAdjustmentField(adjustment);
    const description = cleanComparableText(adjustment.description ?? adjustment.raw_value);
    if (!fieldKey || !description) continue;

    switch (fieldKey) {
      case "property_rights":
        setFact("property_rights", description);
        break;
      case "sales_concessions":
        setFact("sales_concessions", description);
        break;
      case "financing_concessions":
        setFact("financing_concessions", description);
        break;
      case "sale_date": {
        const parsedDate = parseUadDateOfSale(description);
        setFact("sale_date_raw", description);
        setFact("sale_date", parsedDate.saleDate ?? normalizeDate(description));
        setFact("contract_date", parsedDate.contractDate);
        break;
      }
      case "gla_sqft":
        setFact("gla_sqft", normalizeSquareFeet(description));
        break;
      case "site_size":
        setFact("site_size", description);
        break;
      case "view":
        setFact("view", description);
        break;
      case "location":
        setFact("location", description);
        break;
      case "condition":
        setFact("condition", normalizeConditionRating(description));
        break;
      case "quality":
        setFact("quality", normalizeQualityRating(description));
        break;
      case "actual_age":
        setFact("actual_age", normalizeNumber(description));
        break;
      case "design_style":
        setFact("design_style", description);
        break;
      case "basement_area_sqft": {
        const basement = parseBasementDescription(description);
        setFact("basement_description", basement.description);
        setFact("basement_area_sqft", basement.totalSqft);
        setFact("basement_finished_sqft", basement.finishedSqft);
        break;
      }
      case "basement_finish":
        setFact("basement_finish", description);
        break;
      case "functional_utility":
        setFact("functional_utility", description);
        break;
      case "heating_cooling":
        setFact("heating_cooling", description);
        break;
      case "energy_efficient":
        setFact("energy_efficient", description);
        break;
      case "garage_carport": {
        const storage = parseCarStorage(description);
        setFact("garage_carport", description);
        setFact("garage_spaces", storage.garageSpaces);
        setFact("carport_spaces", storage.carportSpaces);
        break;
      }
      case "porch_deck":
        setFact("porch_deck", description);
        break;
      case "fireplaces":
        setFact("fireplaces", description);
        break;
      case "other_features":
        appendOtherFeature(comparable, description, parserNotes);
        break;
    }
  }

  return {
    comparable,
    parserNotes: dedupe(parserNotes)
  };
}

type ComparableAdjustmentFact =
  | "property_rights"
  | "sales_concessions"
  | "financing_concessions"
  | "sale_date"
  | "gla_sqft"
  | "site_size"
  | "view"
  | "location"
  | "condition"
  | "quality"
  | "actual_age"
  | "design_style"
  | "basement_area_sqft"
  | "basement_finish"
  | "functional_utility"
  | "heating_cooling"
  | "energy_efficient"
  | "garage_carport"
  | "porch_deck"
  | "fireplaces"
  | "other_features";

function normalizeComparableAdjustmentField(adjustment: ComparableAdjustment): ComparableAdjustmentFact | null {
  const fieldKey = normalizeKey(adjustment.field);
  const descriptionKey = normalizeKey(adjustment.description ?? "");
  const combinedKey = `${fieldKey}${descriptionKey}`;

  if (fieldKey === "propertyrights") return "property_rights";
  if (fieldKey === "salesconcessions") return "sales_concessions";
  if (fieldKey === "financingconcessions") return "financing_concessions";
  if (fieldKey === "dateofsale") return "sale_date";
  if (fieldKey === "grosslivingarea" || fieldKey === "gla") return "gla_sqft";
  if (fieldKey === "sitearea" || fieldKey === "site" || fieldKey === "lotsize") return "site_size";
  if (fieldKey === "view") return "view";
  if (fieldKey === "location") return "location";
  if (fieldKey === "condition") return "condition";
  if (fieldKey === "quality") return "quality";
  if (fieldKey === "age" || fieldKey === "actualage") return "actual_age";
  if (fieldKey === "designstyle" || fieldKey === "designappeal" || fieldKey === "design") return "design_style";
  if (fieldKey === "basementarea" || fieldKey === "basement") return "basement_area_sqft";
  if (fieldKey === "basementfinish") return "basement_finish";
  if (fieldKey === "functionalutility") return "functional_utility";
  if (fieldKey === "heatingcooling") return "heating_cooling";
  if (fieldKey === "energyefficient") return "energy_efficient";
  if (fieldKey === "carstorage" || fieldKey === "garage" || fieldKey === "garagecarport") return "garage_carport";
  if (fieldKey === "porchdeck" || fieldKey === "porch" || fieldKey === "deck" || fieldKey === "patio") return "porch_deck";
  if (fieldKey === "fireplace" || fieldKey === "fireplaces") return "fireplaces";
  if (fieldKey === "other" && /fireplace|fireplaces/.test(descriptionKey)) return "fireplaces";
  if (fieldKey === "other" && descriptionKey) return "other_features";
  if (/fireplace|fireplaces/.test(combinedKey)) return "fireplaces";
  return null;
}

function deriveBathroomBreakdown(bathrooms: number | null | undefined): { full: number | null; half: number | null } {
  if (bathrooms == null || !Number.isFinite(bathrooms)) return { full: null, half: null };
  const full = Math.trunc(bathrooms);
  const half = Math.round((bathrooms - full) * 10);
  return {
    full: full >= 0 ? full : null,
    half: half > 0 ? half : null
  };
}

function parseUadDateOfSale(value: string | null | undefined): { saleDate: string | null; contractDate: string | null } {
  const cleaned = cleanComparableText(value);
  if (!cleaned) return { saleDate: null, contractDate: null };

  const saleToken = cleaned.match(/\bs\s*([0-9]{1,2}[/-][0-9]{2,4})\b/i);
  const contractToken = cleaned.match(/\bc\s*([0-9]{1,2}[/-][0-9]{2,4})\b/i);
  const saleDate = saleToken ? normalizeMonthYear(saleToken[1]) : normalizeDate(cleaned);
  const contractDate = contractToken ? normalizeMonthYear(contractToken[1]) : null;
  return { saleDate, contractDate };
}

function normalizeMonthYear(value: string | undefined): string | null {
  if (!value) return null;
  const match = value.trim().match(/^([0-9]{1,2})[/-]([0-9]{2,4})$/);
  if (!match) return null;
  const month = Number(match[1]);
  if (!Number.isFinite(month) || month < 1 || month > 12) return null;
  const yearRaw = match[2] ?? "";
  const yearNumber = Number(yearRaw);
  if (!Number.isFinite(yearNumber)) return null;
  const year = yearRaw.length === 2 ? (yearNumber >= 70 ? 1900 + yearNumber : 2000 + yearNumber) : yearNumber;
  return `${year}-${String(month).padStart(2, "0")}`;
}

function parseBasementDescription(value: string): {
  description: string | null;
  totalSqft: number | null;
  finishedSqft: number | null;
} {
  const description = cleanComparableText(value);
  if (!description) return { description: null, totalSqft: null, finishedSqft: null };
  const squareFootMatches = [...description.matchAll(/(\d[\d,]*)\s*(?:sf|sq\.?\s*ft\.?|sqft)/gi)];
  const totalSqft = normalizeSquareFeet(squareFootMatches[0]?.[1] ?? null);
  const finishedSqft = normalizeSquareFeet(squareFootMatches[1]?.[1] ?? null);
  return { description, totalSqft, finishedSqft };
}

function parseCarStorage(value: string): { garageSpaces: number | null; carportSpaces: number | null } {
  const cleaned = cleanComparableText(value);
  if (!cleaned) return { garageSpaces: null, carportSpaces: null };
  const garageMatch = cleaned.match(/(\d+(?:\.\d+)?)\s*(?:ga|gar|garage|g\b)/i);
  const carportMatch = cleaned.match(/(\d+(?:\.\d+)?)\s*(?:cp|carport)/i);
  return {
    garageSpaces: normalizeNumber(garageMatch?.[1]),
    carportSpaces: normalizeNumber(carportMatch?.[1])
  };
}

function appendOtherFeature(comparable: ComparableSale, value: string, parserNotes: string[]): void {
  const cleaned = cleanComparableText(value);
  if (!cleaned) return;
  const existing = comparable.other_features ?? [];
  if (existing.some((item) => item.toLowerCase() === cleaned.toLowerCase())) return;
  comparable.other_features = [...existing, cleaned];
  parserNotes.push("adjustment_row_filled_comparables_other_features");
}

function normalizeConditionRating(value: string | null | undefined): string | null {
  const match = cleanComparableText(value)?.match(/\bC[1-5]\b/i);
  return match ? match[0].toUpperCase() : null;
}

function normalizeQualityRating(value: string | null | undefined): string | null {
  const match = cleanComparableText(value)?.match(/\bQ[1-5]\b/i);
  return match ? match[0].toUpperCase() : null;
}

function cleanComparableText(value: string | null | undefined): string | null {
  const cleaned = cleanText(value ?? null);
  if (!cleaned) return null;
  if (/^(?:n\/?a|none|null|unknown|not applicable)$/i.test(cleaned)) return null;
  return cleaned;
}

function hasUsefulValue(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") return Boolean(cleanComparableText(value));
  if (Array.isArray(value)) return value.length > 0;
  return true;
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
