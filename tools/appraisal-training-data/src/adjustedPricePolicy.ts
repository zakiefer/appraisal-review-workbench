import type {
  AdjustedPriceConflictPolicy,
  AdjustedPriceConflictStats,
  ComparableAdjustment,
  ComparableSale
} from "./types.js";

export const ADJUSTED_PRICE_TOLERANCE_DOLLARS = 5;
export const DEFAULT_ADJUSTED_PRICE_CONFLICT_POLICY: AdjustedPriceConflictPolicy = "arithmetic_resolver";
export const adjustedPriceConflictPolicies = [
  "audit_only",
  "local_override",
  "builtin_wins",
  "arithmetic_resolver",
  "disable_local"
] as const satisfies readonly AdjustedPriceConflictPolicy[];

export type AdjustedPriceClassification =
  | "local_matches_arithmetic"
  | "builtin_matches_arithmetic"
  | "both_match_arithmetic"
  | "neither_matches_arithmetic"
  | "local_filled_missing_builtin"
  | "no_arithmetic_check_available"
  | "possible_index_misalignment"
  | "unresolved_needs_manual_review";

export type ArithmeticSource = "net_adjustment" | "individual_adjustment_sum" | null;

export interface ArithmeticAdjustedPriceResult {
  value: number | null;
  source: ArithmeticSource;
  sum_of_adjustment_amounts: number | null;
}

export interface AdjustedPriceRowClassification {
  classification: AdjustedPriceClassification;
  classifications: AdjustedPriceClassification[];
  arithmetic_adjusted_sale_price: number | null;
  arithmetic_source: ArithmeticSource;
  sum_of_adjustment_amounts: number | null;
  built_in_difference_to_arithmetic: number | null;
  local_difference_to_arithmetic: number | null;
  built_in_matches_arithmetic: boolean;
  local_matches_arithmetic: boolean;
  possible_index_misalignment: boolean;
  matched_neighbor_offset: -1 | 1 | null;
}

export interface ResolveAdjustedPriceInput {
  policy: AdjustedPriceConflictPolicy;
  comparable: ComparableSale;
  localValue: number | null;
  compIndex: number;
  arithmeticValuesByIndex?: Array<number | null>;
  tolerance?: number;
}

export interface ResolveAdjustedPriceResult {
  value: number | null;
  parserNotes: string[];
  warnings: string[];
  stats: AdjustedPriceConflictStats;
  classification: AdjustedPriceRowClassification;
  conflict: boolean;
  filledMissing: boolean;
  selectedSource: "local" | "builtin" | "none";
}

export function emptyAdjustedPriceConflictStats(
  policy: AdjustedPriceConflictPolicy = DEFAULT_ADJUSTED_PRICE_CONFLICT_POLICY
): AdjustedPriceConflictStats {
  return {
    policy,
    tolerance_dollars: ADJUSTED_PRICE_TOLERANCE_DOLLARS,
    comparable_rows_checked: 0,
    arithmetic_checks_available: 0,
    conflicts_count: 0,
    conflicts_resolved_by_local: 0,
    conflicts_resolved_by_builtin: 0,
    conflicts_resolved_by_arithmetic: 0,
    conflicts_unresolved: 0,
    local_mapping_filled_missing_count: 0,
    local_mapping_disabled_count: 0,
    possible_index_misalignment_count: 0
  };
}

export function mergeAdjustedPriceConflictStats(
  stats: AdjustedPriceConflictStats[],
  policy: AdjustedPriceConflictPolicy = stats[0]?.policy ?? DEFAULT_ADJUSTED_PRICE_CONFLICT_POLICY
): AdjustedPriceConflictStats {
  const merged = emptyAdjustedPriceConflictStats(policy);
  for (const item of stats) {
    merged.comparable_rows_checked += item.comparable_rows_checked;
    merged.arithmetic_checks_available += item.arithmetic_checks_available;
    merged.conflicts_count += item.conflicts_count;
    merged.conflicts_resolved_by_local += item.conflicts_resolved_by_local;
    merged.conflicts_resolved_by_builtin += item.conflicts_resolved_by_builtin;
    merged.conflicts_resolved_by_arithmetic += item.conflicts_resolved_by_arithmetic;
    merged.conflicts_unresolved += item.conflicts_unresolved;
    merged.local_mapping_filled_missing_count += item.local_mapping_filled_missing_count;
    merged.local_mapping_disabled_count += item.local_mapping_disabled_count;
    merged.possible_index_misalignment_count += item.possible_index_misalignment_count;
  }
  return merged;
}

export function sumAdjustmentAmounts(adjustments: ComparableAdjustment[]): number | null {
  let sawAmount = false;
  let sum = 0;
  for (const adjustment of adjustments) {
    if (adjustment.amount == null) continue;
    sawAmount = true;
    sum += adjustment.amount;
  }
  return sawAmount ? sum : null;
}

export function arithmeticAdjustedSalePrice(comparable: ComparableSale): ArithmeticAdjustedPriceResult {
  const sumOfAdjustments = sumAdjustmentAmounts(comparable.adjustments);
  if (comparable.sale_price == null) {
    return {
      value: null,
      source: null,
      sum_of_adjustment_amounts: sumOfAdjustments
    };
  }

  if (comparable.net_adjustment != null) {
    return {
      value: comparable.sale_price + comparable.net_adjustment,
      source: "net_adjustment",
      sum_of_adjustment_amounts: sumOfAdjustments
    };
  }

  if (sumOfAdjustments != null) {
    return {
      value: comparable.sale_price + sumOfAdjustments,
      source: "individual_adjustment_sum",
      sum_of_adjustment_amounts: sumOfAdjustments
    };
  }

  return {
    value: null,
    source: null,
    sum_of_adjustment_amounts: null
  };
}

export function valuesMatchWithinTolerance(
  left: number | null | undefined,
  right: number | null | undefined,
  tolerance = ADJUSTED_PRICE_TOLERANCE_DOLLARS
): boolean {
  if (left == null || right == null) return false;
  return Math.abs(left - right) <= tolerance;
}

export function classifyAdjustedPriceRow(input: {
  comparable: ComparableSale;
  builtInValue: number | null;
  localValue: number | null;
  compIndex: number;
  arithmeticValuesByIndex?: Array<number | null>;
  tolerance?: number;
}): AdjustedPriceRowClassification {
  const tolerance = input.tolerance ?? ADJUSTED_PRICE_TOLERANCE_DOLLARS;
  const arithmetic = arithmeticAdjustedSalePrice(input.comparable);
  const arithmeticValue = arithmetic.value;
  const builtInMatches = valuesMatchWithinTolerance(input.builtInValue, arithmeticValue, tolerance);
  const localMatches = valuesMatchWithinTolerance(input.localValue, arithmeticValue, tolerance);
  const builtInDifference =
    input.builtInValue != null && arithmeticValue != null ? input.builtInValue - arithmeticValue : null;
  const localDifference = input.localValue != null && arithmeticValue != null ? input.localValue - arithmeticValue : null;
  const matchedNeighborOffset = findNeighborArithmeticMatch(
    input.localValue,
    input.compIndex,
    input.arithmeticValuesByIndex,
    tolerance
  );
  const possibleIndexMisalignment =
    input.localValue != null &&
    arithmeticValue != null &&
    !localMatches &&
    matchedNeighborOffset != null;

  const classifications: AdjustedPriceClassification[] = [];
  if (arithmeticValue == null) {
    classifications.push("no_arithmetic_check_available");
  } else {
    if (builtInMatches && localMatches) classifications.push("both_match_arithmetic");
    if (builtInMatches) classifications.push("builtin_matches_arithmetic");
    if (localMatches) classifications.push("local_matches_arithmetic");
    if (!builtInMatches && !localMatches) classifications.push("neither_matches_arithmetic");
  }
  if (input.builtInValue == null && input.localValue != null) classifications.push("local_filled_missing_builtin");
  if (possibleIndexMisalignment) classifications.push("possible_index_misalignment");
  if (
    input.builtInValue != null &&
    input.localValue != null &&
    !valuesMatchWithinTolerance(input.builtInValue, input.localValue, tolerance) &&
    (arithmeticValue == null || (!builtInMatches && !localMatches))
  ) {
    classifications.push("unresolved_needs_manual_review");
  }

  if (classifications.length === 0 && input.builtInValue == null && input.localValue == null) {
    classifications.push("no_arithmetic_check_available");
  }

  return {
    classification: primaryClassification(classifications),
    classifications: dedupe(classifications),
    arithmetic_adjusted_sale_price: arithmeticValue,
    arithmetic_source: arithmetic.source,
    sum_of_adjustment_amounts: arithmetic.sum_of_adjustment_amounts,
    built_in_difference_to_arithmetic: builtInDifference,
    local_difference_to_arithmetic: localDifference,
    built_in_matches_arithmetic: builtInMatches,
    local_matches_arithmetic: localMatches,
    possible_index_misalignment: possibleIndexMisalignment,
    matched_neighbor_offset: matchedNeighborOffset
  };
}

export function resolveAdjustedPriceConflict(input: ResolveAdjustedPriceInput): ResolveAdjustedPriceResult {
  const policy = input.policy;
  const tolerance = input.tolerance ?? ADJUSTED_PRICE_TOLERANCE_DOLLARS;
  const builtInValue = input.comparable.adjusted_sale_price;
  const classification = classifyAdjustedPriceRow({
    comparable: input.comparable,
    builtInValue,
    localValue: input.localValue,
    compIndex: input.compIndex,
    arithmeticValuesByIndex: input.arithmeticValuesByIndex,
    tolerance
  });
  const stats = emptyAdjustedPriceConflictStats(policy);
  stats.comparable_rows_checked = 1;
  if (classification.arithmetic_adjusted_sale_price != null) stats.arithmetic_checks_available = 1;
  if (classification.possible_index_misalignment) stats.possible_index_misalignment_count = 1;

  if (policy === "disable_local") {
    if (input.localValue != null) stats.local_mapping_disabled_count = 1;
    return {
      value: builtInValue ?? null,
      parserNotes: input.localValue != null ? ["adjusted_price_local_mapping_disabled"] : [],
      warnings: [],
      stats,
      classification,
      conflict: false,
      filledMissing: false,
      selectedSource: builtInValue == null ? "none" : "builtin"
    };
  }

  if (input.localValue == null) {
    return {
      value: builtInValue ?? null,
      parserNotes: [],
      warnings: [],
      stats,
      classification,
      conflict: false,
      filledMissing: false,
      selectedSource: builtInValue == null ? "none" : "builtin"
    };
  }

  if (builtInValue == null) {
    stats.local_mapping_filled_missing_count = 1;
    return {
      value: input.localValue,
      parserNotes: ["adjusted_price_local_mapping_fill_missing"],
      warnings: [],
      stats,
      classification,
      conflict: false,
      filledMissing: true,
      selectedSource: "local"
    };
  }

  if (valuesMatchWithinTolerance(builtInValue, input.localValue, tolerance)) {
    return {
      value: builtInValue,
      parserNotes: [],
      warnings: [],
      stats,
      classification,
      conflict: false,
      filledMissing: false,
      selectedSource: "builtin"
    };
  }

  stats.conflicts_count = 1;
  const conflictWarning = "local_mapping_conflict_comparables_adjusted_sale_price";

  if (policy === "audit_only" || policy === "local_override") {
    stats.conflicts_resolved_by_local = 1;
    return {
      value: input.localValue,
      parserNotes: ["adjusted_price_conflict_resolved_local"],
      warnings: [conflictWarning, "adjusted_price_conflict_resolved_local"],
      stats,
      classification,
      conflict: true,
      filledMissing: true,
      selectedSource: "local"
    };
  }

  if (policy === "builtin_wins") {
    stats.conflicts_resolved_by_builtin = 1;
    return {
      value: builtInValue,
      parserNotes: ["adjusted_price_conflict_resolved_builtin"],
      warnings: [conflictWarning, "adjusted_price_conflict_resolved_builtin"],
      stats,
      classification,
      conflict: true,
      filledMissing: false,
      selectedSource: "builtin"
    };
  }

  if (classification.local_matches_arithmetic && !classification.built_in_matches_arithmetic) {
    stats.conflicts_resolved_by_local = 1;
    stats.conflicts_resolved_by_arithmetic = 1;
    return {
      value: input.localValue,
      parserNotes: ["adjusted_price_conflict_resolved_arithmetic", "adjusted_price_conflict_resolved_local"],
      warnings: [conflictWarning, "adjusted_price_conflict_resolved_arithmetic"],
      stats,
      classification,
      conflict: true,
      filledMissing: true,
      selectedSource: "local"
    };
  }

  if (classification.built_in_matches_arithmetic) {
    stats.conflicts_resolved_by_builtin = 1;
    stats.conflicts_resolved_by_arithmetic = 1;
    return {
      value: builtInValue,
      parserNotes: ["adjusted_price_conflict_resolved_arithmetic", "adjusted_price_conflict_resolved_builtin"],
      warnings: [conflictWarning, "adjusted_price_conflict_resolved_arithmetic"],
      stats,
      classification,
      conflict: true,
      filledMissing: false,
      selectedSource: "builtin"
    };
  }

  stats.conflicts_resolved_by_builtin = 1;
  stats.conflicts_unresolved = 1;
  return {
    value: builtInValue,
    parserNotes: ["adjusted_price_conflict_unresolved"],
    warnings: [conflictWarning, "adjusted_price_conflict_unresolved"],
    stats,
    classification,
    conflict: true,
    filledMissing: false,
    selectedSource: "builtin"
  };
}

function findNeighborArithmeticMatch(
  localValue: number | null,
  compIndex: number,
  arithmeticValuesByIndex: Array<number | null> | undefined,
  tolerance: number
): -1 | 1 | null {
  if (localValue == null || !arithmeticValuesByIndex) return null;
  const previous = arithmeticValuesByIndex[compIndex - 1];
  if (valuesMatchWithinTolerance(localValue, previous, tolerance)) return -1;
  const next = arithmeticValuesByIndex[compIndex + 1];
  if (valuesMatchWithinTolerance(localValue, next, tolerance)) return 1;
  return null;
}

function primaryClassification(classifications: AdjustedPriceClassification[]): AdjustedPriceClassification {
  const priority: AdjustedPriceClassification[] = [
    "possible_index_misalignment",
    "local_filled_missing_builtin",
    "both_match_arithmetic",
    "local_matches_arithmetic",
    "builtin_matches_arithmetic",
    "neither_matches_arithmetic",
    "unresolved_needs_manual_review",
    "no_arithmetic_check_available"
  ];
  return priority.find((item) => classifications.includes(item)) ?? "no_arithmetic_check_available";
}

function dedupe<T>(values: T[]): T[] {
  return [...new Set(values)];
}
