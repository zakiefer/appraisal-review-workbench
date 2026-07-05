import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  ADJUSTED_PRICE_TOLERANCE_DOLLARS,
  type AdjustedPriceClassification,
  arithmeticAdjustedSalePrice,
  classifyAdjustedPriceRow,
  valuesMatchWithinTolerance
} from "./adjustedPricePolicy.js";
import {
  assertReadableDirectory,
  assertWritableOutput,
  ensureDir,
  findXmlFiles,
  sha256,
  stableCaseId,
  writeJson
} from "./fileUtils.js";
import { collectValuesAtPath, loadLocalFieldMappings } from "./localMapping.js";
import { normalizeParsedXml } from "./normalize.js";
import { parseXml } from "./parseXml.js";
import { normalizeCurrency } from "./xmlValueFinder.js";

interface ResolutionAuditOptions {
  input: string;
  mapping: string;
  output: string;
}

type RecommendedConflictPolicy =
  | "keep_local_override"
  | "builtin_wins_on_conflict"
  | "arithmetic_resolver"
  | "disable_adjusted_sale_price_local_mapping";

interface ResolutionDetail {
  case_id: string;
  comp_id: string;
  comp_index: number;
  sale_price: number | null;
  net_adjustment: number | null;
  gross_adjustment: number | null;
  sum_of_adjustment_amounts: number | null;
  arithmetic_adjusted_sale_price: number | null;
  arithmetic_source: string | null;
  built_in_adjusted_sale_price: number | null;
  local_mapping_adjusted_sale_price: number | null;
  built_in_difference_to_arithmetic: number | null;
  local_difference_to_arithmetic: number | null;
  values_conflict: boolean;
  classification: AdjustedPriceClassification;
  classifications: AdjustedPriceClassification[];
  possible_index_misalignment: boolean;
  matched_neighbor_offset: -1 | 1 | null;
}

async function main(): Promise<void> {
  try {
    await runAdjustedPriceResolutionAudit(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(
      `appraisal-audit-adjusted-price-resolution failed: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 1;
  }
}

export async function runAdjustedPriceResolutionAudit(options: ResolutionAuditOptions): Promise<void> {
  await assertReadableDirectory(options.input);
  await assertWritableOutput(options.output);
  assertOutputUnderPrivate(options.output);
  await ensureDir(options.output);

  const mappings = await loadLocalFieldMappings(options.mapping);
  const adjustedMappings = mappings.filter((mapping) => mapping.field === "comparables.adjusted_sale_price");
  const xmlFiles = await findXmlFiles(options.input);
  if (xmlFiles.length === 0) throw new Error(`Zero XML files found in input folder: ${options.input}`);

  const details: ResolutionDetail[] = [];
  let parsed = 0;
  let parseFailures = 0;

  for (const xmlPath of xmlFiles) {
    try {
      const xmlContent = await readFile(xmlPath, "utf8");
      const parsedXml = parseXml(xmlContent);
      const builtIn = normalizeParsedXml(parsedXml, xmlPath);
      const localValues = adjustedMappings.flatMap((mapping) => collectValuesAtPath(parsedXml.root, mapping.path));
      const localAdjustedValues = localValues.map((value) => normalizeCurrency(value));
      const arithmeticValuesByIndex = builtIn.comparables.map((comp) => arithmeticAdjustedSalePrice(comp).value);
      const maxComparableCount = Math.max(builtIn.comparables.length, localAdjustedValues.length);
      parsed += 1;

      for (let index = 0; index < maxComparableCount; index += 1) {
        const comparable = builtIn.comparables[index];
        if (!comparable) continue;
        const builtInValue = comparable.adjusted_sale_price;
        const localValue = localAdjustedValues[index] ?? null;
        const classification = classifyAdjustedPriceRow({
          comparable,
          builtInValue,
          localValue,
          compIndex: index,
          arithmeticValuesByIndex
        });

        details.push({
          case_id: stableCaseId(xmlPath),
          comp_id: comparable.comp_id,
          comp_index: index + 1,
          sale_price: comparable.sale_price,
          net_adjustment: comparable.net_adjustment,
          gross_adjustment: comparable.gross_adjustment,
          sum_of_adjustment_amounts: classification.sum_of_adjustment_amounts,
          arithmetic_adjusted_sale_price: classification.arithmetic_adjusted_sale_price,
          arithmetic_source: classification.arithmetic_source,
          built_in_adjusted_sale_price: builtInValue,
          local_mapping_adjusted_sale_price: localValue,
          built_in_difference_to_arithmetic: classification.built_in_difference_to_arithmetic,
          local_difference_to_arithmetic: classification.local_difference_to_arithmetic,
          values_conflict:
            builtInValue != null &&
            localValue != null &&
            !valuesMatchWithinTolerance(builtInValue, localValue, ADJUSTED_PRICE_TOLERANCE_DOLLARS),
          classification: classification.classification,
          classifications: classification.classifications,
          possible_index_misalignment: classification.possible_index_misalignment,
          matched_neighbor_offset: classification.matched_neighbor_offset
        });
      }
    } catch {
      parseFailures += 1;
    }
  }

  const summary = buildResolutionSummary({
    input: options.input,
    mapping: options.mapping,
    xmlFilesFound: xmlFiles.length,
    parsed,
    parseFailures,
    adjustedMappingsLoaded: adjustedMappings.length,
    details
  });
  const recommendation = recommendPolicy(summary);
  const indexAlignment = buildIndexAlignmentCheck(details);

  await writeJson(path.join(options.output, "resolution_details.json"), {
    warning: "Private local audit. Contains adjusted sale price amounts. Do not commit.",
    summary,
    details
  });
  await writeJson(path.join(options.output, "index_alignment_check.json"), indexAlignment);
  await writeFile(path.join(options.output, "resolution_summary.md"), buildSummaryMarkdown(summary), "utf8");
  await writeFile(
    path.join(options.output, "recommended_conflict_policy.md"),
    buildRecommendationMarkdown(summary, recommendation),
    "utf8"
  );
  await writeJson(path.join(options.output, "privacy_audit.json"), {
    raw_values_exported: true,
    adjusted_sale_price_amounts_exported: true,
    sale_price_and_adjustment_amounts_exported: true,
    output_folder_must_remain_private: true,
    raw_source_file_names_exported: false,
    full_addresses_exported: false,
    names_exported: false,
    phone_email_license_parcel_loan_ids_exported: false,
    terminal_output_contains_raw_private_values: false
  });

  console.log(`Adjusted sale price resolution audit complete. Parsed ${parsed}/${xmlFiles.length}.`);
  console.log(`Comparable rows checked: ${summary.comparable_rows_checked}`);
  console.log(`Conflicting rows: ${summary.conflicting_rows}`);
  console.log(`Arithmetic checks available: ${summary.arithmetic_checks_available}`);
  console.log(`Possible index misalignment: ${summary.classification_counts.possible_index_misalignment}`);
  console.log(`Recommended policy: ${recommendation.policy}`);
}

function buildResolutionSummary(input: {
  input: string;
  mapping: string;
  xmlFilesFound: number;
  parsed: number;
  parseFailures: number;
  adjustedMappingsLoaded: number;
  details: ResolutionDetail[];
}) {
  const classificationCounts = emptyClassificationCounts();
  for (const detail of input.details) {
    for (const classification of detail.classifications) {
      classificationCounts[classification] += 1;
    }
  }

  return {
    input_folder_hash: sha256(path.resolve(input.input)).slice(0, 16),
    mapping_file_hash: sha256(path.resolve(input.mapping)).slice(0, 16),
    xml_files_found: input.xmlFilesFound,
    parsed: input.parsed,
    parse_failures: input.parseFailures,
    verified_adjusted_sale_price_mappings_loaded: input.adjustedMappingsLoaded,
    tolerance_dollars: ADJUSTED_PRICE_TOLERANCE_DOLLARS,
    comparable_rows_checked: input.details.length,
    conflicting_rows: input.details.filter((detail) => detail.values_conflict).length,
    arithmetic_checks_available: input.details.filter((detail) => detail.arithmetic_adjusted_sale_price != null).length,
    local_mapping_filled_missing_values: input.details.filter((detail) =>
      detail.classifications.includes("local_filled_missing_builtin")
    ).length,
    classification_counts: classificationCounts
  };
}

function buildIndexAlignmentCheck(details: ResolutionDetail[]) {
  const checked = details.filter((detail) => detail.values_conflict && detail.local_mapping_adjusted_sale_price != null);
  return {
    summary: {
      conflicts_checked: checked.length,
      local_matches_same_index_arithmetic: checked.filter((detail) =>
        detail.classifications.includes("local_matches_arithmetic")
      ).length,
      local_matches_previous_index_arithmetic: checked.filter((detail) => detail.matched_neighbor_offset === -1).length,
      local_matches_next_index_arithmetic: checked.filter((detail) => detail.matched_neighbor_offset === 1).length,
      possible_index_misalignment: checked.filter((detail) => detail.possible_index_misalignment).length,
      no_arithmetic_check_available: checked.filter((detail) =>
        detail.classifications.includes("no_arithmetic_check_available")
      ).length
    },
    details: checked.map((detail) => ({
      case_id: detail.case_id,
      comp_id: detail.comp_id,
      comp_index: detail.comp_index,
      local_matches_same_index_arithmetic: detail.classifications.includes("local_matches_arithmetic"),
      matched_neighbor_offset: detail.matched_neighbor_offset,
      possible_index_misalignment: detail.possible_index_misalignment,
      arithmetic_source: detail.arithmetic_source
    }))
  };
}

function recommendPolicy(summary: ReturnType<typeof buildResolutionSummary>): {
  policy: RecommendedConflictPolicy;
  reason: string;
} {
  const counts = summary.classification_counts;
  if (
    counts.possible_index_misalignment > 0 &&
    counts.possible_index_misalignment >= Math.max(counts.local_matches_arithmetic, counts.builtin_matches_arithmetic)
  ) {
    return {
      policy: "disable_adjusted_sale_price_local_mapping",
      reason: "The local mapping more often appears index-misaligned than clearly arithmetic-aligned."
    };
  }

  if (summary.arithmetic_checks_available === 0) {
    return {
      policy: "builtin_wins_on_conflict",
      reason: "No arithmetic checks are available, so the conservative choice is to keep built-in values on conflict."
    };
  }

  const localOnly = Math.max(0, counts.local_matches_arithmetic - counts.both_match_arithmetic);
  const builtInOnly = Math.max(0, counts.builtin_matches_arithmetic - counts.both_match_arithmetic);
  if (localOnly > builtInOnly && counts.neither_matches_arithmetic === 0 && counts.possible_index_misalignment === 0) {
    return {
      policy: "keep_local_override",
      reason: "Local mapped values match arithmetic more often and no arithmetic-checked rows are unresolved."
    };
  }

  if (builtInOnly > localOnly && counts.neither_matches_arithmetic === 0) {
    return {
      policy: "builtin_wins_on_conflict",
      reason: "Built-in values match arithmetic more often than local mapped values."
    };
  }

  if (localOnly + builtInOnly + counts.both_match_arithmetic > 0) {
    return {
      policy: "arithmetic_resolver",
      reason: "Arithmetic checks are available and winners vary, so use arithmetic to decide each conflict."
    };
  }

  return {
    policy: "builtin_wins_on_conflict",
    reason: "Conflicts remain unresolved by arithmetic, so keep built-in values and require manual review."
  };
}

function buildSummaryMarkdown(summary: ReturnType<typeof buildResolutionSummary>): string {
  return `# Adjusted Sale Price Resolution Audit

Private local audit. This report avoids addresses, names, source filenames, phone numbers, emails, license numbers, parcel numbers, loan numbers, and private IDs.

Dollar tolerance: $${summary.tolerance_dollars}

| Metric | Count |
| --- | ---: |
| XML files found | ${summary.xml_files_found} |
| Parsed | ${summary.parsed} |
| Parse failures | ${summary.parse_failures} |
| Verified adjusted sale price mappings loaded | ${summary.verified_adjusted_sale_price_mappings_loaded} |
| Comparable rows checked | ${summary.comparable_rows_checked} |
| Conflicting rows | ${summary.conflicting_rows} |
| Arithmetic checks available | ${summary.arithmetic_checks_available} |
| Local mapping filled missing built-in values | ${summary.local_mapping_filled_missing_values} |
| Local matches arithmetic | ${summary.classification_counts.local_matches_arithmetic} |
| Built-in matches arithmetic | ${summary.classification_counts.builtin_matches_arithmetic} |
| Both match arithmetic | ${summary.classification_counts.both_match_arithmetic} |
| Neither matches arithmetic | ${summary.classification_counts.neither_matches_arithmetic} |
| No arithmetic check available | ${summary.classification_counts.no_arithmetic_check_available} |
| Possible index misalignment | ${summary.classification_counts.possible_index_misalignment} |
| Unresolved needs manual review | ${summary.classification_counts.unresolved_needs_manual_review} |
`;
}

function buildRecommendationMarkdown(
  summary: ReturnType<typeof buildResolutionSummary>,
  recommendation: ReturnType<typeof recommendPolicy>
): string {
  return `# Recommended Adjusted Sale Price Conflict Policy

Recommendation: ${recommendation.policy}

Reason: ${recommendation.reason}

Counts used:

| Metric | Count |
| --- | ---: |
| Conflicting rows | ${summary.conflicting_rows} |
| Arithmetic checks available | ${summary.arithmetic_checks_available} |
| Local matches arithmetic | ${summary.classification_counts.local_matches_arithmetic} |
| Built-in matches arithmetic | ${summary.classification_counts.builtin_matches_arithmetic} |
| Both match arithmetic | ${summary.classification_counts.both_match_arithmetic} |
| Neither matches arithmetic | ${summary.classification_counts.neither_matches_arithmetic} |
| Possible index misalignment | ${summary.classification_counts.possible_index_misalignment} |
| Local mapping filled missing built-in values | ${summary.local_mapping_filled_missing_values} |

Do not use local_override unless a qualified reviewer confirms the local mapped adjusted sale prices are correctly aligned to comparable rows.
`;
}

function emptyClassificationCounts(): Record<AdjustedPriceClassification, number> {
  return {
    local_matches_arithmetic: 0,
    builtin_matches_arithmetic: 0,
    both_match_arithmetic: 0,
    neither_matches_arithmetic: 0,
    local_filled_missing_builtin: 0,
    no_arithmetic_check_available: 0,
    possible_index_misalignment: 0,
    unresolved_needs_manual_review: 0
  };
}

function assertOutputUnderPrivate(output: string): void {
  const privateRoot = path.resolve("private");
  const resolvedOutput = path.resolve(output);
  if (resolvedOutput !== privateRoot && !resolvedOutput.startsWith(`${privateRoot}${path.sep}`)) {
    throw new Error("Resolution audit writes adjusted sale price amounts and requires --output under ./private/");
  }
}

function parseArgs(args: string[]): ResolutionAuditOptions {
  const values = new Map<string, string | boolean>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = args[index + 1];
    if (next && !next.startsWith("--")) {
      values.set(key, next);
      index += 1;
    } else {
      values.set(key, true);
    }
  }
  const input = stringArg(values, "input");
  const mapping = stringArg(values, "mapping");
  const output = stringArg(values, "output");
  if (!input) throw new Error("Missing required --input folder");
  if (!mapping) throw new Error("Missing required --mapping file");
  if (!output) throw new Error("Missing required --output folder");
  return { input, mapping, output };
}

function stringArg(values: Map<string, string | boolean>, key: string): string | null {
  const value = values.get(key);
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  void main();
}
