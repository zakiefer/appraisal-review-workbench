import { fileURLToPath } from "node:url";
import path from "node:path";
import { assertReadableDirectory, assertWritableOutput, ensureDir } from "./fileUtils.js";
import {
  assertPrivateOutput,
  buildReviewCaseArtifacts,
  loadAdjustedPriceAuditDetails,
  loadReviewPackets,
  writeReviewArtifacts
} from "./reviewWorkflow.js";

interface PrepareReviewBatchOptions {
  reviewPackets: string;
  conflictAudit: string;
  output: string;
}

async function main(): Promise<void> {
  try {
    await runPrepareReviewBatch(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(`appraisal-prepare-review-batch failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

export async function runPrepareReviewBatch(options: PrepareReviewBatchOptions): Promise<void> {
  await assertReadableDirectory(options.reviewPackets);
  await assertReadableDirectory(options.conflictAudit);
  assertPrivateOutput(options.output, "Review batch");
  await assertWritableOutput(options.output);
  await ensureDir(options.output);

  const packets = await loadReviewPackets(options.reviewPackets);
  const auditDetails = await loadAdjustedPriceAuditDetails(options.conflictAudit);
  const artifacts = packets.map((packet) => buildReviewCaseArtifacts(packet, auditDetails));

  await writeReviewArtifacts(options.output, artifacts);

  const manualReviewRows = artifacts.reduce(
    (sum, item) => sum + item.adjusted_sale_price_review.manual_review_rows,
    0
  );
  console.log(`Review batch prepared. Cases: ${artifacts.length}.`);
  console.log(`Adjusted sale price rows needing review: ${manualReviewRows}.`);
  console.log(`Output: ${options.output}`);
}

function parseArgs(args: string[]): PrepareReviewBatchOptions {
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
  const reviewPackets = stringArg(values, "review-packets");
  const conflictAudit = stringArg(values, "conflict-audit");
  const output = stringArg(values, "output");
  if (!reviewPackets) throw new Error("Missing required --review-packets folder");
  if (!conflictAudit) throw new Error("Missing required --conflict-audit folder");
  if (!output) throw new Error("Missing required --output folder");
  return { reviewPackets, conflictAudit, output };
}

function stringArg(values: Map<string, string | boolean>, key: string): string | null {
  const value = values.get(key);
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  void main();
}
