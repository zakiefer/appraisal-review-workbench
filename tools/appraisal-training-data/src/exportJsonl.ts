import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { JsonlTrainingLine, TrainingCase } from "./types.js";
import { ensureDir } from "./fileUtils.js";

const SYSTEM_PROMPT =
  "You are an appraisal assistant. Use conservative residential valuation logic. Do not invent missing data. Flag missing or unreliable information. Explain selected comparables, adjustments, reconciliation, and caveats. Provide USPAP-aware assistance, but do not claim to replace a licensed appraiser.";

export function toJsonlTrainingLine(trainingCase: TrainingCase): JsonlTrainingLine {
  return {
    messages: [
      {
        role: "system",
        content: SYSTEM_PROMPT
      },
      {
        role: "user",
        content: `Analyze this XML-derived appraisal case. Explain the selected comparables, adjustment logic, reconciliation, and caveats. Return valid JSON.\n\nINPUT_CASE:\n${JSON.stringify(
          trainingCase.input_case,
          null,
          2
        )}`
      },
      {
        role: "assistant",
        content: JSON.stringify(trainingCase.expert_answer, null, 2)
      }
    ],
    metadata: {
      case_id: trainingCase.case_id,
      task: trainingCase.task,
      quality_status: trainingCase.quality.status,
      target_tier: trainingCase.quality.target_tier,
      tier_status: trainingCase.quality.tier_status
    }
  };
}

export async function exportJsonl(filePath: string, cases: TrainingCase[]): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const lines = cases.map((trainingCase) => JSON.stringify(toJsonlTrainingLine(trainingCase))).join("\n");
  await writeFile(filePath, lines.length > 0 ? `${lines}\n` : "", "utf8");
}
