export type ValueShape =
  | "empty"
  | "numeric"
  | "currency"
  | "date"
  | "condition_code"
  | "quality_code"
  | "short_code"
  | "long_text_private_risk"
  | "address_like_private_risk"
  | "name_like_private_risk"
  | "email_private_risk"
  | "phone_private_risk"
  | "id_like_private_risk"
  | "unknown";

export interface ValueShapeResult {
  shape: ValueShape;
  sanitized_sample: string | null;
  private_risk: boolean;
}

const emailPattern = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const phonePattern = /(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/;
const streetPattern =
  /\b\d{1,6}\s+[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,5}\s+(?:st|street|ave|avenue|rd|road|dr|drive|ln|lane|ct|court|cir|circle|blvd|boulevard|pkwy|parkway|pl|place|ter|terrace|way)\b\.?/i;
const idPattern = /\b(?:loan|parcel|file|case|client|borrower|license|lic\.?|cert\.?)\s*(?:#|id|number|no\.?)?\s*[:\-]?\s*[A-Z0-9-]{4,}\b/i;
const dateIsoPattern = /^\d{4}-\d{1,2}-\d{1,2}$/;
const dateSlashPattern = /^\d{1,2}\/\d{1,2}\/\d{2,4}$/;
const dateCompactPattern = /^\d{8}$/;
const currencyPattern = /^-?\$?\d{1,3}(?:,\d{3})*(?:\.\d+)?$|^-?\d+(?:\.\d+)?$/;
const numericPattern = /^-?\d+(?:\.\d+)?$/;

export function classifyValueShape(value: string | null | undefined, allowSanitizedSample = false): ValueShapeResult {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return { shape: "empty", sanitized_sample: null, private_risk: false };
  }

  if (emailPattern.test(trimmed)) return risk("email_private_risk");
  if (phonePattern.test(trimmed)) return risk("phone_private_risk");
  if (streetPattern.test(trimmed)) return risk("address_like_private_risk");
  if (idPattern.test(trimmed)) return risk("id_like_private_risk");
  if (looksNameLike(trimmed)) return risk("name_like_private_risk");

  if (/^C[1-6]$/i.test(trimmed)) {
    return { shape: "condition_code", sanitized_sample: allowSanitizedSample ? trimmed.toUpperCase() : null, private_risk: false };
  }
  if (/^Q[1-6]$/i.test(trimmed)) {
    return { shape: "quality_code", sanitized_sample: allowSanitizedSample ? trimmed.toUpperCase() : null, private_risk: false };
  }
  if (dateIsoPattern.test(trimmed)) {
    return { shape: "date", sanitized_sample: allowSanitizedSample ? "YYYY-MM-DD" : null, private_risk: false };
  }
  if (dateSlashPattern.test(trimmed)) {
    return { shape: "date", sanitized_sample: allowSanitizedSample ? "MM/DD/YYYY" : null, private_risk: false };
  }
  if (dateCompactPattern.test(trimmed)) {
    return { shape: "date", sanitized_sample: allowSanitizedSample ? "YYYYMMDD" : null, private_risk: false };
  }
  if (trimmed.includes("$") && currencyPattern.test(trimmed.replace(/,/g, ""))) {
    return {
      shape: "currency",
      sanitized_sample: allowSanitizedSample ? currencyBucket(trimmed) : null,
      private_risk: false
    };
  }
  if (numericPattern.test(trimmed.replace(/,/g, ""))) {
    return {
      shape: "numeric",
      sanitized_sample: allowSanitizedSample ? numericBucket(trimmed) : null,
      private_risk: false
    };
  }
  if (/^[A-Z0-9]{1,8}$/i.test(trimmed)) {
    return { shape: "short_code", sanitized_sample: allowSanitizedSample ? "[SHORT_CODE]" : null, private_risk: false };
  }
  if (trimmed.length > 40) return risk("long_text_private_risk");

  return { shape: "unknown", sanitized_sample: null, private_risk: false };
}

export function shapeCounts(values: string[], allowSanitizedSamples = false): {
  counts: Record<ValueShape, number>;
  sanitized_samples: string[];
  private_risk_count: number;
} {
  const counts = {} as Record<ValueShape, number>;
  const samples: string[] = [];
  let privateRiskCount = 0;

  for (const value of values) {
    const result = classifyValueShape(value, allowSanitizedSamples);
    counts[result.shape] = (counts[result.shape] ?? 0) + 1;
    if (result.private_risk) privateRiskCount += 1;
    if (result.sanitized_sample && !samples.includes(result.sanitized_sample) && samples.length < 8) {
      samples.push(result.sanitized_sample);
    }
  }

  return {
    counts,
    sanitized_samples: samples,
    private_risk_count: privateRiskCount
  };
}

function risk(shape: ValueShape): ValueShapeResult {
  return {
    shape,
    sanitized_sample: null,
    private_risk: true
  };
}

function looksNameLike(value: string): boolean {
  if (!/\s/.test(value)) return false;
  if (!/^[A-Z][A-Za-z'.-]+(?:\s+[A-Z][A-Za-z'.-]+){1,3}$/.test(value)) return false;
  return !/\b(?:condition|quality|market|residential|comparison|appraisal|street|avenue|road|drive)\b/i.test(value);
}

function numericBucket(value: string): string {
  const parsed = Number(value.replace(/[$,]/g, ""));
  if (!Number.isFinite(parsed)) return "[NUMERIC]";
  if (parsed >= 100 && parsed <= 10000) {
    const low = Math.floor(parsed / 500) * 500;
    return `${low}-${low + 499}`;
  }
  return "[NUMERIC]";
}

function currencyBucket(value: string): string {
  const parsed = Number(value.replace(/[$,]/g, ""));
  if (!Number.isFinite(parsed)) return "[CURRENCY]";
  const low = Math.floor(parsed / 50000) * 50;
  return `$${low}k-$${low + 50}k`;
}

