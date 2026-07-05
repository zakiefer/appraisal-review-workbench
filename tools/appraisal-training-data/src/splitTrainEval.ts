import { createHash } from "node:crypto";
import type { TrainingCase } from "./types.js";

export interface TrainEvalSplit {
  train: TrainingCase[];
  eval: TrainingCase[];
}

export function splitTrainEval(cases: TrainingCase[], evalRatio = 0.2, seed = 42): TrainEvalSplit {
  const boundedRatio = Math.min(1, Math.max(0, evalRatio));
  const sorted = [...cases].sort((a, b) => score(a.case_id, seed) - score(b.case_id, seed));
  const evalCount = Math.floor(sorted.length * boundedRatio);
  const evalCases = sorted.slice(0, evalCount);
  const trainCases = sorted.slice(evalCount);
  return { train: trainCases, eval: evalCases };
}

function score(caseId: string, seed: number): number {
  const hash = createHash("sha256").update(`${seed}:${caseId}`).digest("hex").slice(0, 12);
  return Number.parseInt(hash, 16);
}

