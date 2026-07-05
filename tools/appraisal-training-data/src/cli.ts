import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  DEFAULT_ADJUSTED_PRICE_CONFLICT_POLICY,
  adjustedPriceConflictPolicies
} from "./adjustedPricePolicy.js";
import { buildTrainingCase } from "./buildTrainingCase.js";
import { exportJsonl } from "./exportJsonl.js";
import { buildFieldCoverage, buildFieldCoverageMarkdown } from "./fieldCoverage.js";
import {
  assertReadableDirectory,
  assertWritableOutput,
  ensureDir,
  findXmlFiles,
  safeBasename,
  stableCaseId,
  writeJson
} from "./fileUtils.js";
import { loadCaseRepairOverlays } from "./caseRepairs.js";
import { loadLocalFieldMappings } from "./localMapping.js";
import { buildManifest, buildWarningReport } from "./manifest.js";
import { normalizeParsedXml } from "./normalize.js";
import { parseXml } from "./parseXml.js";
import { redactCase } from "./redact.js";
import { writeReviewPackets } from "./reviewPackets.js";
import { buildSummaryMarkdown } from "./summary.js";
import { splitTrainEval } from "./splitTrainEval.js";
import type {
  AdjustedPriceConflictPolicy,
  CliOptions,
  NormalizedAppraisalCase,
  RejectedFile,
  TargetTier,
  TrainingCase
} from "./types.js";
import { validateNormalizedCase } from "./validate.js";
import { writeFile } from "node:fs/promises";

async function main(): Promise<void> {
  try {
    const options = parseArgs(process.argv.slice(2));
    await runCli(options);
  } catch (error) {
    console.error(`appraisal-training-data failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

export async function runCli(options: CliOptions): Promise<void> {
  const targetTier = options.targetTier ?? "overall";
  const adjustedPriceConflictPolicy =
    options.adjustedPriceConflictPolicy ?? DEFAULT_ADJUSTED_PRICE_CONFLICT_POLICY;
  if (!options.redact && !options.allowUnredactedOutput) {
    throw new Error("Refusing unredacted output. Pass --allow-unredacted-output with --redact false to confirm.");
  }

  await assertReadableDirectory(options.input);
  await assertWritableOutput(options.output);
  await ensureOutputFolders(options.output);

  const xmlFiles = await findXmlFiles(options.input);
  if (xmlFiles.length === 0) {
    throw new Error(`Zero XML files found in input folder: ${options.input}`);
  }

  const normalizedCases: NormalizedAppraisalCase[] = [];
  const trainingCases: TrainingCase[] = [];
  const reviewPairs: Array<{ normalizedCase: NormalizedAppraisalCase; trainingCase: TrainingCase }> = [];
  const rejectedFiles: RejectedFile[] = [];
  let parsedCount = 0;
  const previousCoverage = await readPreviousCoverage(path.join(options.output, "reports", "field_coverage.json"));
  const localFieldMappings = await loadLocalFieldMappings(options.mapping);
  const repairOverlays = await loadCaseRepairOverlays(options.repairs);

  console.log(`Found ${xmlFiles.length} XML file(s). Redaction enabled: ${options.redact}`);
  if (localFieldMappings.length > 0) {
    console.log(`Loaded ${localFieldMappings.length} verified local field mapping(s).`);
    console.log(`Adjusted sale price conflict policy: ${adjustedPriceConflictPolicy}`);
  }
  if (repairOverlays.size > 0) {
    console.log(`Loaded ${repairOverlays.size} case repair overlay(s).`);
  }
  if (options.redact && isUnderPrivateFolder(options.input)) {
    console.log("Processing private local XMLs. Do not commit input or generated output files. Redaction is enabled.");
  }

  for (const [index, xmlPath] of xmlFiles.entries()) {
    const filename = safeBasename(xmlPath);
    console.log(`Processing ${index + 1}/${xmlFiles.length}`);

    try {
      const xmlContent = await readFile(xmlPath, "utf8");
      const parsed = parseXml(xmlContent);
      parsedCount += 1;

      const normalized = validateNormalizedCase(
        redactCase(
          normalizeParsedXml(parsed, xmlPath, new Date(), {
            localFieldMappings,
            adjustedPriceConflictPolicy,
            caseRepair: repairOverlays.get(stableCaseId(xmlPath)) ?? null
          }),
          options.redact
        )
      );
      normalizedCases.push(normalized);

      await writeJson(path.join(options.output, "normalized", `${normalized.case_id}.json`), normalized);

      if (normalized.quality_flags.status !== "rejected") {
        const trainingCase = buildTrainingCase(normalized, targetTier);
        trainingCases.push(trainingCase);
        reviewPairs.push({ normalizedCase: normalized, trainingCase });
        await writeJson(path.join(options.output, "training_cases", `${trainingCase.case_id}.json`), trainingCase);
      }
    } catch (error) {
      rejectedFiles.push({
        filename,
        reason: error instanceof Error ? error.message : String(error)
      });
      console.warn(`Warning: file ${index + 1}/${xmlFiles.length} could not be processed; continuing.`);
    }
  }

  const exportableCases = trainingCases.filter((trainingCase) => {
    if (targetTier !== "overall") return trainingCase.quality.status === "candidate";
    if (trainingCase.quality.status === "candidate") return true;
    return options.includeNeedsReview && trainingCase.quality.status === "needs_review";
  });
  const split = splitTrainEval(exportableCases, options.evalRatio, options.seed);

  await exportJsonl(path.join(options.output, "exports", "candidate_train.jsonl"), split.train);
  await exportJsonl(path.join(options.output, "exports", "candidate_eval.jsonl"), split.eval);
  await exportJsonl(path.join(options.output, "exports", "candidate_all.jsonl"), exportableCases);
  if (options.emitReviewPackets) {
    await writeReviewPackets(options.output, reviewPairs);
  }

  const manifest = buildManifest({
    inputFolder: options.input,
    outputFolder: options.output,
    redactionEnabled: options.redact,
    evalRatio: options.evalRatio,
    seed: options.seed,
    xmlFilesFound: xmlFiles.length,
    parsed: parsedCount,
    normalizedCases,
    rejectedFiles,
    trainCases: split.train,
    evalCases: split.eval,
    targetTier,
    adjustedPriceConflictPolicy
  });

  await writeJson(path.join(options.output, "reports", "manifest.json"), manifest);
  await writeJson(path.join(options.output, "reports", "warnings.json"), buildWarningReport(normalizedCases));
  const fieldCoverage = buildFieldCoverage(normalizedCases, previousCoverage);
  await writeJson(path.join(options.output, "reports", "field_coverage.json"), fieldCoverage);
  await writeFile(path.join(options.output, "reports", "field_coverage.md"), buildFieldCoverageMarkdown(fieldCoverage), "utf8");
  await writeFile(
    path.join(options.output, "reports", "summary.md"),
    buildSummaryMarkdown({
      manifest,
      command: `npm run appraisal:training-data -- ${process.argv.slice(2).join(" ")}`
    }),
    "utf8"
  );

  console.log("");
  console.log("Appraisal training data prep complete.");
  console.log(`Parsed: ${manifest.counts.parsed}/${manifest.counts.xml_files_found}`);
  console.log(`Candidate: ${manifest.counts.candidate}`);
  console.log(`Needs review: ${manifest.counts.needs_review}`);
  console.log(`Rejected: ${manifest.counts.rejected}`);
  console.log(`Train lines: ${manifest.counts.train_lines}`);
  console.log(`Eval lines: ${manifest.counts.eval_lines}`);
  console.log(`Summary: ${path.join(options.output, "reports", "summary.md")}`);
}

export function parseArgs(args: string[]): CliOptions {
  const values = new Map<string, string | boolean>();

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) continue;
    const withoutPrefix = arg.slice(2);
    const [rawKey, inlineValue] = withoutPrefix.split("=", 2);
    const key = rawKey.trim();
    const next = args[index + 1];

    if (inlineValue !== undefined) {
      values.set(key, inlineValue);
    } else if (next && !next.startsWith("--")) {
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

  return {
    input,
    output,
    evalRatio: numberArg(values, "eval-ratio", 0.2),
    seed: numberArg(values, "seed", 42),
    redact: booleanArg(values, "redact", true),
    includeNeedsReview: booleanArg(values, "include-needs-review", false),
    allowUnredactedOutput: booleanArg(values, "allow-unredacted-output", false),
    emitReviewPackets: booleanArg(values, "emit-review-packets", false),
    mapping: stringArg(values, "mapping"),
    repairs: stringArg(values, "repairs"),
    targetTier: targetTierArg(values, "target-tier", "overall"),
    adjustedPriceConflictPolicy: adjustedPriceConflictPolicyArg(values, "adjusted-price-conflict-policy")
  };
}

async function ensureOutputFolders(output: string): Promise<void> {
  await Promise.all([
    ensureDir(path.join(output, "normalized")),
    ensureDir(path.join(output, "training_cases")),
    ensureDir(path.join(output, "exports")),
    ensureDir(path.join(output, "reports"))
  ]);
}

function stringArg(values: Map<string, string | boolean>, key: string): string | null {
  const value = values.get(key);
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function numberArg(values: Map<string, string | boolean>, key: string, fallback: number): number {
  const value = values.get(key);
  if (typeof value !== "string") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function booleanArg(values: Map<string, string | boolean>, key: string, fallback: boolean): boolean {
  const value = values.get(key);
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  if (["true", "1", "yes"].includes(value.toLowerCase())) return true;
  if (["false", "0", "no"].includes(value.toLowerCase())) return false;
  return fallback;
}

function targetTierArg(values: Map<string, string | boolean>, key: string, fallback: TargetTier): TargetTier {
  const value = stringArg(values, key);
  if (!value) return fallback;
  if (["overall", "tier1", "tier2", "tier3"].includes(value)) return value as TargetTier;
  throw new Error(`Invalid --${key}: ${value}. Expected tier1, tier2, tier3, or overall.`);
}

function adjustedPriceConflictPolicyArg(
  values: Map<string, string | boolean>,
  key: string
): AdjustedPriceConflictPolicy | undefined {
  const value = stringArg(values, key);
  if (!value) return undefined;
  if ((adjustedPriceConflictPolicies as readonly string[]).includes(value)) {
    return value as AdjustedPriceConflictPolicy;
  }
  throw new Error(
    `Invalid --${key}: ${value}. Expected ${adjustedPriceConflictPolicies.join(", ")}.`
  );
}

function isUnderPrivateFolder(inputPath: string): boolean {
  const resolved = path.resolve(inputPath);
  return resolved.split(path.sep).includes("private");
}

async function readPreviousCoverage(filePath: string): Promise<Parameters<typeof buildFieldCoverage>[1]> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  void main();
}
