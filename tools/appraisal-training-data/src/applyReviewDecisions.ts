import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { assertReadableDirectory, assertWritableOutput, ensureDir, writeJson } from "./fileUtils.js";
import type { ReviewPacket } from "./reviewPackets.js";
import {
  assertPrivateOutput,
  loadReviewPackets,
  parseDecisionCsv,
  type DecisionRow
} from "./reviewWorkflow.js";

interface ApplyReviewDecisionsOptions {
  reviewPackets: string;
  decisions: string;
  output: string;
}

interface ApplyReviewManifest {
  created_at: string;
  review_packets_folder: string;
  decisions_file: string;
  output_folder: string;
  counts: {
    review_packets_found: number;
    decisions_found: number;
    approved: number;
    needs_revision: number;
    rejected: number;
    unreviewed: number;
    written_packets: number;
  };
}

async function main(): Promise<void> {
  try {
    await runApplyReviewDecisions(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(`appraisal-apply-review-decisions failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

export async function runApplyReviewDecisions(options: ApplyReviewDecisionsOptions): Promise<void> {
  await assertReadableDirectory(options.reviewPackets);
  assertPrivateOutput(options.output, "Reviewed packet output");
  await assertWritableOutput(options.output);
  await ensureDir(path.join(options.output, "packets"));

  const packets = await loadReviewPackets(options.reviewPackets);
  const decisions = parseDecisionCsv(await readFile(options.decisions, "utf8"));
  const decisionByCaseId = new Map(decisions.map((decision) => [decision.case_id, decision]));

  let approved = 0;
  let needsRevision = 0;
  let rejected = 0;
  let unreviewed = 0;

  await Promise.all(
    packets.map(async (packet) => {
      const decision = decisionByCaseId.get(packet.case_id);
      const reviewedPacket = applyDecision(packet, decision);
      if (!decision) unreviewed += 1;
      else if (decision.status === "approved") approved += 1;
      else if (decision.status === "needs_revision") needsRevision += 1;
      else if (decision.status === "rejected") rejected += 1;
      await writeJson(path.join(options.output, "packets", `${packet.case_id}.review.json`), reviewedPacket);
    })
  );

  const manifest: ApplyReviewManifest = {
    created_at: new Date().toISOString(),
    review_packets_folder: path.resolve(options.reviewPackets),
    decisions_file: path.resolve(options.decisions),
    output_folder: path.resolve(options.output),
    counts: {
      review_packets_found: packets.length,
      decisions_found: decisions.length,
      approved,
      needs_revision: needsRevision,
      rejected,
      unreviewed,
      written_packets: packets.length
    }
  };

  await writeJson(path.join(options.output, "review_apply_manifest.json"), manifest);
  await writeFile(path.join(options.output, "review_apply_summary.md"), buildApplySummary(manifest), "utf8");

  console.log(`Review decisions applied. Approved: ${approved}. Needs revision: ${needsRevision}. Rejected: ${rejected}. Unreviewed: ${unreviewed}.`);
  console.log(`Output: ${options.output}`);
}

function applyDecision(packet: ReviewPacket, decision: DecisionRow | undefined): ReviewPacket {
  const copy = structuredClone(packet);
  if (!decision) {
    copy.reviewer_decision = {
      status: "unreviewed",
      reviewer: null,
      reviewed_at: null,
      notes: null
    };
    return copy;
  }
  copy.reviewer_decision = {
    status: decision.status,
    reviewer: decision.reviewer,
    reviewed_at: decision.reviewed_at,
    notes: decision.notes
  };
  return copy;
}

function buildApplySummary(manifest: ApplyReviewManifest): string {
  return `# Review Decision Apply Summary

Created at: ${manifest.created_at}

Original review packet folder was not modified.

| Metric | Count |
| --- | ---: |
| Review packets found | ${manifest.counts.review_packets_found} |
| Decisions found | ${manifest.counts.decisions_found} |
| Approved | ${manifest.counts.approved} |
| Needs revision | ${manifest.counts.needs_revision} |
| Rejected | ${manifest.counts.rejected} |
| Unreviewed | ${manifest.counts.unreviewed} |
| Written packets | ${manifest.counts.written_packets} |

Reviewed packets:

- ${path.join(manifest.output_folder, "packets")}
`;
}

function parseArgs(args: string[]): ApplyReviewDecisionsOptions {
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
  const decisions = stringArg(values, "decisions");
  const output = stringArg(values, "output");
  if (!reviewPackets) throw new Error("Missing required --review-packets folder");
  if (!decisions) throw new Error("Missing required --decisions file");
  if (!output) throw new Error("Missing required --output folder");
  return { reviewPackets, decisions, output };
}

function stringArg(values: Map<string, string | boolean>, key: string): string | null {
  const value = values.get(key);
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  void main();
}
