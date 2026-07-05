import path from "node:path";
import type { Manifest } from "./types.js";

export interface BuildSummaryInput {
  manifest: Manifest;
  command: string;
}

export function buildSummaryMarkdown(input: BuildSummaryInput): string {
  const { manifest, command } = input;
  const topWarnings = Object.entries(manifest.warnings_by_type)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10);

  return `# Appraisal Training Data Run Summary

Created at: ${manifest.created_at}
Parser version: ${manifest.parser_version}
Selected target tier for export: ${manifest.target_tier}
Adjusted price conflict policy: ${manifest.adjusted_price_conflict_policy}

## Command

\`\`\`bash
${command}
\`\`\`

## Counts

| Metric | Count |
| --- | ---: |
| XML files found | ${manifest.counts.xml_files_found} |
| Parsed | ${manifest.counts.parsed} |
| Normalized | ${manifest.counts.normalized} |
| Candidate | ${manifest.counts.candidate} |
| Needs review | ${manifest.counts.needs_review} |
| Rejected | ${manifest.counts.rejected} |
| Tier 1 candidate count | ${manifest.tier_counts.tier_1_reconciliation_explanation.candidate} |
| Train JSONL lines | ${manifest.counts.train_lines} |
| Eval JSONL lines | ${manifest.counts.eval_lines} |
| Selected target-tier JSONL lines | ${manifest.counts.train_lines + manifest.counts.eval_lines} |

## Adjusted Sale Price Conflict Policy

Tolerance: $${manifest.adjusted_price_conflict_stats.tolerance_dollars}

| Metric | Count |
| --- | ---: |
| Comparable rows checked | ${manifest.adjusted_price_conflict_stats.comparable_rows_checked} |
| Arithmetic checks available | ${manifest.adjusted_price_conflict_stats.arithmetic_checks_available} |
| Conflicts | ${manifest.adjusted_price_conflict_stats.conflicts_count} |
| Conflicts resolved by local | ${manifest.adjusted_price_conflict_stats.conflicts_resolved_by_local} |
| Conflicts resolved by built-in | ${manifest.adjusted_price_conflict_stats.conflicts_resolved_by_builtin} |
| Conflicts resolved by arithmetic | ${manifest.adjusted_price_conflict_stats.conflicts_resolved_by_arithmetic} |
| Unresolved conflicts | ${manifest.adjusted_price_conflict_stats.conflicts_unresolved} |
| Local mapping filled missing adjusted prices | ${manifest.adjusted_price_conflict_stats.local_mapping_filled_missing_count} |
| Possible index misalignment | ${manifest.adjusted_price_conflict_stats.possible_index_misalignment_count} |

## Tier Counts

| Tier | Candidate | Needs Review | Rejected |
| --- | ---: | ---: | ---: |
| Tier 1 reconciliation explanation | ${manifest.tier_counts.tier_1_reconciliation_explanation.candidate} | ${manifest.tier_counts.tier_1_reconciliation_explanation.needs_review} | ${manifest.tier_counts.tier_1_reconciliation_explanation.rejected} |
| Tier 2 sales comparison analysis | ${manifest.tier_counts.tier_2_sales_comparison_analysis.candidate} | ${manifest.tier_counts.tier_2_sales_comparison_analysis.needs_review} | ${manifest.tier_counts.tier_2_sales_comparison_analysis.rejected} |
| Tier 3 comp selection | ${manifest.tier_counts.tier_3_comp_selection.candidate} | ${manifest.tier_counts.tier_3_comp_selection.needs_review} | ${manifest.tier_counts.tier_3_comp_selection.rejected} |

## Top Warnings

${topWarnings.length > 0 ? topWarnings.map(([warning, count]) => `- ${warning}: ${count}`).join("\n") : "- None"}

## Rejected Files

${
  manifest.rejected_files.length > 0
    ? manifest.rejected_files.map((file) => `- ${file.filename}: ${file.reason}`).join("\n")
    : "- None"
}

## Output Files

- Normalized cases: ${path.join(manifest.output_folder, "normalized")}
- Training cases: ${path.join(manifest.output_folder, "training_cases")}
- Candidate train JSONL: ${path.join(manifest.output_folder, "exports", "candidate_train.jsonl")}
- Candidate eval JSONL: ${path.join(manifest.output_folder, "exports", "candidate_eval.jsonl")}
- Candidate all JSONL: ${path.join(manifest.output_folder, "exports", "candidate_all.jsonl")}
- Manifest: ${path.join(manifest.output_folder, "reports", "manifest.json")}
- Warnings: ${path.join(manifest.output_folder, "reports", "warnings.json")}
- Field coverage JSON: ${path.join(manifest.output_folder, "reports", "field_coverage.json")}
- Field coverage summary: ${path.join(manifest.output_folder, "reports", "field_coverage.md")}

## Next Steps

- Review every candidate and needs_review case with a qualified appraiser before fine-tuning or eval use.
- Add XML mappings for any real vendor tags that land in warnings as missing fields.
- Confirm redaction results before sharing artifacts outside the local machine.
- Keep real XML inputs and generated private outputs out of git.

Candidate JSONL requires human/appraiser review before fine-tuning. This pipeline prepares local data only; it does not train, deploy, or replace licensed appraisal judgment.
`;
}
