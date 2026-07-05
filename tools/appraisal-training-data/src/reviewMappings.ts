import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  assertReadableDirectory,
  assertWritableOutput,
  ensureDir,
  findXmlFiles,
  sha256,
  writeJson
} from "./fileUtils.js";
import { collectSafeValueProfiles, inspectGridInventory } from "./gridExtract.js";
import {
  classifyMappingContext,
  dominantShape,
  recommendCandidate,
  redactPrivateReviewValue,
  type MappingContext,
  type ReviewRecommendation
} from "./mappingReviewLogic.js";
import { parseXml } from "./parseXml.js";
import { shapeCounts, type ValueShape } from "./valueShape.js";
import { normalizeKey, textValue, type XmlNode } from "./xmlValueFinder.js";

interface ReviewMappingsOptions {
  input: string;
  discovery: string;
  output: string;
  targets: string[];
  allowPrivateValueReview: boolean;
}

interface PathAggregate {
  path: string;
  values: string[];
  fileHashes: Set<string>;
}

interface PathProfile {
  path: string;
  count: number;
  file_count: number;
  value_shapes: Partial<Record<ValueShape, number>>;
  sanitized_samples: string[];
  private_risk_count: number;
}

interface ReviewCandidate {
  path: string;
  score: number;
  context: MappingContext;
  value_shape_summary: {
    dominant_shape: ValueShape | null;
    safe_buckets: string[];
    shape_counts: Partial<Record<ValueShape, number>>;
  };
  occurrence_count: number;
  file_count: number;
  recommendation: ReviewRecommendation;
  reasoning: string[];
  review_questions: string[];
  suggested_mapping_entry: {
    path: string;
    strategy: "direct" | "grid_row";
    verified: false;
    confidence: "manual_required";
  };
}

interface ReviewPacket {
  target: string;
  candidates: ReviewCandidate[];
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
  "subject.condition": ["subject condition", "property condition", "overall condition", "condition rating", "condition"],
  "subject.quality": ["subject quality", "construction quality", "quality of construction", "quality rating", "quality"],
  "comparables.condition": ["comparable condition", "comp condition", "overall condition", "condition rating", "condition"],
  "comparables.quality": ["comparable quality", "comp quality", "quality of construction", "quality rating", "quality"],
  "comparables.gla_sqft": [
    "gross living area",
    "gla",
    "gross living area sq ft",
    "living area",
    "square footage",
    "sqft",
    "sq ft",
    "comp gla"
  ],
  "comparables.sale_date": ["sale date", "date of sale", "closed date", "settlement date", "contract date"],
  "comparables.adjusted_sale_price": [
    "adjusted sale price",
    "adjusted sales price",
    "net adjusted sale price",
    "adjusted value",
    "indicated value"
  ]
};

async function main(): Promise<void> {
  try {
    await runMappingReview(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(`appraisal-review-mappings failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

export async function runMappingReview(options: ReviewMappingsOptions): Promise<void> {
  await assertReadableDirectory(options.input);
  await assertReadableDirectory(options.discovery);
  await assertWritableOutput(options.output);
  await ensureDir(options.output);

  if (options.allowPrivateValueReview) {
    assertOutputUnderPrivate(options.output);
    console.warn(
      "PRIVATE VALUE REVIEW ENABLED: limited redacted samples will be written under private/. Do not commit this output."
    );
  }

  const xmlFiles = await findXmlFiles(options.input);
  if (xmlFiles.length === 0) throw new Error(`Zero XML files found in input folder: ${options.input}`);

  const aggregates = new Map<string, PathAggregate>();
  const gridProfiles = new Map<string, PathProfile>();
  let parsed = 0;
  let parseFailures = 0;

  console.log(`Building mapping review packets for ${xmlFiles.length} XML file(s). Raw values will not be printed.`);

  for (const xmlPath of xmlFiles) {
    try {
      const fileHash = sha256(path.resolve(xmlPath)).slice(0, 16);
      const parsedXml = parseXml(await readFile(xmlPath, "utf8"));
      parsed += 1;
      collectPathAggregates(parsedXml.root, [], aggregates, fileHash);
      collectGridProfiles(parsedXml.root, options.targets, gridProfiles, fileHash);
    } catch {
      parseFailures += 1;
    }
  }

  const profiles = [...aggregates.values()].map(toPathProfile);
  const directCandidates = profiles.flatMap((profile) => scoreProfile(profile, options.targets, "direct"));
  const gridCandidates = [...gridProfiles.values()].flatMap((profile) => scoreProfile(profile, options.targets, "grid_row"));
  const packets = buildReviewPackets([...directCandidates, ...gridCandidates], options.targets);

  await writeJson(path.join(options.output, "mapping_review_packets.json"), {
    generated_at: new Date().toISOString(),
    input_folder_hash: sha256(path.resolve(options.input)).slice(0, 16),
    discovery_folder_hash: sha256(path.resolve(options.discovery)).slice(0, 16),
    xml_files_found: xmlFiles.length,
    parsed,
    parse_failures: parseFailures,
    packets
  });
  await writeJson(path.join(options.output, "proposed_verified_mapping.template.json"), buildProposedTemplate(packets));
  await writeFile(path.join(options.output, "mapping_review_summary.md"), buildSummary(xmlFiles.length, parsed, parseFailures, packets), "utf8");
  await writeFile(path.join(options.output, "rejected_candidate_notes.md"), buildRejectedNotes(packets), "utf8");
  await writeJson(path.join(options.output, "privacy_audit.json"), {
    input_folder_hash: sha256(path.resolve(options.input)).slice(0, 16),
    discovery_folder_hash: sha256(path.resolve(options.discovery)).slice(0, 16),
    xml_files_found: xmlFiles.length,
    parsed,
    parse_failures: parseFailures,
    raw_values_exported: options.allowPrivateValueReview,
    safe_value_shapes_only: !options.allowPrivateValueReview,
    raw_source_file_names_exported: false,
    private_value_review_written: options.allowPrivateValueReview,
    private_risk_value_count: profiles.reduce((sum, profile) => sum + profile.private_risk_count, 0)
  });

  if (options.allowPrivateValueReview) {
    await writeJson(path.join(options.output, "private_value_review.json"), buildPrivateValueReview(packets, aggregates));
  }

  console.log(`Mapping review complete. Parsed ${parsed}/${xmlFiles.length}.`);
}

export { classifyMappingContext, recommendCandidate, redactPrivateReviewValue };

function collectPathAggregates(
  node: XmlNode,
  pathParts: string[],
  output: Map<string, PathAggregate>,
  fileHash: string
): void {
  if (node == null) return;
  if (Array.isArray(node)) {
    for (const item of node) collectPathAggregates(item, pathParts, output, fileHash);
    return;
  }
  if (typeof node !== "object") {
    const value = textValue(node);
    if (!value || pathParts.length === 0) return;
    const pathName = pathParts.join(".");
    const aggregate = output.get(pathName) ?? {
      path: pathName,
      values: [],
      fileHashes: new Set<string>()
    };
    aggregate.values.push(value);
    aggregate.fileHashes.add(fileHash);
    output.set(pathName, aggregate);
    return;
  }

  for (const [key, child] of Object.entries(node as Record<string, XmlNode>)) {
    collectPathAggregates(child, [...pathParts, key], output, fileHash);
  }
}

function collectGridProfiles(
  root: XmlNode,
  targets: string[],
  output: Map<string, PathProfile>,
  fileHash: string
): void {
  const targetSet = new Set(targets);
  const safeProfiles = collectSafeValueProfiles(root);
  const safeProfileByFieldPath = new Map(safeProfiles.map((profile) => [`${profile.field}:${profile.path}`, profile]));

  for (const row of inspectGridInventory(root)) {
    for (const target of row.likely_fields.filter((field) => targetSet.has(field))) {
      const key = `${target}:${row.row_path}`;
      const existing = output.get(key);
      const safeProfile = safeProfileByFieldPath.get(key);
      const samples = safeProfile?.samples ?? [];
      const inferredShape = inferGridShape(target, samples);
      if (existing) {
        existing.count += safeProfile?.count ?? row.possible_cell_count;
        existing.file_count += 1;
        for (const sample of samples) {
          if (!existing.sanitized_samples.includes(sample) && existing.sanitized_samples.length < 8) {
            existing.sanitized_samples.push(sample);
          }
        }
        if (inferredShape) {
          existing.value_shapes[inferredShape] = (existing.value_shapes[inferredShape] ?? 0) + (safeProfile?.count ?? row.row_count);
        }
      } else {
        output.set(key, {
          path: row.row_path,
          count: safeProfile?.count ?? row.possible_cell_count,
          file_count: 1,
          value_shapes: inferredShape ? { [inferredShape]: safeProfile?.count ?? row.row_count } : {},
          sanitized_samples: samples.slice(0, 8),
          private_risk_count: 0
        });
      }
    }
  }

  void fileHash;
}

function toPathProfile(aggregate: PathAggregate): PathProfile {
  const profile = shapeCounts(aggregate.values, true);
  return {
    path: aggregate.path,
    count: aggregate.values.length,
    file_count: aggregate.fileHashes.size,
    value_shapes: profile.counts,
    sanitized_samples: profile.sanitized_samples,
    private_risk_count: profile.private_risk_count
  };
}

function scoreProfile(
  profile: PathProfile,
  targets: string[],
  strategy: "direct" | "grid_row"
): Array<ReviewCandidate & { target: string }> {
  return targets
    .map((target) => {
      const reasons: string[] = [];
      let score = 0;
      const normalizedPath = normalizeForScoring(profile.path);
      for (const synonym of targetSynonyms[target] ?? []) {
        if (normalizedPath.includes(normalizeForScoring(synonym))) {
          score += 0.16;
          reasons.push(`Path contains ${synonym}.`);
        }
      }

      const shapeScore = scoreShapeForTarget(target, profile.value_shapes);
      if (shapeScore > 0) {
        score += shapeScore;
        reasons.push("Value shape matches target.");
      }
      if (profile.count > 1) {
        score += 0.06;
        reasons.push("Path appears repeatedly.");
      }

      const context = classifyMappingContext(profile.path, strategy);
      if (target.startsWith("subject.") && context === "subject_context") score += 0.16;
      if (target.startsWith("subject.") && (context === "comparable_context" || context === "sales_comparison_grid_context")) score -= 0.12;
      if (target.startsWith("comparables.") && (context === "comparable_context" || context === "sales_comparison_grid_context")) score += 0.16;
      if (target.startsWith("comparables.") && context === "subject_context") score -= 0.18;
      if (target === "comparables.gla_sqft" && context === "price_per_unit_context") score -= 0.32;
      if (target === "comparables.sale_date" && context === "prior_sale_context") score -= 0.2;
      if (profile.private_risk_count > 0) {
        score -= 0.2;
        reasons.push("Private-risk values present.");
      }

      const decision = recommendCandidate({
        target,
        path: profile.path,
        strategy,
        value_shapes: profile.value_shapes,
        sanitized_samples: profile.sanitized_samples
      });
      const finalScore = Math.max(0, Math.min(0.99, Number(score.toFixed(2))));
      return {
        target,
        path: profile.path,
        score: finalScore,
        context: decision.context,
        value_shape_summary: {
          dominant_shape: dominantShape(profile.value_shapes),
          safe_buckets: profile.sanitized_samples,
          shape_counts: profile.value_shapes
        },
        occurrence_count: profile.count,
        file_count: profile.file_count,
        recommendation: decision.recommendation,
        reasoning: [...reasons, ...decision.reasoning],
        review_questions: decision.review_questions,
        suggested_mapping_entry: {
          path: profile.path,
          strategy,
          verified: false as const,
          confidence: "manual_required" as const
        }
      };
    })
    .filter((candidate) => candidate.score >= 0.2 || candidate.recommendation !== "needs_manual_review")
    .sort((a, b) => b.score - a.score || b.occurrence_count - a.occurrence_count);
}

function buildReviewPackets(candidates: Array<ReviewCandidate & { target: string }>, targets: string[]): ReviewPacket[] {
  return targets.map((target) => {
    const seen = new Set<string>();
    const targetCandidates = candidates
      .filter((candidate) => candidate.target === target)
      .filter((candidate) => {
        const key = `${candidate.path}:${candidate.suggested_mapping_entry.strategy}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => recommendationRank(a.recommendation) - recommendationRank(b.recommendation) || b.score - a.score || b.occurrence_count - a.occurrence_count)
      .slice(0, 20)
      .map(({ target: _target, ...candidate }) => candidate);
    return {
      target,
      candidates: targetCandidates
    };
  });
}

function buildProposedTemplate(packets: ReviewPacket[]): object {
  return {
    version: 1,
    instructions:
      "Copy to private/appraisal-field-mapping.local.json. Only set verified true after manual review. The pipeline ignores entries that remain unverified/manual_required.",
    mappings: Object.fromEntries(
      packets.map((packet) => {
        const betterCandidates = packet.candidates.filter((candidate) => candidate.recommendation !== "likely_reject");
        const selected = (betterCandidates.length > 0 ? betterCandidates : packet.candidates).slice(0, 5);
        return [
          packet.target,
          selected.map((candidate) => ({
            path: candidate.path,
            strategy: candidate.suggested_mapping_entry.strategy,
            verified: false,
            confidence: "manual_required",
            review_recommendation: candidate.recommendation,
            review_notes:
              candidate.recommendation === "likely_reject"
                ? `Rejected/unsafe candidate: ${candidate.reasoning.join(" ")}`
                : candidate.reasoning.join(" ")
          }))
        ];
      })
    )
  };
}

function buildSummary(xmlFilesFound: number, parsed: number, parseFailures: number, packets: ReviewPacket[]): string {
  const targetSections = packets
    .map((packet) => {
      const counts = countRecommendations(packet.candidates);
      const top = packet.candidates.slice(0, 5);
      return `### ${packet.target}

- likely_accept: ${counts.likely_accept}
- needs_manual_review: ${counts.needs_manual_review}
- likely_reject: ${counts.likely_reject}
- Top candidates:
${top
  .map(
    (candidate) =>
      `  - ${candidate.path} (${candidate.suggested_mapping_entry.strategy}, ${candidate.context}, ${candidate.recommendation}, score ${candidate.score})`
  )
  .join("\n") || "  - None"}
`;
    })
    .join("\n");

  return `# Mapping Review Summary

This report contains path names, context labels, recommendations, value-shape categories, and sanitized buckets only. It does not include raw XML values.

| Metric | Count |
| --- | ---: |
| XML files found | ${xmlFilesFound} |
| Parsed | ${parsed} |
| Parse failures | ${parseFailures} |

${targetSections}

## Output Files

- mapping_review_packets.json
- proposed_verified_mapping.template.json
- rejected_candidate_notes.md
- privacy_audit.json
`;
}

function buildRejectedNotes(packets: ReviewPacket[]): string {
  const rejected = packets.flatMap((packet) =>
    packet.candidates
      .filter((candidate) => candidate.recommendation === "likely_reject")
      .slice(0, 8)
      .map((candidate) => `- ${packet.target}: ${candidate.path} (${candidate.context})`)
  );

  return `# Rejected Candidate Notes

These notes are generated from safe path/context analysis only. They are intended to prevent common false-positive mappings.

## Guardrails

- Do not map comparable-level GSEOverallConditionType to subject.condition.
- Do not map comparable-level GSEQualityOfConstructionRatingType to subject.quality.
- Do not map subject GrossLivingAreaSquareFeetCount to comparables.gla_sqft.
- Do not map price-per-GLA fields to comparables.gla_sqft.
- Do not map prior sale dates to current comparable sale_date.
- Do not map cost-service quality to UAD subject quality unless manually verified.

## Likely Rejected Candidates

${rejected.join("\n") || "- None"}
`;
}

function buildPrivateValueReview(
  packets: ReviewPacket[],
  aggregates: Map<string, PathAggregate>
): object {
  return {
    warning:
      "PRIVATE LOCAL REVIEW ONLY. Do not commit. Samples are limited, redacted, and may still require human privacy review.",
    candidates: packets.flatMap((packet) =>
      packet.candidates.slice(0, 8).map((candidate) => {
        const aggregate = aggregates.get(candidate.path);
        return {
          target: packet.target,
          path: candidate.path,
          recommendation: candidate.recommendation,
          samples: aggregate ? limitedSamples(candidate.path, aggregate.values) : []
        };
      })
    )
  };
}

function limitedSamples(pathName: string, values: string[]): string[] {
  const samples: string[] = [];
  for (const value of values) {
    const redacted = redactPrivateReviewValue(pathName, value);
    if (redacted && !samples.includes(redacted)) samples.push(redacted);
    if (samples.length >= 3) break;
  }
  return samples;
}

function scoreShapeForTarget(target: string, shapes: Partial<Record<ValueShape, number>>): number {
  if (target.endsWith(".condition") && shapes.condition_code) return 0.42;
  if (target.endsWith(".quality") && shapes.quality_code) return 0.42;
  if (target === "comparables.gla_sqft" && shapes.numeric) return 0.26;
  if (target === "comparables.sale_date" && shapes.date) return 0.35;
  if (target === "comparables.adjusted_sale_price" && (shapes.currency || shapes.numeric)) return 0.3;
  return 0;
}

function inferGridShape(target: string, samples: string[]): ValueShape | null {
  if (target.endsWith(".condition") && samples.length > 0) return "condition_code";
  if (target.endsWith(".quality") && samples.length > 0) return "quality_code";
  if (target === "comparables.gla_sqft" && samples.length > 0) return "numeric";
  if (target === "comparables.sale_date" && samples.length > 0) return "date";
  if (target === "comparables.adjusted_sale_price" && samples.length > 0) return "currency";
  return null;
}

function countRecommendations(candidates: ReviewCandidate[]): Record<ReviewRecommendation, number> {
  return {
    likely_accept: candidates.filter((candidate) => candidate.recommendation === "likely_accept").length,
    likely_reject: candidates.filter((candidate) => candidate.recommendation === "likely_reject").length,
    needs_manual_review: candidates.filter((candidate) => candidate.recommendation === "needs_manual_review").length
  };
}

function recommendationRank(recommendation: ReviewRecommendation): number {
  if (recommendation === "likely_accept") return 0;
  if (recommendation === "needs_manual_review") return 1;
  return 2;
}

function assertOutputUnderPrivate(output: string): void {
  const privateRoot = path.resolve("private");
  const resolvedOutput = path.resolve(output);
  if (resolvedOutput !== privateRoot && !resolvedOutput.startsWith(`${privateRoot}${path.sep}`)) {
    throw new Error("--allow-private-value-review true requires --output to be under ./private/");
  }
}

function parseArgs(args: string[]): ReviewMappingsOptions {
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
  const discovery = stringArg(values, "discovery");
  const output = stringArg(values, "output");
  if (!input) throw new Error("Missing required --input folder");
  if (!discovery) throw new Error("Missing required --discovery folder");
  if (!output) throw new Error("Missing required --output folder");

  return {
    input,
    discovery,
    output,
    targets: stringArg(values, "targets")?.split(",").map((item) => item.trim()).filter(Boolean) ?? defaultTargets,
    allowPrivateValueReview: booleanArg(values, "allow-private-value-review", false)
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

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  void main();
}
