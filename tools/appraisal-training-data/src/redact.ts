import type { ComparableSale, NormalizedAppraisalCase } from "./types.js";

const emailPattern = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const phonePattern = /(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/g;
const licensePattern = /\b(?:license|lic\.?|certification|cert\.?)\s*(?:#|no\.?|number)?\s*[:\-]?\s*[A-Z0-9-]{4,}\b/gi;
const privateIdPattern = /\b(?:loan|file|case|client|borrower)\s*(?:#|id|number|no\.?)\s*[:\-]?\s*[A-Z0-9-]{4,}\b/gi;
const namedPartyPattern = /\b(?:borrower|client|appraiser)\s*[:\-]\s*[A-Z][A-Za-z'.-]+(?:\s+[A-Z][A-Za-z'.-]+){0,3}/gi;
const streetPattern =
  /\b\d{1,6}\s+[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,5}\s+(?:st|street|ave|avenue|rd|road|dr|drive|ln|lane|ct|court|cir|circle|blvd|boulevard|pkwy|parkway|pl|place|ter|terrace|way)\b\.?/gi;
const zipPattern = /\b\d{5}(?:-\d{4})?\b/g;

export function redactCase(normalizedCase: NormalizedAppraisalCase, enabled: boolean): NormalizedAppraisalCase {
  const copy = structuredClone(normalizedCase);
  if (!enabled) {
    copy.quality_flags.redaction_notes.push("redaction_disabled_by_cli_option");
    return copy;
  }

  const notes: string[] = [];

  copy.subject.address_redacted = redactAddress(copy.subject.address_redacted, notes);
  copy.subject.postal_code_redacted = redactPostalCode(copy.subject.postal_code_redacted, notes);

  copy.comparables = copy.comparables.map((comp) => redactComparable(comp, notes));

  copy.reconciliation.narrative = redactSensitiveText(copy.reconciliation.narrative, notes);
  copy.appraiser_comments.subject_comments = redactSensitiveText(copy.appraiser_comments.subject_comments, notes);
  copy.appraiser_comments.comp_comments = redactSensitiveText(copy.appraiser_comments.comp_comments, notes);
  copy.appraiser_comments.market_comments = redactSensitiveText(copy.appraiser_comments.market_comments, notes);
  copy.appraiser_comments.reconciliation_comments = redactSensitiveText(
    copy.appraiser_comments.reconciliation_comments,
    notes
  );
  copy.appraiser_comments.extra_comments = redactSensitiveText(copy.appraiser_comments.extra_comments, notes);

  for (const comp of copy.comparables) {
    comp.appraiser_comment = redactSensitiveText(comp.appraiser_comment, notes);
    for (const adjustment of comp.adjustments) {
      adjustment.description = redactSensitiveText(adjustment.description, notes);
      adjustment.raw_value = redactSensitiveText(adjustment.raw_value, notes);
    }
  }

  copy.quality_flags.redaction_notes = dedupe([...copy.quality_flags.redaction_notes, ...notes]);
  if (notes.includes("redaction_uncertain")) {
    copy.quality_flags.warnings = dedupe([...copy.quality_flags.warnings, "redaction_uncertain"]);
  }

  return copy;
}

export function redactSensitiveText(value: string | null, notes: string[]): string | null {
  if (!value) return null;
  let output = value;

  output = output.replace(emailPattern, () => {
    notes.push("redacted_email");
    return "[REDACTED EMAIL]";
  });
  output = output.replace(phonePattern, () => {
    notes.push("redacted_phone");
    return "[REDACTED PHONE]";
  });
  output = output.replace(licensePattern, () => {
    notes.push("redacted_license_number");
    return "[REDACTED LICENSE]";
  });
  output = output.replace(privateIdPattern, () => {
    notes.push("redacted_private_identifier");
    return "[REDACTED ID]";
  });
  output = output.replace(namedPartyPattern, (match) => {
    const label = match.split(/[:\-]/)[0]?.trim() ?? "party";
    notes.push("redacted_private_name");
    return `${label}: [REDACTED NAME]`;
  });
  output = output.replace(streetPattern, () => {
    notes.push("redacted_street_address");
    return "[REDACTED STREET]";
  });

  return output.replace(/\s+/g, " ").trim();
}

export function redactAddress(value: string | null, notes: string[]): string | null {
  if (!value) return null;
  const parts = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  if (streetPattern.test(parts[0] ?? "")) {
    streetPattern.lastIndex = 0;
    notes.push("redacted_street_address");
    if (parts.length >= 3) {
      const city = parts[1];
      const state = stripPostalCode(parts[2] ?? "");
      return [city, state].filter(Boolean).length > 0
        ? `[REDACTED STREET], ${[city, state].filter(Boolean).join(", ")}`
        : "[REDACTED STREET]";
    }
    return "[REDACTED STREET]";
  }

  streetPattern.lastIndex = 0;
  if (streetPattern.test(value)) {
    streetPattern.lastIndex = 0;
    notes.push("redacted_street_address");
    return "[REDACTED STREET]";
  }

  streetPattern.lastIndex = 0;
  if (/\d/.test(value)) {
    notes.push("redaction_uncertain");
    return "[REDACTED STREET]";
  }

  if (/\b(?:st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|boulevard)\b/i.test(value)) {
    notes.push("redaction_uncertain");
    return "[REDACTED STREET]";
  }

  return redactSensitiveText(value, notes);
}

export function redactPostalCode(value: string | null, notes: string[]): string | null {
  if (!value) return null;
  const match = value.match(/\d{5}/);
  if (!match) return null;
  notes.push("redacted_postal_code");
  return `${match[0].slice(0, 3)}**`;
}

function redactComparable(comp: ComparableSale, notes: string[]): ComparableSale {
  return {
    ...comp,
    address_redacted: redactAddress(comp.address_redacted, notes),
    postal_code_redacted: redactPostalCode(comp.postal_code_redacted, notes)
  };
}

function stripPostalCode(value: string): string {
  return value.replace(zipPattern, "").trim().replace(/\s+/g, " ");
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
