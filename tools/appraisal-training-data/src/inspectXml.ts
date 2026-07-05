import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { aliasesFor, FIELD_ALIASES, type FieldAliasKey } from "./fieldAliases.js";
import { assertReadableDirectory, assertWritableOutput, ensureDir, findXmlFiles, sha256, writeJson } from "./fileUtils.js";
import { collectSafeValueProfiles, inspectGridInventory, type GridInventoryRow, type SafeValueProfileRow } from "./gridExtract.js";
import { parseXml } from "./parseXml.js";
import { normalizeKey, type XmlNode } from "./xmlValueFinder.js";

interface InspectOptions {
  input: string;
  output: string;
  safeValueProfile: boolean;
}

interface InventoryRow {
  path: string;
  count: number;
}

interface TagInventoryRow {
  tag: string;
  count: number;
}

interface LikelyFieldMatch {
  path: string;
  count: number;
  likelyField: string;
  matchReason: "alias_terminal" | "alias_path_suffix";
}

interface InspectSummary {
  created_at: string;
  input_folder_hash: string;
  xml_files_found: number;
  parsed: number;
  parse_failures: number;
  unique_tags: number;
  unique_paths: number;
  likely_field_matches: number;
  grid_rows: number;
  safe_value_profile_rows: number;
}

async function main(): Promise<void> {
  try {
    const options = parseInspectArgs(process.argv.slice(2));
    await runInspectXml(options);
  } catch (error) {
    console.error(`appraisal-inspect-xml failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

export async function runInspectXml(options: InspectOptions): Promise<void> {
  await assertReadableDirectory(options.input);
  await assertWritableOutput(options.output);
  await ensureDir(options.output);

  const xmlFiles = await findXmlFiles(options.input);
  if (xmlFiles.length === 0) {
    throw new Error(`Zero XML files found in input folder: ${options.input}`);
  }

  const tagCounts = new Map<string, number>();
  const pathCounts = new Map<string, number>();
  const gridRows: GridInventoryRow[] = [];
  const safeValueProfiles: SafeValueProfileRow[] = [];
  const parseFailureHashes: string[] = [];
  let parsed = 0;

  console.log(`Inspecting XML shape for ${xmlFiles.length} file(s). Values will not be exported.`);

  for (const xmlPath of xmlFiles) {
    try {
      const xmlContent = await readFile(xmlPath, "utf8");
      const parsedXml = parseXml(xmlContent);
      parsed += 1;
      collectShape(parsedXml.root, [], tagCounts, pathCounts);
      gridRows.push(...inspectGridInventory(parsedXml.root));
      if (options.safeValueProfile) {
        safeValueProfiles.push(...collectSafeValueProfiles(parsedXml.root));
      }
    } catch {
      parseFailureHashes.push(sha256(path.resolve(xmlPath)).slice(0, 16));
    }
  }

  const tagInventory = sortRows([...tagCounts].map(([tag, count]) => ({ tag, count })));
  const pathInventory = sortRows([...pathCounts].map(([pathName, count]) => ({ path: pathName, count })));
  const likelyMatches = buildLikelyFieldMatches(pathInventory);
  const gridInventory = aggregateGridRows(gridRows);
  const safeValueProfile = aggregateSafeValueProfiles(safeValueProfiles);
  const summary: InspectSummary = {
    created_at: new Date().toISOString(),
    input_folder_hash: sha256(path.resolve(options.input)).slice(0, 16),
    xml_files_found: xmlFiles.length,
    parsed,
    parse_failures: parseFailureHashes.length,
    unique_tags: tagInventory.length,
    unique_paths: pathInventory.length,
    likely_field_matches: likelyMatches.length,
    grid_rows: gridInventory.length,
    safe_value_profile_rows: safeValueProfile.length
  };

  await writeJson(path.join(options.output, "tag_inventory.json"), tagInventory);
  await writeJson(path.join(options.output, "path_inventory.json"), pathInventory);
  await writeJson(path.join(options.output, "likely_field_matches.json"), likelyMatches);
  await writeJson(path.join(options.output, "grid_inventory.json"), gridInventory);
  await writeFile(path.join(options.output, "grid_inventory.md"), buildGridInventoryMarkdown(gridInventory), "utf8");
  if (options.safeValueProfile) {
    await writeJson(path.join(options.output, "safe_value_profile.json"), safeValueProfile);
  }
  await writeFile(path.join(options.output, "summary.md"), buildInspectionSummary(summary, likelyMatches, gridInventory), "utf8");

  console.log(`Inspection complete. Parsed ${summary.parsed}/${summary.xml_files_found}.`);
  console.log(`Unique tags: ${summary.unique_tags}`);
  console.log(`Unique paths: ${summary.unique_paths}`);
  console.log(`Likely field matches: ${summary.likely_field_matches}`);
  console.log(`Grid rows: ${summary.grid_rows}`);
}

function collectShape(
  node: XmlNode,
  pathParts: string[],
  tagCounts: Map<string, number>,
  pathCounts: Map<string, number>
): void {
  if (node == null) return;

  if (Array.isArray(node)) {
    for (const item of node) {
      collectShape(item, pathParts, tagCounts, pathCounts);
    }
    return;
  }

  if (typeof node !== "object") return;

  for (const [key, child] of Object.entries(node)) {
    const nextPath = [...pathParts, key];
    const pathName = nextPath.join(".");
    tagCounts.set(key, (tagCounts.get(key) ?? 0) + 1);
    pathCounts.set(pathName, (pathCounts.get(pathName) ?? 0) + 1);
    collectShape(child, nextPath, tagCounts, pathCounts);
  }
}

function buildLikelyFieldMatches(pathInventory: InventoryRow[]): LikelyFieldMatch[] {
  const matches: LikelyFieldMatch[] = [];

  for (const row of pathInventory) {
    const pathParts = row.path.split(".");
    const terminal = pathParts.at(-1) ?? row.path;
    for (const field of Object.keys(FIELD_ALIASES) as FieldAliasKey[]) {
      const aliases = aliasesFor(field);
      const terminalMatched = aliases.some((alias) => {
        const aliasTerminal = alias.split(/[./]/).filter(Boolean).at(-1) ?? alias;
        return normalizeKey(aliasTerminal) === normalizeKey(terminal);
      });
      if (terminalMatched) {
        matches.push({
          path: row.path,
          count: row.count,
          likelyField: field,
          matchReason: "alias_terminal"
        });
        continue;
      }

      const normalizedPath = pathParts.map(normalizeKey).join(".");
      const pathSuffixMatched = aliases.some((alias) => {
        const normalizedAlias = alias.split(/[./]/).filter(Boolean).map(normalizeKey).join(".");
        return normalizedAlias.length > 0 && normalizedPath.endsWith(normalizedAlias);
      });
      if (pathSuffixMatched) {
        matches.push({
          path: row.path,
          count: row.count,
          likelyField: field,
          matchReason: "alias_path_suffix"
        });
      }
    }
  }

  return matches.sort((a, b) => a.likelyField.localeCompare(b.likelyField) || b.count - a.count);
}

function buildInspectionSummary(
  summary: InspectSummary,
  likelyMatches: LikelyFieldMatch[],
  gridInventory: GridInventoryRow[]
): string {
  const topMatches = likelyMatches.slice(0, 25);
  return `# XML Shape Inspection

Created at: ${summary.created_at}

This report intentionally includes tag names, paths, counts, and likely normalized-field matches only. It does not include XML text values or source filenames.

## Counts

| Metric | Count |
| --- | ---: |
| XML files found | ${summary.xml_files_found} |
| Parsed | ${summary.parsed} |
| Parse failures | ${summary.parse_failures} |
| Unique tags | ${summary.unique_tags} |
| Unique paths | ${summary.unique_paths} |
| Likely field matches | ${summary.likely_field_matches} |
| Grid rows | ${summary.grid_rows} |
| Safe value profile rows | ${summary.safe_value_profile_rows} |

## Top Likely Matches

| Likely Field | Path | Count | Reason |
| --- | --- | ---: | --- |
${topMatches.map((match) => `| ${match.likelyField} | ${match.path} | ${match.count} | ${match.matchReason} |`).join("\n")}

Use \`likely_field_matches.json\` to identify new aliases for fields with low coverage.

## Grid Inventory

See \`grid_inventory.json\` and \`grid_inventory.md\` for value-free row/column diagnostics.

Top grid rows:

| Row Label | Likely Fields | Row Count | Possible Cell Count |
| --- | --- | ---: | ---: |
${gridInventory
  .slice(0, 25)
  .map((row) => `| ${row.row_label} | ${row.likely_fields.join(", ")} | ${row.row_count} | ${row.possible_cell_count} |`)
  .join("\n")}
`;
}

function parseInspectArgs(args: string[]): InspectOptions {
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

  const input = valueAsString(values.get("input"));
  const output = valueAsString(values.get("output"));
  if (!input) throw new Error("Missing required --input folder");
  if (!output) throw new Error("Missing required --output folder");
  return { input, output, safeValueProfile: booleanArg(values, "safe-value-profile", false) };
}

function valueAsString(value: string | boolean | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function booleanArg(values: Map<string, string | boolean>, key: string, fallback: boolean): boolean {
  const value = values.get(key);
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  if (["true", "1", "yes"].includes(value.toLowerCase())) return true;
  if (["false", "0", "no"].includes(value.toLowerCase())) return false;
  return fallback;
}

function sortRows<T extends { count: number }>(rows: T[]): T[] {
  return rows.sort((a, b) => b.count - a.count);
}

function aggregateGridRows(rows: GridInventoryRow[]): GridInventoryRow[] {
  const aggregate = new Map<string, GridInventoryRow>();
  for (const row of rows) {
    const key = `${row.row_path}:${row.row_label}:${row.likely_fields.join("|")}`;
    const existing = aggregate.get(key);
    if (existing) {
      existing.row_count += row.row_count;
      existing.possible_cell_count += row.possible_cell_count;
    } else {
      aggregate.set(key, { ...row });
    }
  }
  return [...aggregate.values()].sort((a, b) => b.row_count - a.row_count || a.row_label.localeCompare(b.row_label));
}

function aggregateSafeValueProfiles(rows: SafeValueProfileRow[]): SafeValueProfileRow[] {
  const aggregate = new Map<string, SafeValueProfileRow>();
  for (const row of rows) {
    const key = `${row.field}:${row.path}:${row.row_label}`;
    const existing = aggregate.get(key);
    if (existing) {
      existing.count += row.count;
      for (const sample of row.samples) {
        if (!existing.samples.includes(sample) && existing.samples.length < 8) {
          existing.samples.push(sample);
        }
      }
    } else {
      aggregate.set(key, { ...row, samples: [...row.samples] });
    }
  }
  return [...aggregate.values()].sort((a, b) => b.count - a.count || a.field.localeCompare(b.field));
}

function buildGridInventoryMarkdown(rows: GridInventoryRow[]): string {
  return `# Grid Inventory

This report lists safe normalized row labels and likely normalized fields only. It intentionally omits cell values.

| Row Label | Likely Fields | Row Path | Row Count | Possible Cell Count |
| --- | --- | --- | ---: | ---: |
${rows
  .map(
    (row) =>
      `| ${row.row_label} | ${row.likely_fields.join(", ")} | ${row.row_path} | ${row.row_count} | ${
        row.possible_cell_count
      } |`
  )
  .join("\n")}
`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  void main();
}
