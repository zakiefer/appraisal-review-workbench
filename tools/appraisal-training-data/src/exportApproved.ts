import { readdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { exportJsonl } from "./exportJsonl.js";
import { assertReadableDirectory, assertWritableOutput, ensureDir, writeJson } from "./fileUtils.js";
import { splitTrainEval } from "./splitTrainEval.js";
import type { TrainingCase } from "./types.js";
import type { ReviewPacket } from "./reviewPackets.js";

interface ApprovedExportOptions {
  reviewed: string;
  output: string;
  evalRatio: number;
  seed: number;
}

interface ApprovedManifest {
  created_at: string;
  reviewed_folder: string;
  output_folder: string;
  eval_ratio: number;
  seed: number;
  counts: {
    review_files_found: number;
    approved_cases: number;
    train_lines: number;
    eval_lines: number;
  };
}

async function main(): Promise<void> {
  try {
    await runApprovedExport(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(`appraisal-export-approved failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

export async function runApprovedExport(options: ApprovedExportOptions): Promise<void> {
  await assertReadableDirectory(options.reviewed);
  await assertWritableOutput(options.output);
  await ensureDir(path.join(options.output, "exports"));
  await ensureDir(path.join(options.output, "reports"));

  const reviewFiles = await findReviewFiles(options.reviewed);
  const approvedCases: TrainingCase[] = [];

  for (const reviewFile of reviewFiles) {
    try {
      const packet = JSON.parse(await readFile(reviewFile, "utf8")) as ReviewPacket;
      if (packet.reviewer_decision?.status === "approved" && packet.proposed_training_case) {
        approvedCases.push(packet.proposed_training_case);
      }
    } catch {
      // Skip malformed review files; the manifest count still shows how many files were scanned.
    }
  }

  const split = splitTrainEval(approvedCases, options.evalRatio, options.seed);
  await exportJsonl(path.join(options.output, "exports", "train.jsonl"), split.train);
  await exportJsonl(path.join(options.output, "exports", "eval.jsonl"), split.eval);
  await exportJsonl(path.join(options.output, "exports", "all.jsonl"), approvedCases);

  const manifest: ApprovedManifest = {
    created_at: new Date().toISOString(),
    reviewed_folder: path.resolve(options.reviewed),
    output_folder: path.resolve(options.output),
    eval_ratio: options.evalRatio,
    seed: options.seed,
    counts: {
      review_files_found: reviewFiles.length,
      approved_cases: approvedCases.length,
      train_lines: split.train.length,
      eval_lines: split.eval.length
    }
  };

  await writeJson(path.join(options.output, "reports", "approved_manifest.json"), manifest);
  await writeFile(path.join(options.output, "reports", "approved_summary.md"), buildSummary(manifest), "utf8");

  if (approvedCases.length === 0) {
    console.log("No approved review packets found. Empty approved export files were written.");
  } else {
    console.log(`Approved export complete. Approved cases: ${approvedCases.length}`);
  }
}

async function findReviewFiles(folder: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (entry.isFile() && entry.name.endsWith(".json")) {
        files.push(entryPath);
      }
    }
  }

  await walk(folder);
  return files.sort((a, b) => a.localeCompare(b));
}

function buildSummary(manifest: ApprovedManifest): string {
  return `# Approved Training Export

Created at: ${manifest.created_at}

Only review packets with \`reviewer_decision.status === "approved"\` are included.

| Metric | Count |
| --- | ---: |
| Review files found | ${manifest.counts.review_files_found} |
| Approved cases | ${manifest.counts.approved_cases} |
| Train lines | ${manifest.counts.train_lines} |
| Eval lines | ${manifest.counts.eval_lines} |

Approved exports:

- ${path.join(manifest.output_folder, "exports", "train.jsonl")}
- ${path.join(manifest.output_folder, "exports", "eval.jsonl")}
- ${path.join(manifest.output_folder, "exports", "all.jsonl")}
`;
}

function parseArgs(args: string[]): ApprovedExportOptions {
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

  const reviewed = valueAsString(values.get("reviewed"));
  const output = valueAsString(values.get("output"));
  if (!reviewed) throw new Error("Missing required --reviewed folder");
  if (!output) throw new Error("Missing required --output folder");

  return {
    reviewed,
    output,
    evalRatio: numberArg(values, "eval-ratio", 0.2),
    seed: numberArg(values, "seed", 42)
  };
}

function valueAsString(value: string | boolean | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function numberArg(values: Map<string, string | boolean>, key: string, fallback: number): number {
  const value = values.get(key);
  if (typeof value !== "string") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  void main();
}

