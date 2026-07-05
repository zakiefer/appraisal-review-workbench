import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildFieldCoverage, type FieldCoverageRow } from "./fieldCoverage.js";
import { assertReadableDirectory, assertWritableOutput, ensureDir, findXmlFiles, sha256, writeJson } from "./fileUtils.js";
import {
  collectValuesAtPath,
  loadLocalFieldMappings,
  type VerifiedLocalMapping
} from "./localMapping.js";
import { normalizeParsedXml } from "./normalize.js";
import { parseXml } from "./parseXml.js";
import { validateNormalizedCase } from "./validate.js";
import { shapeCounts, type ValueShape } from "./valueShape.js";

interface ValidateMappingOptions {
  input: string;
  mapping: string;
  output: string;
}

async function main(): Promise<void> {
  try {
    await runMappingValidation(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(`appraisal-validate-mapping failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

export async function runMappingValidation(options: ValidateMappingOptions): Promise<void> {
  await assertReadableDirectory(options.input);
  await assertWritableOutput(options.output);
  await ensureDir(options.output);

  const mappings = await loadLocalFieldMappings(options.mapping);
  const xmlFiles = await findXmlFiles(options.input);
  if (xmlFiles.length === 0) throw new Error(`Zero XML files found in input folder: ${options.input}`);

  const baselineCases = [];
  const mappedCases = [];
  const mappingApplications: Array<{
    field: string;
    path: string;
    value_count: number;
    private_risk_count: number;
    shapes: Record<ValueShape, number>;
  }> = [];
  let parsed = 0;
  let parseFailures = 0;

  console.log(`Validating ${mappings.length} verified mapping(s) against ${xmlFiles.length} XML file(s).`);

  for (const xmlPath of xmlFiles) {
    try {
      const parsedXml = parseXml(await readFile(xmlPath, "utf8"));
      parsed += 1;
      baselineCases.push(validateNormalizedCase(normalizeParsedXml(parsedXml, xmlPath)));
      mappedCases.push(validateNormalizedCase(normalizeParsedXml(parsedXml, xmlPath, new Date(), { localFieldMappings: mappings })));

      for (const mapping of mappings) {
        const values = collectValuesAtPath(parsedXml.root, mapping.path);
        const profile = shapeCounts(values, true);
        mappingApplications.push({
          field: mapping.field,
          path: mapping.path,
          value_count: values.length,
          private_risk_count: profile.private_risk_count,
          shapes: profile.counts
        });
      }
    } catch {
      parseFailures += 1;
    }
  }

  const baselineCoverage = buildFieldCoverage(baselineCases);
  const coverageWithMapping = buildFieldCoverage(mappedCases, baselineCoverage);
  const validation = {
    input_folder_hash: sha256(path.resolve(options.input)).slice(0, 16),
    mapping_file_hash: sha256(path.resolve(options.mapping)).slice(0, 16),
    xml_files_found: xmlFiles.length,
    parsed,
    parse_failures: parseFailures,
    verified_mappings_loaded: mappings.length,
    coverage_before: summarizeCoverage(baselineCoverage),
    coverage_with_mapping: summarizeCoverage(coverageWithMapping),
    mapping_applications: aggregateApplications(mappingApplications)
  };

  await writeJson(path.join(options.output, "mapping_validation.json"), validation);
  await writeJson(path.join(options.output, "coverage_with_mapping.json"), coverageWithMapping);
  await writeJson(path.join(options.output, "privacy_audit.json"), buildPrivacyAudit(mappings, mappingApplications));
  await writeFile(path.join(options.output, "mapping_validation_summary.md"), buildSummary(mappings, validation), "utf8");

  console.log(`Mapping validation complete. Parsed ${parsed}/${xmlFiles.length}.`);
}

function summarizeCoverage(rows: FieldCoverageRow[]): Record<string, { populated: number; missing: number; coverage_pct: number }> {
  return Object.fromEntries(
    rows.map((row) => [
      row.field,
      {
        populated: row.populated,
        missing: row.missing,
        coverage_pct: Number(row.coverage_pct.toFixed(1))
      }
    ])
  );
}

function aggregateApplications(applications: Array<{
  field: string;
  path: string;
  value_count: number;
  private_risk_count: number;
  shapes: Record<ValueShape, number>;
}>): typeof applications {
  const aggregate = new Map<string, (typeof applications)[number]>();
  for (const item of applications) {
    const key = `${item.field}:${item.path}`;
    const existing = aggregate.get(key);
    if (existing) {
      existing.value_count += item.value_count;
      existing.private_risk_count += item.private_risk_count;
      for (const [shape, count] of Object.entries(item.shapes) as Array<[ValueShape, number]>) {
        existing.shapes[shape] = (existing.shapes[shape] ?? 0) + count;
      }
    } else {
      aggregate.set(key, {
        ...item,
        shapes: { ...item.shapes }
      });
    }
  }
  return [...aggregate.values()];
}

function buildPrivacyAudit(mappings: VerifiedLocalMapping[], applications: ReturnType<typeof aggregateApplications>): object {
  return {
    verified_mappings_loaded: mappings.length,
    raw_values_exported: false,
    safe_value_shapes_only: true,
    raw_source_file_names_exported: false,
    mapped_paths_with_private_risk_values: applications.filter((item) => item.private_risk_count > 0).map((item) => ({
      field: item.field,
      path: item.path,
      private_risk_count: item.private_risk_count
    })),
    private_risk_value_count: applications.reduce((sum, item) => sum + item.private_risk_count, 0)
  };
}

function buildSummary(mappings: VerifiedLocalMapping[], validation: {
  xml_files_found: number;
  parsed: number;
  parse_failures: number;
  verified_mappings_loaded: number;
  coverage_before: Record<string, { coverage_pct: number }>;
  coverage_with_mapping: Record<string, { coverage_pct: number }>;
}): string {
  const targetRows = [
    "subject.condition",
    "subject.quality",
    "comparables.condition",
    "comparables.quality",
    "comparables.gla_sqft",
    "comparables.sale_date",
    "comparables.adjusted_sale_price"
  ]
    .map((field) => {
      const before = validation.coverage_before[field]?.coverage_pct ?? 0;
      const after = validation.coverage_with_mapping[field]?.coverage_pct ?? 0;
      return `| ${field} | ${before.toFixed(1)}% | ${after.toFixed(1)}% | ${(after - before).toFixed(1)}% |`;
    })
    .join("\n");

  return `# Mapping Validation Summary

No candidate JSONL was written by this command.

| Metric | Count |
| --- | ---: |
| XML files found | ${validation.xml_files_found} |
| Parsed | ${validation.parsed} |
| Parse failures | ${validation.parse_failures} |
| Verified mappings loaded | ${validation.verified_mappings_loaded} |

## Target Coverage

| Field | Before | With Mapping | Delta |
| --- | ---: | ---: | ---: |
${targetRows}

## Loaded Mappings

${mappings.map((mapping) => `- ${mapping.field}: ${mapping.path} (${mapping.strategy}, ${mapping.confidence})`).join("\n") || "- None"}
`;
}

function parseArgs(args: string[]): ValidateMappingOptions {
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
