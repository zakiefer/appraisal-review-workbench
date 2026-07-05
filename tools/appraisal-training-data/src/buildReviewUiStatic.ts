import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildStaticReviewUiHtml } from "./reviewUi.js";
import type { ReviewUiCase, ReviewUiState } from "./reviewUiData.js";

interface StaticBuildOptions {
  output: string;
}

async function main(): Promise<void> {
  try {
    await runBuildReviewUiStatic(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(`appraisal-review-ui-static failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

export async function runBuildReviewUiStatic(options: StaticBuildOptions): Promise<void> {
  await mkdir(path.dirname(options.output), { recursive: true });
  await writeFile(options.output, buildStaticReviewUiHtml(buildDemoPayload()), "utf8");
  console.log(`Static review UI written to ${options.output}`);
}

function buildDemoPayload() {
  const state = buildDemoState();
  return {
    state,
    workbench: buildDemoWorkbench(state)
  };
}

function buildDemoState(): ReviewUiState {
  const cases = [
    demoCase({
      case_id: "demo_missing_evidence",
      level: "red",
      label: "Likely reject or needs fix",
      reasons: [
        "No selected comparables were extracted.",
        "No final value or reconciliation narrative was extracted."
      ],
      subject: {
        property_type: "Single family",
        address_redacted: "[REDACTED STREET]",
        city: "Exampleville",
        state: "IN",
        gla_sqft: null,
        bedrooms: null,
        bathrooms: null,
        condition: null,
        quality: null
      },
      comps: [],
      finalValue: null,
      narrative: null,
      warnings: [
        "missing_subject_condition",
        "missing_subject_quality",
        "missing_subject_gla",
        "missing_comparables",
        "missing_final_opinion_of_value",
        "reconciliation_narrative_missing"
      ],
      missingFields: [
        "missing_subject_condition",
        "missing_subject_quality",
        "missing_subject_gla",
        "missing_comparables",
        "missing_final_opinion_of_value",
        "reconciliation_narrative_missing"
      ]
    }),
    demoCase({
      case_id: "demo_adjusted_rows",
      level: "yellow",
      label: "Needs attention before approval",
      reasons: ["One adjusted sale price row needs human checking."],
      subject: {
        property_type: "Single family",
        address_redacted: "[REDACTED STREET]",
        city: "Lyonstown",
        state: "IN",
        gla_sqft: 1778,
        bedrooms: 3,
        bathrooms: 2,
        condition: "C4",
        quality: "Q4"
      },
      comps: [
        comp(1, 185000, null, 230420, "local-filled", true, "C4", "Q4", null),
        comp(2, 250000, -19580, 230420, "built-in", false, "C4", "Q4", "2026-02-15"),
        comp(3, 199000, 22152, 221152, "built-in", false, "C3", "Q4", "2026-01-24")
      ],
      finalValue: 222000,
      narrative: "Most weight is placed on the selected sales comparison indicators. The sample narrative is synthetic and contains no private appraisal data.",
      warnings: ["local_mapping_conflict_comparables_adjusted_sale_price"],
      missingFields: []
    }),
    demoCase({
      case_id: "demo_ready_case",
      level: "green",
      label: "Likely approvable",
      reasons: ["Candidate checks passed."],
      subject: {
        property_type: "Single family",
        address_redacted: "[REDACTED STREET]",
        city: "Exampleville",
        state: "IN",
        gla_sqft: 1900,
        bedrooms: 3,
        bathrooms: 2,
        condition: "C3",
        quality: "Q4"
      },
      comps: [
        comp(1, 300000, 5000, 305000, "built-in", false, "C3", "Q4", "2026-03-01"),
        comp(2, 318000, -8000, 310000, "built-in", false, "C4", "Q4", "2026-03-15")
      ],
      finalValue: 307000,
      narrative: "Synthetic grid fixture reconciles selected fake comparable indicators into a supported final value.",
      warnings: [],
      missingFields: []
    })
  ];
  return {
    generated_at: new Date("2026-07-05T00:00:00.000Z").toISOString(),
    cases,
    progress: progress(cases),
    privacy: { email: 0, phone: 0, full_street_address: 0, private_name_label: 0, license_or_private_id: 0 }
  };
}

function demoCase(input: {
  case_id: string;
  level: "green" | "yellow" | "red";
  label: string;
  reasons: string[];
  subject: Record<string, unknown>;
  comps: ReturnType<typeof comp>[];
  finalValue: number | null;
  narrative: string | null;
  warnings: string[];
  missingFields: string[];
}): ReviewUiCase {
  return {
    case_id: input.case_id,
    source_file_id: "demo_synthetic_source",
    decision_status: "unreviewed",
    decision: { status: "unreviewed", reviewer: null, reviewed_at: null, notes: null },
    recommendation: {
      level: input.level,
      label: input.label,
      reasons: input.reasons
    },
    tier: {
      tier1_status: input.level === "green" ? "candidate" : "needs_review",
      tier1_reasons: input.reasons.map((reason) => reason.toLowerCase().replaceAll(" ", "_")),
      tier2_status: "needs_review",
      tier2_reasons: ["demo_selected_comps_only"],
      tier3_status: "needs_review",
      tier3_reasons: ["demo_candidate_pool_unavailable"]
    },
    subject: input.subject as ReviewUiCase["subject"],
    comps: input.comps,
    adjustment_sanity: input.comps.map((item) => ({
      comp_id: item.comp_id,
      comp_index: item.comp_index,
      sale_price: item.sale_price,
      net_adjustment: item.net_adjustment,
      expected_adjusted_sale_price:
        item.sale_price != null && item.net_adjustment != null ? item.sale_price + item.net_adjustment : null,
      adjusted_sale_price: item.adjusted_sale_price,
      badge: item.needs_manual_attention ? "Filled missing" : "Pass"
    })),
    reconciliation: {
      final_opinion_of_value: input.finalValue,
      narrative: input.narrative,
      caveats: [
        "Synthetic GitHub Pages demo only.",
        "Use the local private review UI for real appraisal review decisions."
      ]
    },
    warnings: input.warnings,
    missing_fields: input.missingFields,
    training_example: {
      input_case: {
        metadata: {
          report_type: "Synthetic 1004",
          form_type: "Demo",
          effective_date: "2026-07-05",
          inspection_date: null
        },
        subject: input.subject,
        market: {},
        selected_comparables: input.comps,
        available_context: { note: "Synthetic static demo case." }
      } as unknown as ReviewUiCase["training_example"]["input_case"],
      expert_answer: {
        selected_comp_summary: input.comps,
        adjustment_summary: [],
        reconciliation: {
          final_opinion_of_value: input.finalValue,
          indicated_value_low: null,
          indicated_value_high: null,
          narrative: input.narrative
        },
        caveats: ["Synthetic demo answer."]
      } as ReviewUiCase["training_example"]["expert_answer"]
    },
    privacy: { email: 0, phone: 0, full_street_address: 0, private_name_label: 0, license_or_private_id: 0 },
    final_value_leakage: false
  };
}

function comp(
  compIndex: number,
  salePrice: number | null,
  netAdjustment: number | null,
  adjustedSalePrice: number | null,
  source: ReviewUiCase["comps"][number]["adjusted_price_source"],
  needsManualAttention: boolean,
  condition: string | null,
  quality: string | null,
  saleDate: string | null
): ReviewUiCase["comps"][number] {
  return {
    comp_id: `demo_comp_${compIndex}`,
    comp_index: compIndex,
    sale_price: salePrice,
    net_adjustment: netAdjustment,
    expected_adjusted_sale_price: salePrice != null && netAdjustment != null ? salePrice + netAdjustment : null,
    adjusted_sale_price: adjustedSalePrice,
    adjusted_price_source: source,
    adjusted_price_badge: needsManualAttention ? "Filled missing" : "Pass",
    needs_manual_attention: needsManualAttention,
    condition,
    quality,
    sale_date: saleDate,
    warning_badge: needsManualAttention ? "Needs human check" : "Pass"
  };
}

function progress(cases: ReviewUiCase[]): ReviewUiState["progress"] {
  return {
    total: cases.length,
    reviewed: cases.filter((item) => item.decision_status !== "unreviewed").length,
    approved: cases.filter((item) => item.decision_status === "approved").length,
    needs_revision: cases.filter((item) => item.decision_status === "needs_revision").length,
    rejected: cases.filter((item) => item.decision_status === "rejected").length,
    skipped: cases.filter((item) => item.decision_status === "skipped").length,
    unreviewed: cases.filter((item) => item.decision_status === "unreviewed").length,
    green: cases.filter((item) => item.recommendation.level === "green").length,
    yellow: cases.filter((item) => item.recommendation.level === "yellow").length,
    red: cases.filter((item) => item.recommendation.level === "red").length,
    adjusted_price_rows_needing_attention: cases.reduce(
      (sum, item) => sum + item.comps.filter((demoComp) => demoComp.needs_manual_attention).length,
      0
    )
  };
}

function buildDemoWorkbench(state: ReviewUiState) {
  return {
    generated_at: state.generated_at,
    stages: [
      { id: "overview", label: "Overview", status: "ready", detail: "Static demo loaded." },
      { id: "intake", label: "Import", status: "ready", detail: "Synthetic cases only." },
      { id: "mapping", label: "Mapping", status: "ready", detail: "Demo mappings verified." },
      { id: "review", label: "Tier Review", status: "attention", detail: "Try the approval worksheet." },
      { id: "repairs", label: "Repairs", status: "attention", detail: "Demo red/yellow cases available." },
      { id: "export", label: "Export", status: "blocked", detail: "Local private export only." },
      { id: "audit", label: "Audit", status: "ready", detail: "No private values in static demo." }
    ],
    intake: {
      xml_files_found: 3,
      parsed: 3,
      parse_failures: 0,
      inspection_grid_rows: 6,
      safe_value_profile_rows: 12
    },
    mapping: {
      verified_count: 3,
      verified_mappings: [
        {
          field: "subject.condition",
          strategy: "grid_row",
          confidence: "manual_verified",
          path: "SalesComparisonGrid.Row[Condition].Subject",
          notes: "Synthetic demo mapping"
        },
        {
          field: "subject.quality",
          strategy: "grid_row",
          confidence: "manual_verified",
          path: "SalesComparisonGrid.Row[Quality Rating].Subject",
          notes: "Synthetic demo mapping"
        },
        {
          field: "comparables.adjusted_sale_price",
          strategy: "grid_row",
          confidence: "manual_verified",
          path: "SalesComparisonGrid.Row[Adjusted Sale Price]",
          notes: "Synthetic demo mapping"
        }
      ],
      review_targets: [],
      validation: {
        parsed: 3,
        applications: [{ field: "comparables.adjusted_sale_price" }],
        target_coverage: [
          { field: "subject.condition", before_pct: 0, after_pct: 67, delta_pct: 67 },
          { field: "subject.quality", before_pct: 0, after_pct: 67, delta_pct: 67 },
          { field: "comparables.adjusted_sale_price", before_pct: 67, after_pct: 100, delta_pct: 33 }
        ]
      }
    },
    repairs: {
      red_cases: 1,
      needs_revision_cases: 0,
      adjusted_attention_rows: 1,
      parser_warning_cases: 2,
      top_blockers: [
        { blocker: "missing selected comparables", count: 1 },
        { blocker: "adjusted sale price needs review", count: 1 }
      ]
    },
    export: { train_lines: 0, eval_lines: 0, all_lines: 0 },
    audit: {
      privacy_total: 0,
      final_value_leakage_cases: 0,
      raw_xml_included: false,
      privacy_sources: [{ name: "Static demo data", total: 0 }],
      conflict_summary: { adjusted_rows_needing_attention: 1 }
    },
    pipeline: {
      redaction_enabled: true,
      adjusted_price_conflict_stats: { policy: "static_demo" },
      warnings_by_type: [{ warning: "synthetic_demo_warning", count: 1 }]
    },
    review: { decision_file: "Browser localStorage in static demo" },
    paths: {
      input_folder: "Synthetic demo data",
      training_output: "Local private output only",
      review_batch: "Local private review batch only",
      session_output: "Browser localStorage in static demo",
      mapping_file: "Synthetic demo mappings",
      inspection_output: "Synthetic demo inspection",
      review_packets: "Synthetic demo packets",
      approved_export: "Local private export only"
    }
  };
}

function parseArgs(args: string[]): StaticBuildOptions {
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
  const output = values.get("output");
  return {
    output: typeof output === "string" && output.trim().length > 0 ? output : "docs/index.html"
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  void main();
}
