import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  assertReadableDirectory,
  assertWritableOutput,
  ensureDir,
  findXmlFiles,
  sha256,
  stableCaseId,
  writeJson
} from "./fileUtils.js";
import { loadLocalFieldMappings } from "./localMapping.js";
import { normalizeParsedXml } from "./normalize.js";
import { parseXml } from "./parseXml.js";

interface ConflictAuditOptions {
  input: string;
  mapping: string;
  output: string;
}

interface ConflictDetail {
  case_id: string;
  comp_id: string;
  comp_index: number;
  built_in_adjusted_sale_price: number | null;
  local_mapping_adjusted_sale_price: number | null;
  difference_amount: number | null;
  values_equal: boolean;
  built_in_null: boolean;
  local_mapping_null: boolean;
  local_mapping_filled_missing_value: boolean;
  local_mapping_improved_coverage: boolean;
  needs_manual_review: boolean;
  likely_explanation: string;
}

async function main(): Promise<void> {
  try {
    await runConflictAudit(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(`appraisal-audit-conflicts failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

export async function runConflictAudit(options: ConflictAuditOptions): Promise<void> {
  await assertReadableDirectory(options.input);
  await assertWritableOutput(options.output);
  assertOutputUnderPrivate(options.output);
  await ensureDir(options.output);

  const mappings = await loadLocalFieldMappings(options.mapping);
  const adjustedMappings = mappings.filter((mapping) => mapping.field === "comparables.adjusted_sale_price");
  const xmlFiles = await findXmlFiles(options.input);
  if (xmlFiles.length === 0) throw new Error(`Zero XML files found in input folder: ${options.input}`);

  const details: ConflictDetail[] = [];
  let parsed = 0;
  let parseFailures = 0;

  for (const xmlPath of xmlFiles) {
    try {
      const xmlContent = await readFile(xmlPath, "utf8");
      const parsedXml = parseXml(xmlContent);
      parsed += 1;
      const builtIn = normalizeParsedXml(parsedXml, xmlPath);
      const localMapped = normalizeParsedXml(parsedXml, xmlPath, new Date(), {
        localFieldMappings: adjustedMappings,
        adjustedPriceConflictPolicy: "local_override"
      });
      const maxComparableCount = Math.max(builtIn.comparables.length, localMapped.comparables.length);

      for (let index = 0; index < maxComparableCount; index += 1) {
        const builtInComp = builtIn.comparables[index];
        const localComp = localMapped.comparables[index];
        const builtInValue = builtInComp?.adjusted_sale_price ?? null;
        const localValue = localComp?.adjusted_sale_price ?? null;
        const valuesEqual = builtInValue === localValue;
        const differenceAmount = builtInValue != null && localValue != null ? localValue - builtInValue : null;
        const builtInNull = builtInValue == null;
        const localNull = localValue == null;
        const localFilledMissing = builtInNull && !localNull;

        details.push({
          case_id: stableCaseId(xmlPath),
          comp_id: localComp?.comp_id ?? builtInComp?.comp_id ?? `comp_${index + 1}`,
          comp_index: index + 1,
          built_in_adjusted_sale_price: builtInValue,
          local_mapping_adjusted_sale_price: localValue,
          difference_amount: differenceAmount,
          values_equal: valuesEqual,
          built_in_null: builtInNull,
          local_mapping_null: localNull,
          local_mapping_filled_missing_value: localFilledMissing,
          local_mapping_improved_coverage: localFilledMissing,
          needs_manual_review: !valuesEqual,
          likely_explanation: explainDifference(builtInValue, localValue)
        });
      }
    } catch {
      parseFailures += 1;
    }
  }

  const conflicts = details.filter((detail) => !detail.values_equal);
  const summary = {
    input_folder_hash: sha256(path.resolve(options.input)).slice(0, 16),
    mapping_file_hash: sha256(path.resolve(options.mapping)).slice(0, 16),
    xml_files_found: xmlFiles.length,
    parsed,
    parse_failures: parseFailures,
    verified_adjusted_sale_price_mappings_loaded: adjustedMappings.length,
    comparable_rows_checked: details.length,
    total_conflicts: conflicts.length,
    local_mapping_filled_missing_values: details.filter((detail) => detail.local_mapping_filled_missing_value).length,
    local_mapping_differed_from_built_in_values: details.filter(
      (detail) =>
        detail.built_in_adjusted_sale_price != null &&
        detail.local_mapping_adjusted_sale_price != null &&
        detail.built_in_adjusted_sale_price !== detail.local_mapping_adjusted_sale_price
    ).length,
    built_in_was_null: details.filter((detail) => detail.built_in_null).length,
    needing_manual_review: details.filter((detail) => detail.needs_manual_review).length
  };

  await writeJson(path.join(options.output, "conflict_details.json"), {
    warning: "Private local audit. Contains adjusted sale price amounts. Do not commit.",
    summary,
    details
  });
  await writeFile(path.join(options.output, "conflict_summary.md"), buildSummaryMarkdown(summary), "utf8");
  await writeFile(path.join(options.output, "conflict_recommendations.md"), buildRecommendationsMarkdown(summary), "utf8");
  await writeJson(path.join(options.output, "privacy_audit.json"), {
    raw_values_exported: true,
    adjusted_sale_price_amounts_exported: true,
    output_folder_must_remain_private: true,
    raw_source_file_names_exported: false,
    full_addresses_exported: false,
    names_exported: false,
    phone_email_license_parcel_loan_ids_exported: false
  });

  console.log(`Adjusted sale price conflict audit complete. Parsed ${parsed}/${xmlFiles.length}.`);
  console.log(`Conflicts: ${summary.total_conflicts}`);
  console.log(`Local mapping filled missing values: ${summary.local_mapping_filled_missing_values}`);
  console.log(`Local mapping differed from built-in values: ${summary.local_mapping_differed_from_built_in_values}`);
  console.log(`Built-in null rows: ${summary.built_in_was_null}`);
  console.log(`Need manual review: ${summary.needing_manual_review}`);
}

function explainDifference(builtInValue: number | null, localValue: number | null): string {
  if (builtInValue === localValue) return "values_equal";
  if (builtInValue == null && localValue != null) return "local_mapping_filled_missing_adjusted_sale_price";
  if (builtInValue != null && localValue == null) return "built_in_value_present_but_local_mapping_missing";
  return "manual_mapping_differs_from_built_in_extraction_review_comp_grid";
}

function buildSummaryMarkdown(summary: {
  xml_files_found: number;
  parsed: number;
  parse_failures: number;
  verified_adjusted_sale_price_mappings_loaded: number;
  comparable_rows_checked: number;
  total_conflicts: number;
  local_mapping_filled_missing_values: number;
  local_mapping_differed_from_built_in_values: number;
  built_in_was_null: number;
  needing_manual_review: number;
}): string {
  return `# Adjusted Sale Price Conflict Audit

Private local audit. This report intentionally avoids addresses, names, source filenames, phone numbers, emails, license numbers, parcel numbers, loan numbers, and private IDs.

| Metric | Count |
| --- | ---: |
| XML files found | ${summary.xml_files_found} |
| Parsed | ${summary.parsed} |
| Parse failures | ${summary.parse_failures} |
| Verified adjusted sale price mappings loaded | ${summary.verified_adjusted_sale_price_mappings_loaded} |
| Comparable rows checked | ${summary.comparable_rows_checked} |
| Total conflicts | ${summary.total_conflicts} |
| Local mapping filled missing values | ${summary.local_mapping_filled_missing_values} |
| Local mapping differed from built-in values | ${summary.local_mapping_differed_from_built_in_values} |
| Built-in was null | ${summary.built_in_was_null} |
| Need manual review | ${summary.needing_manual_review} |
`;
}

function buildRecommendationsMarkdown(summary: {
  total_conflicts: number;
  local_mapping_filled_missing_values: number;
  local_mapping_differed_from_built_in_values: number;
  needing_manual_review: number;
}): string {
  const keepRecommendation =
    summary.local_mapping_differed_from_built_in_values === 0
      ? "The manual mapping appears safe to keep from this audit because it only fills missing values or agrees with built-in extraction."
      : "Review conflicting rows against the comp grid before treating the manual adjusted-sale-price mapping as safe to keep.";

  return `# Conflict Recommendations

- ${keepRecommendation}
- Rows needing manual review: ${summary.needing_manual_review}.
- Local mapping filled missing adjusted sale prices: ${summary.local_mapping_filled_missing_values}.
- Local mapping differed from built-in adjusted sale prices: ${summary.local_mapping_differed_from_built_in_values}.
- Do not commit this private audit output.
`;
}

function assertOutputUnderPrivate(output: string): void {
  const privateRoot = path.resolve("private");
  const resolvedOutput = path.resolve(output);
  if (resolvedOutput !== privateRoot && !resolvedOutput.startsWith(`${privateRoot}${path.sep}`)) {
    throw new Error("Conflict audit writes adjusted sale price amounts and requires --output under ./private/");
  }
}

function parseArgs(args: string[]): ConflictAuditOptions {
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
