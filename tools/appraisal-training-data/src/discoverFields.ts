import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { assertReadableDirectory, assertWritableOutput, ensureDir, findXmlFiles, sha256, writeJson } from "./fileUtils.js";
import { inspectGridInventory } from "./gridExtract.js";
import { classifyMappingContext } from "./mappingReviewLogic.js";
import { parseXml } from "./parseXml.js";
import { normalizeKey, textValue, type XmlNode } from "./xmlValueFinder.js";
import { classifyValueShape, shapeCounts, type ValueShape } from "./valueShape.js";

interface DiscoverOptions {
  input: string;
  output: string;
  targets: string[];
  safeValueProfile: boolean;
}

interface PathProfile {
  path: string;
  count: number;
  shapes: Record<ValueShape, number>;
  sanitized_samples: string[];
  private_risk_count: number;
}

interface DiscoveryCandidate {
  target: string;
  path: string;
  strategy: "direct" | "grid_row";
  score: number;
  reasons: string[];
  count: number;
  value_shapes: Record<ValueShape, number>;
  sanitized_samples: string[];
}

const defaultTargets = [
  "subject.condition",
  "subject.quality",
  "comparables.condition",
  "comparables.quality",
  "comparables.gla_sqft",
  "comparables.sale_date",
  "comparables.adjusted_sale_price"
];

const targetSynonyms: Record<string, string[]> = {
  "subject.condition": [
    "condition",
    "condition rating",
    "overall condition",
    "property condition",
    "physical condition",
    "improvements condition",
    "subject condition",
    "c1",
    "c2",
    "c3",
    "c4",
    "c5",
    "c6"
  ],
  "subject.quality": [
    "quality",
    "quality rating",
    "q1",
    "q2",
    "q3",
    "q4",
    "q5",
    "q6",
    "quality of construction",
    "construction quality",
    "improvement quality",
    "subject quality"
  ],
  "comparables.condition": [
    "condition",
    "condition rating",
    "overall condition",
    "property condition",
    "comparable condition",
    "comp condition",
    "c1",
    "c2",
    "c3",
    "c4",
    "c5",
    "c6"
  ],
  "comparables.quality": [
    "quality",
    "quality rating",
    "q1",
    "q2",
    "q3",
    "q4",
    "q5",
    "q6",
    "quality of construction",
    "construction quality",
    "comparable quality",
    "comp quality"
  ],
  "comparables.gla_sqft": [
    "gross living area",
    "gla",
    "gross living area sq ft",
    "above grade living area",
    "living area",
    "square footage",
    "sqft",
    "sq ft",
    "building area",
    "comparable living area",
    "comp gla"
  ],
  "comparables.sale_date": ["sale date", "date of sale", "closed date", "settlement date", "contract date"],
  "comparables.adjusted_sale_price": [
    "adjusted sale price",
    "adjusted sales price",
    "net adjusted sale price",
    "adjusted value",
    "indicated value",
    "adjusted comparable value"
  ]
};

async function main(): Promise<void> {
  try {
    await runFieldDiscovery(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(`appraisal-discover-fields failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

export async function runFieldDiscovery(options: DiscoverOptions): Promise<void> {
  await assertReadableDirectory(options.input);
  await assertWritableOutput(options.output);
  await ensureDir(options.output);

  const xmlFiles = await findXmlFiles(options.input);
  if (xmlFiles.length === 0) throw new Error(`Zero XML files found in input folder: ${options.input}`);

  const pathValues = new Map<string, string[]>();
  const gridCandidates: DiscoveryCandidate[] = [];
  const privacyCounts: Record<ValueShape, number> = {} as Record<ValueShape, number>;
  let parsed = 0;
  let parseFailures = 0;

  console.log(`Discovering field candidates for ${xmlFiles.length} XML file(s). Private values will not be printed.`);

  for (const xmlPath of xmlFiles) {
    try {
      const parsedXml = parseXml(await readFile(xmlPath, "utf8"));
      parsed += 1;
      collectPathValues(parsedXml.root, [], pathValues);
      for (const row of inspectGridInventory(parsedXml.root)) {
        for (const target of options.targets) {
          if (!row.likely_fields.includes(target)) continue;
          gridCandidates.push({
            target,
            path: row.row_path,
            strategy: "grid_row",
            score: 0.78,
            reasons: [`grid row label: ${row.row_label}`],
            count: row.row_count,
            value_shapes: {} as Record<ValueShape, number>,
            sanitized_samples: []
          });
        }
      }
    } catch {
      parseFailures += 1;
    }
  }

  const profiles = [...pathValues.entries()].map(([pathName, values]) => {
    const profile = shapeCounts(values, options.safeValueProfile);
    for (const [shape, count] of Object.entries(profile.counts) as Array<[ValueShape, number]>) {
      privacyCounts[shape] = (privacyCounts[shape] ?? 0) + count;
    }
    return {
      path: pathName,
      count: values.length,
      shapes: profile.counts,
      sanitized_samples: profile.sanitized_samples,
      private_risk_count: profile.private_risk_count
    };
  });

  const candidates = [
    ...profiles.flatMap((profile) => scoreProfile(profile, options.targets)),
    ...gridCandidates
  ].sort((a, b) => b.score - a.score || b.count - a.count);

  const grouped = Object.fromEntries(
    options.targets.map((target) => [target, candidates.filter((candidate) => candidate.target === target).slice(0, 20)])
  );

  const candidatePathSet = new Set(candidates.filter((candidate) => candidate.score >= 0.35).map((candidate) => candidate.path));
  const unmappedPaths = profiles
    .filter((profile) => !candidatePathSet.has(profile.path))
    .sort((a, b) => b.count - a.count)
    .slice(0, 200);

  await writeJson(path.join(options.output, "discovery_candidates.json"), candidates);
  await writeJson(path.join(options.output, "target_field_candidates.json"), grouped);
  await writeJson(path.join(options.output, "unmapped_paths.json"), unmappedPaths);
  await writeJson(path.join(options.output, "value_shape_profile.json"), profiles.sort((a, b) => b.count - a.count));
  await writeJson(path.join(options.output, "privacy_audit.json"), {
    input_folder_hash: sha256(path.resolve(options.input)).slice(0, 16),
    xml_files_found: xmlFiles.length,
    parsed,
    parse_failures: parseFailures,
    raw_values_exported: false,
    safe_value_shapes_only: true,
    raw_source_file_names_exported: false,
    value_shape_counts: privacyCounts,
    private_risk_value_count: privateRiskCount(privacyCounts)
  });
  await writeJson(path.join(options.output, "proposed-field-mapping.local.template.json"), buildMappingTemplate(grouped));
  await writeFile(
    path.join(options.output, "discovery_summary.md"),
    buildSummary(options, xmlFiles.length, parsed, parseFailures, grouped),
    "utf8"
  );

  console.log(`Discovery complete. Parsed ${parsed}/${xmlFiles.length}.`);
}

function collectPathValues(node: XmlNode, pathParts: string[], output: Map<string, string[]>): void {
  if (node == null) return;
  if (Array.isArray(node)) {
    for (const item of node) collectPathValues(item, pathParts, output);
    return;
  }
  if (typeof node !== "object") {
    const value = textValue(node);
    if (value && pathParts.length > 0) {
      const pathName = pathParts.join(".");
      output.set(pathName, [...(output.get(pathName) ?? []), value]);
    }
    return;
  }

  const record = node as Record<string, XmlNode>;
  for (const [key, child] of Object.entries(record)) {
    collectPathValues(child, [...pathParts, key], output);
  }
}

function scoreProfile(profile: PathProfile, targets: string[]): DiscoveryCandidate[] {
  return targets
    .map((target) => {
      const reasons: string[] = [];
      let score = 0;
      const normalizedPath = normalizeForScoring(profile.path);

      for (const synonym of targetSynonyms[target] ?? []) {
        if (normalizedPath.includes(normalizeForScoring(synonym))) {
          score += 0.18;
          reasons.push(`path contains "${synonym}"`);
        }
      }

      const shapeScore = scoreShapeForTarget(target, profile.shapes);
      if (shapeScore > 0) {
        score += shapeScore;
        reasons.push("value shape matches target");
      }
      if (profile.count > 1) {
        score += 0.08;
        reasons.push("repeated path");
      }
      const context = classifyMappingContext(profile.path);
      if (target.startsWith("comparables.") && ["comparable_context", "sales_comparison_grid_context"].includes(context)) {
        score += 0.12;
        reasons.push(`context: ${context}`);
      }
      if (target.startsWith("comparables.") && context === "subject_context") {
        score -= 0.16;
        reasons.push("subject-context path requires review");
      }
      if (target.startsWith("subject.") && context === "subject_context") {
        score += 0.12;
        reasons.push("context: subject_context");
      }
      if (target.startsWith("subject.") && ["comparable_context", "sales_comparison_grid_context"].includes(context)) {
        score -= 0.16;
        reasons.push("comparable-context path requires review");
      }
      if (target === "comparables.gla_sqft" && context === "price_per_unit_context") {
        score -= 0.35;
        reasons.push("price-per-unit path is not comparable GLA");
      }
      if (target === "comparables.sale_date" && context === "prior_sale_context") {
        score -= 0.25;
        reasons.push("prior-sale path is not current comparable sale date");
      }
      if (profile.private_risk_count > 0) {
        score -= 0.2;
        reasons.push("private-risk values present");
      }

      return {
        target,
        path: profile.path,
        strategy: "direct" as const,
        score: Math.max(0, Math.min(0.99, Number(score.toFixed(2)))),
        reasons,
        count: profile.count,
        value_shapes: profile.shapes,
        sanitized_samples: profile.sanitized_samples
      };
    })
    .filter((candidate) => candidate.score >= 0.25)
    .sort((a, b) => b.score - a.score);
}

function scoreShapeForTarget(target: string, shapes: Record<ValueShape, number>): number {
  if (target.endsWith(".condition") && shapes.condition_code) return 0.45;
  if (target.endsWith(".quality") && shapes.quality_code) return 0.45;
  if (target === "comparables.gla_sqft" && shapes.numeric) return 0.25;
  if (target === "comparables.sale_date" && shapes.date) return 0.35;
  if (target === "comparables.adjusted_sale_price" && (shapes.currency || shapes.numeric)) return 0.3;
  return 0;
}

function buildMappingTemplate(grouped: Record<string, DiscoveryCandidate[]>): object {
  return {
    version: 1,
    instructions:
      "Copy this file to private/appraisal-field-mapping.local.json and set verified to true only after appraiser/data-owner review. The production pipeline ignores unverified candidates.",
    mappings: Object.fromEntries(
      Object.entries(grouped).map(([target, candidates]) => [
        target,
        candidates.slice(0, 5).map((candidate) => ({
          path: candidate.path,
          strategy: candidate.strategy,
          score: candidate.score,
          verified: false,
          notes: candidate.reasons.join("; ")
        }))
      ])
    )
  };
}

function buildSummary(
  options: DiscoverOptions,
  xmlFilesFound: number,
  parsed: number,
  parseFailures: number,
  grouped: Record<string, DiscoveryCandidate[]>
): string {
  const targetSections = options.targets
    .map((target) => {
      const candidates = grouped[target] ?? [];
      const plausible = candidates.filter((candidate) => candidate.score >= 0.55);
      return `### ${target}

- Plausible candidates found: ${plausible.length > 0 ? "yes" : "no"}
- Top candidate paths:
${candidates
  .slice(0, 5)
  .map((candidate) => `  - ${candidate.path} (${candidate.strategy}, score ${candidate.score})`)
  .join("\n") || "  - None"}
- Manual review next: confirm semantic meaning in the source system before copying any path into \`private/appraisal-field-mapping.local.json\`.
`;
    })
    .join("\n");

  return `# Field Discovery Summary

This report contains paths, scores, value-shape categories, and sanitized buckets only. It does not include raw XML values.

| Metric | Count |
| --- | ---: |
| XML files found | ${xmlFilesFound} |
| Parsed | ${parsed} |
| Parse failures | ${parseFailures} |

${targetSections}

## Mapping Template

Candidate mappings were written to:

\`proposed-field-mapping.local.template.json\`

Copy candidates to \`private/appraisal-field-mapping.local.json\` only after manual verification. Set \`verified: true\` or \`confidence: "manual_verified"\` only for confirmed mappings.
`;
}

function parseArgs(args: string[]): DiscoverOptions {
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
  const output = stringArg(values, "output");
  if (!input) throw new Error("Missing required --input folder");
  if (!output) throw new Error("Missing required --output folder");
  const targets = stringArg(values, "targets")?.split(",").map((item) => item.trim()).filter(Boolean) ?? defaultTargets;
  return {
    input,
    output,
    targets,
    safeValueProfile: booleanArg(values, "safe-value-profile", false)
  };
}

function normalizeForScoring(value: string): string {
  return normalizeKey(value).replace(/squarefeet/g, "sqft");
}

function stringArg(values: Map<string, string | boolean>, key: string): string | null {
  const value = values.get(key);
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

function privateRiskCount(counts: Record<ValueShape, number>): number {
  return Object.entries(counts)
    .filter(([shape]) => shape.endsWith("_private_risk"))
    .reduce((sum, [, count]) => sum + count, 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  void main();
}
