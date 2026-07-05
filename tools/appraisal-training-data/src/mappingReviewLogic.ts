import { redactSensitiveText } from "./redact.js";
import type { ValueShape } from "./valueShape.js";
import { normalizeKey } from "./xmlValueFinder.js";

export type MappingContext =
  | "subject_context"
  | "comparable_context"
  | "sales_comparison_grid_context"
  | "cost_approach_context"
  | "prior_sale_context"
  | "price_per_unit_context"
  | "narrative_context"
  | "metadata_context"
  | "unknown_context";

export type ReviewRecommendation = "likely_accept" | "likely_reject" | "needs_manual_review";

export interface ReviewCandidateInput {
  target: string;
  path: string;
  strategy: "direct" | "grid_row";
  value_shapes: Partial<Record<ValueShape, number>>;
  sanitized_samples?: string[];
}

export interface CandidateDecision {
  context: MappingContext;
  recommendation: ReviewRecommendation;
  reasoning: string[];
  review_questions: string[];
}

const reviewQuestionMap: Record<string, string[]> = {
  "subject.condition": [
    "Is this the subject property's UAD condition or equivalent overall condition?",
    "Is this different from comparable condition?",
    "Does it correspond to the condition shown for the subject in the report?"
  ],
  "subject.quality": [
    "Is this the subject property's UAD quality or equivalent construction quality?",
    "Is this different from comparable quality?",
    "Is this a property quality field rather than a cost-service quality rating?"
  ],
  "comparables.condition": [
    "Is this the condition for each selected comparable?",
    "Does each value align by comparable order?",
    "Is this different from the subject condition?"
  ],
  "comparables.quality": [
    "Is this the quality rating for each selected comparable?",
    "Does each value align by comparable order?",
    "Is this different from the subject quality?"
  ],
  "comparables.gla_sqft": [
    "Is this the living area square footage for each selected comparable?",
    "Is this different from subject GLA?",
    "Is this an area value rather than price per GLA?"
  ],
  "comparables.sale_date": [
    "Is this the current sale date for each selected comparable?",
    "Is this different from prior/previous sale history?",
    "Does it match the report grid's sale date row?"
  ],
  "comparables.adjusted_sale_price": [
    "Is this the final adjusted sale price for each selected comparable?",
    "Is this different from original sale price?",
    "Does it correspond to the adjusted value in the report grid?"
  ]
};

export function classifyMappingContext(pathName: string, strategy: "direct" | "grid_row" = "direct"): MappingContext {
  const normalized = normalizeForContext(pathName);

  if (hasAny(normalized, ["priceper", "pergla", "persquarefoot", "unitprice", "salespricepergrosslivingarea"])) {
    return "price_per_unit_context";
  }
  if (hasAny(normalized, ["priorsale", "previoussale", "transferhistory", "resalehistory"])) {
    return "prior_sale_context";
  }
  if (hasAny(normalized, ["costservice", "costapproach", "costanalysis", "marshall", "swift"])) {
    return "cost_approach_context";
  }
  if (hasAny(normalized, ["reconciliation", "comments", "comment", "narrative", "addendum"])) {
    return "narrative_context";
  }
  if (hasAny(normalized, ["metadata", "report", "signeddate", "signature", "appraiser", "client", "borrower", "loan"])) {
    return "metadata_context";
  }
  if (strategy === "grid_row" || hasAny(normalized, ["salescomparisongrid", "salepriceadjustment"])) {
    return "sales_comparison_grid_context";
  }
  if (hasAny(normalized, ["comparablesale", "comparable", "salecomparable", "comparableproperty", "salescomparison", "salerecord", "vendorsales"])) {
    return "comparable_context";
  }
  if (hasAny(normalized, ["subject", "appraisedproperty", "improvements", "propertystructure", "propertyanalysis", "property"])) {
    return "subject_context";
  }

  return "unknown_context";
}

export function recommendCandidate(candidate: ReviewCandidateInput): CandidateDecision {
  const context = classifyMappingContext(candidate.path, candidate.strategy);
  const target = candidate.target;
  const pathName = normalizeForContext(candidate.path);
  const shapes = candidate.value_shapes;
  const reasoning = [
    `Path classified as ${context}.`,
    `Dominant value shape: ${dominantShape(shapes) ?? "none"}.`
  ];

  let recommendation: ReviewRecommendation = "needs_manual_review";

  if (target === "subject.condition") {
    if (context === "subject_context" && hasConditionSignal(candidate)) recommendation = "likely_accept";
    else if (context === "comparable_context" || context === "sales_comparison_grid_context") recommendation = "likely_reject";
  } else if (target === "subject.quality") {
    if (context === "subject_context" && hasQualitySignal(candidate)) recommendation = "likely_accept";
    else if (["comparable_context", "sales_comparison_grid_context", "cost_approach_context"].includes(context)) {
      recommendation = "likely_reject";
    }
  } else if (target === "comparables.condition") {
    if ((context === "comparable_context" || context === "sales_comparison_grid_context") && hasConditionSignal(candidate)) {
      recommendation = "likely_accept";
    } else if (context === "subject_context") {
      recommendation = "likely_reject";
    }
  } else if (target === "comparables.quality") {
    if ((context === "comparable_context" || context === "sales_comparison_grid_context") && hasQualitySignal(candidate)) {
      recommendation = "likely_accept";
    } else if (context === "subject_context") {
      recommendation = "likely_reject";
    }
  } else if (target === "comparables.gla_sqft") {
    if (context === "subject_context" || context === "price_per_unit_context" || indicatesNonGlaAreaPath(pathName)) {
      recommendation = "likely_reject";
    } else if (
      (context === "comparable_context" || context === "sales_comparison_grid_context") &&
      hasNumericShape(shapes) &&
      hasComparableGlaSignal(candidate)
    ) {
      recommendation = "likely_accept";
    }
  } else if (target === "comparables.sale_date") {
    if (context === "prior_sale_context") {
      recommendation = "likely_reject";
    } else if ((context === "comparable_context" || context === "sales_comparison_grid_context") && hasDateShape(shapes)) {
      recommendation = "likely_accept";
    }
  } else if (target === "comparables.adjusted_sale_price") {
    if (context === "price_per_unit_context" || indicatesWrongAdjustedPricePath(pathName)) {
      recommendation = "likely_reject";
    } else if (
      (context === "comparable_context" || context === "sales_comparison_grid_context") &&
      indicatesAdjustedSalePricePath(pathName) &&
      hasCurrencyOrNumericShape(shapes)
    ) {
      recommendation = "likely_accept";
    }
  }

  reasoning.push(reasonForRecommendation(recommendation, target, context));
  if (candidate.sanitized_samples?.length) {
    reasoning.push(`Safe buckets available: ${candidate.sanitized_samples.join(", ")}.`);
  }

  return {
    context,
    recommendation,
    reasoning,
    review_questions: reviewQuestionMap[target] ?? ["Can a human reviewer confirm this field is semantically correct?"]
  };
}

export function dominantShape(shapes: Partial<Record<ValueShape, number>>): ValueShape | null {
  const entries = Object.entries(shapes) as Array<[ValueShape, number]>;
  if (entries.length === 0) return null;
  return entries.sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

export function redactPrivateReviewValue(pathName: string, value: string): string {
  const normalizedPath = normalizeForContext(pathName);
  if (hasAny(normalizedPath, ["borrower", "client", "appraiser", "owner", "contact", "name"])) {
    return "[REDACTED NAME]";
  }
  if (hasAny(normalizedPath, ["loan", "parcel", "license", "certification", "fileid", "caseid", "clientid", "borrowerid"])) {
    return "[REDACTED ID]";
  }

  const notes: string[] = [];
  const redacted = redactSensitiveText(value, notes) ?? "";
  if (redacted.length > 120) return `${redacted.slice(0, 117)}...`;
  return redacted;
}

function hasConditionSignal(candidate: ReviewCandidateInput): boolean {
  return dominantShape(candidate.value_shapes) === "condition_code";
}

function hasQualitySignal(candidate: ReviewCandidateInput): boolean {
  return dominantShape(candidate.value_shapes) === "quality_code";
}

function hasNumericShape(shapes: Partial<Record<ValueShape, number>>): boolean {
  return Boolean(shapes.numeric);
}

function hasDateShape(shapes: Partial<Record<ValueShape, number>>): boolean {
  return Boolean(shapes.date);
}

function hasCurrencyOrNumericShape(shapes: Partial<Record<ValueShape, number>>): boolean {
  return Boolean(shapes.currency || shapes.numeric);
}

function indicatesAdjustedSalePricePath(pathName: string): boolean {
  return hasAny(pathName, ["adjustedsaleprice", "adjustedsalesprice", "netadjustedsaleprice", "adjustedcomparablevalue"]);
}

function hasComparableGlaSignal(candidate: ReviewCandidateInput): boolean {
  if (candidate.strategy === "grid_row") return true;
  return hasAny(normalizeForContext(candidate.path), ["grosslivingarea", "gla", "livingarea"]);
}

function indicatesNonGlaAreaPath(pathName: string): boolean {
  return hasAny(pathName, [
    "belowgrade",
    "basement",
    "salepriceadjustmentamount",
    "adjustmentamount",
    "amount",
    "sequenceidentifier",
    "propertyfeaturesequenceidentifier",
    "bathroom",
    "bedroom",
    "room",
    "site",
    "lot",
    "parcel",
    "census",
    "mapreference"
  ]);
}

function indicatesWrongAdjustedPricePath(pathName: string): boolean {
  if (indicatesAdjustedSalePricePath(pathName)) return false;
  return hasAny(pathName, [
    "salepriceadjustmentamount",
    "propertysalesamount",
    "saleprice",
    "salesprice",
    "listprice",
    "priorsaleprice",
    "taxassessment",
    "assessedvalue"
  ]);
}

function reasonForRecommendation(
  recommendation: ReviewRecommendation,
  target: string,
  context: MappingContext
): string {
  if (recommendation === "likely_accept") {
    return `Recommendation is likely_accept because ${target} matches ${context} and safe value shapes/path tokens.`;
  }
  if (recommendation === "likely_reject") {
    return `Recommendation is likely_reject because ${target} conflicts with ${context} or path semantics.`;
  }
  return "Recommendation is needs_manual_review because context or value semantics are not conclusive.";
}

function normalizeForContext(value: string): string {
  return normalizeKey(value).replace(/squarefeet/g, "sqft");
}

function hasAny(value: string, tokens: string[]): boolean {
  return tokens.some((token) => value.includes(normalizeForContext(token)));
}
