import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  arithmeticAdjustedSalePrice,
  resolveAdjustedPriceConflict
} from "../src/adjustedPricePolicy.js";
import { buildTrainingCase, assertNoInputLeakage } from "../src/buildTrainingCase.js";
import { runApplyReviewDecisions } from "../src/applyReviewDecisions.js";
import { runAdjustedPriceResolutionAudit } from "../src/auditAdjustedPriceResolution.js";
import { runConflictAudit } from "../src/auditConflicts.js";
import { runCli } from "../src/cli.js";
import { runFieldDiscovery } from "../src/discoverFields.js";
import { toJsonlTrainingLine, exportJsonl } from "../src/exportJsonl.js";
import { runApprovedExport } from "../src/exportApproved.js";
import { stableCaseId } from "../src/fileUtils.js";
import { mergeGridComparable, normalizeGridLabel } from "../src/gridExtract.js";
import { loadLocalFieldMappings } from "../src/localMapping.js";
import { buildManifest } from "../src/manifest.js";
import { normalizeParsedXml } from "../src/normalize.js";
import { parseXml } from "../src/parseXml.js";
import { redactCase, redactAddress, redactSensitiveText } from "../src/redact.js";
import { runInspectXml } from "../src/inspectXml.js";
import {
  classifyMappingContext,
  recommendCandidate,
  redactPrivateReviewValue,
  runMappingReview
} from "../src/reviewMappings.js";
import { buildReviewPacket, type ReviewPacket } from "../src/reviewPackets.js";
import { runPrepareReviewBatch } from "../src/prepareReviewBatch.js";
import {
  buildReviewUiState,
  bulkApproveGreenCases,
  decisionsToCsv,
  recommendCase,
  scanPrivacyRisk,
  validateDecisionDraft
} from "../src/reviewUiData.js";
import { splitTrainEval } from "../src/splitTrainEval.js";
import type { ComparableSale, NormalizedAppraisalCase } from "../src/types.js";
import { runMappingValidation } from "../src/validateMapping.js";
import { validateNormalizedCase } from "../src/validate.js";
import { classifyValueShape } from "../src/valueShape.js";
import { buildWorkbenchState } from "../src/workbenchData.js";
import { normalizeCurrency, normalizeDate, normalizeSquareFeet } from "../src/xmlValueFinder.js";

const fixtureRoot = new URL("../fixtures/", import.meta.url);
const uadFixture = new URL("synthetic-uad-like-appraisal.xml", fixtureRoot);
const genericFixture = new URL("synthetic-generic-appraisal.xml", fixtureRoot);
const gridFixture = new URL("synthetic-grid-appraisal.xml", fixtureRoot);
const weirdFixture = new URL("synthetic-vendor-weird-appraisal.xml", fixtureRoot);
const tierOneOnlyXml = `<?xml version="1.0" encoding="UTF-8"?>
<Root>
  <SubjectProperty>
    <PropertyType>Single family</PropertyType>
    <City>Exampleville</City>
    <State>IN</State>
    <Bedrooms>3</Bedrooms>
    <Bathrooms>2</Bathrooms>
  </SubjectProperty>
  <ComparableSale>
    <CompId>1</CompId>
    <SalePrice>$100,000</SalePrice>
    <AdjustedSalePrice>$105,000</AdjustedSalePrice>
    <Adjustment>
      <Field>Condition</Field>
      <Amount>$5,000</Amount>
    </Adjustment>
  </ComparableSale>
  <Reconciliation>
    <FinalOpinionOfValue>$105,000</FinalOpinionOfValue>
    <Narrative>Synthetic tier one reconciliation.</Narrative>
  </Reconciliation>
</Root>`;

async function loadCase(fixtureUrl: URL): Promise<NormalizedAppraisalCase> {
  const xml = await readFile(fixtureUrl, "utf8");
  const parsed = parseXml(xml);
  return validateNormalizedCase(redactCase(normalizeParsedXml(parsed, fixtureUrl.pathname), true));
}

function reviewPacketFromXml(xml: string, filename = "review-ui.xml"): ReviewPacket {
  const normalized = validateNormalizedCase(redactCase(normalizeParsedXml(parseXml(xml), filename), true));
  return buildReviewPacket(normalized, buildTrainingCase(normalized, "tier1"));
}

function makeComparable(overrides: Partial<ComparableSale> = {}): ComparableSale {
  return {
    comp_id: "comp_1",
    address_redacted: null,
    city: null,
    state: null,
    postal_code_redacted: null,
    distance_miles: null,
    sale_price: null,
    sale_date: null,
    data_source: null,
    verification_source: null,
    gla_sqft: null,
    bedrooms: null,
    bathrooms: null,
    year_built: null,
    condition: null,
    quality: null,
    site_size: null,
    view: null,
    location: null,
    adjustments: [],
    net_adjustment: null,
    gross_adjustment: null,
    adjusted_sale_price: null,
    appraiser_comment: null,
    ...overrides
  };
}

describe("appraisal XML training data pipeline", () => {
  it("parses synthetic UAD-like XML without crashing", async () => {
    const xml = await readFile(uadFixture, "utf8");
    const parsed = parseXml(xml);
    expect(parsed.detectedXmlType).toBe("uad_like");
  });

  it("parses synthetic generic appraisal XML without crashing", async () => {
    const xml = await readFile(genericFixture, "utf8");
    const parsed = parseXml(xml);
    expect(parsed.detectedXmlType).toBe("generic_appraisal_xml");
  });

  it("normalizes subject fields correctly", async () => {
    const normalized = await loadCase(uadFixture);
    expect(normalized.subject.gla_sqft).toBe(1850);
    expect(normalized.subject.bedrooms).toBe(3);
    expect(normalized.subject.condition).toBe("C3");
    expect(normalized.subject.address_redacted).toBe("[REDACTED STREET], Exampleville, IN");
  });

  it("normalizes comparable fields correctly", async () => {
    const normalized = await loadCase(uadFixture);
    expect(normalized.comparables).toHaveLength(3);
    expect(normalized.comparables[0]?.sale_price).toBe(305000);
    expect(normalized.comparables[0]?.adjusted_sale_price).toBe(312500);
    expect(normalized.comparables[0]?.adjustments[0]?.field).toBe("GLA");
  });

  it("parses currency strings correctly", () => {
    expect(normalizeCurrency("$305,000")).toBe(305000);
    expect(normalizeCurrency("-$4,500")).toBe(-4500);
  });

  it("parses square footage strings correctly", () => {
    expect(normalizeSquareFeet("1,850 sf")).toBe(1850);
  });

  it("normalizes dates safely", () => {
    expect(normalizeDate("02/14/2026")).toBe("2026-02-14");
    expect(normalizeDate("20260301")).toBe("2026-03-01");
    expect(normalizeDate("unparseable date")).toBe("unparseable date");
  });

  it("redaction removes phone numbers", () => {
    const notes: string[] = [];
    expect(redactSensitiveText("Call 317-555-0100 for details.", notes)).toContain("[REDACTED PHONE]");
    expect(notes).toContain("redacted_phone");
  });

  it("redaction removes emails", () => {
    const notes: string[] = [];
    expect(redactSensitiveText("Email test@example.invalid.", notes)).toContain("[REDACTED EMAIL]");
    expect(notes).toContain("redacted_email");
  });

  it("redaction removes or masks full street addresses", () => {
    const notes: string[] = [];
    expect(redactAddress("123 Main St, Indianapolis, IN 46220", notes)).toBe(
      "[REDACTED STREET], Indianapolis, IN"
    );
    expect(redactAddress("456 Oak Drive", notes)).toBe("[REDACTED STREET]");
  });

  it("redaction masks ZIP codes while preserving city state county fields", async () => {
    const normalized = await loadCase(uadFixture);
    expect(normalized.subject.postal_code_redacted).toBe("462**");
    expect(normalized.subject.city).toBe("Exampleville");
    expect(normalized.subject.state).toBe("IN");
    expect(normalized.subject.county).toBe("Sample County");
  });

  it("redaction removes obvious labeled private names", () => {
    const notes: string[] = [];
    expect(redactSensitiveText("Borrower: Test Person. Client: Sample User.", notes)).toContain("[REDACTED NAME]");
    expect(notes).toContain("redacted_private_name");
  });

  it("training case builder does not leak final value keys into input_case", async () => {
    const normalized = await loadCase(uadFixture);
    const trainingCase = buildTrainingCase(normalized);
    expect(JSON.stringify(trainingCase.input_case)).not.toContain("final_opinion_of_value");
    for (const forbiddenKey of [
      "final_opinion_of_value",
      "appraised_value",
      "opinion_of_value",
      "reconciled_value",
      "reconciliation_narrative",
      "final_value"
    ]) {
      expect(() => assertNoInputLeakage({ subject: { nested: { [forbiddenKey]: 123 } } })).toThrow(/leakage/i);
    }
  });

  it("JSONL export produces one valid JSON object per line", async () => {
    const normalized = await loadCase(uadFixture);
    const trainingCase = buildTrainingCase(normalized);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "appraisal-jsonl-"));
    const outputPath = path.join(tempDir, "candidate_all.jsonl");
    await exportJsonl(outputPath, [trainingCase]);
    const lines = (await readFile(outputPath, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "{}").metadata.case_id).toBe(trainingCase.case_id);
  });

  it("assistant message content is valid JSON", async () => {
    const normalized = await loadCase(uadFixture);
    const line = toJsonlTrainingLine(buildTrainingCase(normalized));
    const assistantMessage = line.messages.find((message) => message.role === "assistant");
    expect(() => JSON.parse(assistantMessage?.content ?? "")).not.toThrow();
  });

  it("train/eval split is deterministic with the same seed", async () => {
    const first = buildTrainingCase(await loadCase(uadFixture));
    const second = buildTrainingCase(await loadCase(genericFixture));
    const splitA = splitTrainEval([first, second], 0.5, 99);
    const splitB = splitTrainEval([first, second], 0.5, 99);
    expect(splitA).toEqual(splitB);
  });

  it("manifest counts are correct", async () => {
    const first = await loadCase(uadFixture);
    const second = await loadCase(genericFixture);
    const trainingCases = [buildTrainingCase(first), buildTrainingCase(second)];
    const split = splitTrainEval(trainingCases, 0.5, 42);
    const manifest = buildManifest({
      inputFolder: "in",
      outputFolder: "out",
      redactionEnabled: true,
      evalRatio: 0.5,
      seed: 42,
      xmlFilesFound: 2,
      parsed: 2,
      normalizedCases: [first, second],
      rejectedFiles: [],
      trainCases: split.train,
      evalCases: split.eval,
      createdAt: new Date("2026-01-01T00:00:00.000Z")
    });
    expect(manifest.counts.xml_files_found).toBe(2);
    expect(manifest.counts.parsed).toBe(2);
    expect(manifest.counts.normalized).toBe(2);
    expect(manifest.counts.train_lines + manifest.counts.eval_lines).toBe(2);
  });

  it("unknown XML does not crash normalization", () => {
    const parsed = parseXml("<Root><Thing>Value</Thing></Root>");
    const normalized = validateNormalizedCase(redactCase(normalizeParsedXml(parsed, "unknown.xml"), true));
    expect(parsed.detectedXmlType).toBe("unknown_xml");
    expect(normalized.quality_flags.status).toBe("rejected");
    expect(normalized.quality_flags.warnings).toContain("unknown_xml_format");
  });

  it("missing fields produce warnings, not hard crashes", async () => {
    const normalized = await loadCase(genericFixture);
    expect(normalized.quality_flags.warnings).toContain("missing_subject_condition");
    expect(normalized.quality_flags.warnings).toContain("missing_comparable_sale_price");
  });

  it("normalizes grid row labels", () => {
    expect(normalizeGridLabel("Gross Living Area")).toBe("gross living area");
    expect(normalizeGridLabel("Adjusted Sale Price")).toBe("adjusted sale price");
    expect(normalizeGridLabel("Borrower Name")).toBeNull();
  });

  it("extracts grid condition quality GLA dates and adjusted values", async () => {
    const normalized = await loadCase(gridFixture);
    expect(normalized.subject.condition).toBe("C3");
    expect(normalized.subject.quality).toBe("Q4");
    expect(normalized.comparables).toHaveLength(2);
    expect(normalized.comparables[0]?.condition).toBe("C3");
    expect(normalized.comparables[1]?.condition).toBe("C4");
    expect(normalized.comparables[0]?.quality).toBe("Q4");
    expect(normalized.comparables[0]?.gla_sqft).toBe(1840);
    expect(normalized.comparables[1]?.sale_date).toBe("2026-03-15");
    expect(normalized.comparables[0]?.adjusted_sale_price).toBe(305000);
    expect(normalized.quality_flags.parser_notes).toContain("grid_row_filled_comparables_gla_sqft");
  });

  it("keeps direct alias values over conflicting grid guesses", async () => {
    const direct = (await loadCase(uadFixture)).comparables[0];
    expect(direct).toBeDefined();
    const merged = mergeGridComparable(direct!, {
      gla_sqft: "9999",
      adjusted_sale_price: "999999"
    });
    expect(merged.comparable.gla_sqft).toBe(direct?.gla_sqft);
    expect(merged.comparable.adjusted_sale_price).toBe(direct?.adjusted_sale_price);
    expect(merged.warnings).toContain("grid_row_conflict_comparables_gla_sqft");
  });

  it("a bad XML file does not stop the whole CLI batch", async () => {
    const tempInput = await mkdtemp(path.join(os.tmpdir(), "appraisal-input-"));
    const tempOutput = await mkdtemp(path.join(os.tmpdir(), "appraisal-output-"));
    await writeFile(path.join(tempInput, "good.xml"), await readFile(uadFixture, "utf8"), "utf8");
    await writeFile(path.join(tempInput, "bad.xml"), "<Root><Unclosed></Root>", "utf8");

    await runCli({
      input: tempInput,
      output: tempOutput,
      evalRatio: 0.5,
      seed: 42,
      redact: true,
      includeNeedsReview: true
    });

    const manifest = JSON.parse(await readFile(path.join(tempOutput, "reports", "manifest.json"), "utf8"));
    expect(manifest.counts.xml_files_found).toBe(2);
    expect(manifest.counts.parsed).toBe(1);
    expect(manifest.rejected_files).toHaveLength(1);
    expect(manifest.counts.train_lines + manifest.counts.eval_lines).toBe(1);
    expect(await readFile(path.join(tempOutput, "reports", "field_coverage.md"), "utf8")).toContain(
      "reconciliation.final_opinion_of_value"
    );
  });

  it("refuses unredacted output unless explicitly confirmed", async () => {
    const tempOutput = await mkdtemp(path.join(os.tmpdir(), "appraisal-output-"));
    await expect(
      runCli({
        input: fileURLToPath(new URL("../fixtures/", import.meta.url)),
        output: tempOutput,
        evalRatio: 0.5,
        seed: 42,
        redact: false,
        includeNeedsReview: true
      })
    ).rejects.toThrow(/allow-unredacted-output/);
  });

  it("XML inspection command writes shape-only reports", async () => {
    const tempOutput = await mkdtemp(path.join(os.tmpdir(), "appraisal-inspect-"));
    await runInspectXml({
      input: fileURLToPath(new URL("../fixtures/", import.meta.url)),
      output: tempOutput,
      safeValueProfile: false
    });

    const tagInventory = JSON.parse(await readFile(path.join(tempOutput, "tag_inventory.json"), "utf8"));
    const pathInventory = JSON.parse(await readFile(path.join(tempOutput, "path_inventory.json"), "utf8"));
    const likelyMatches = JSON.parse(await readFile(path.join(tempOutput, "likely_field_matches.json"), "utf8"));
    const serialized = JSON.stringify({ tagInventory, pathInventory, likelyMatches });

    expect(tagInventory.length).toBeGreaterThan(0);
    expect(pathInventory.length).toBeGreaterThan(0);
    expect(likelyMatches.some((match: { likelyField: string }) => match.likelyField === "subject.gla_sqft")).toBe(
      true
    );
    expect(serialized).not.toContain("123 Training Lane");
    expect(serialized).not.toContain("test@example.invalid");
  });

  it("safe value profiling excludes private-looking fixture strings", async () => {
    const tempOutput = await mkdtemp(path.join(os.tmpdir(), "appraisal-inspect-"));
    await runInspectXml({
      input: fileURLToPath(new URL("../fixtures/", import.meta.url)),
      output: tempOutput,
      safeValueProfile: true
    });

    const profile = await readFile(path.join(tempOutput, "safe_value_profile.json"), "utf8");
    expect(profile).toContain("C3");
    expect(profile).not.toContain("Training Grid Rd");
    expect(profile).not.toContain("test@example.invalid");
    expect(profile).not.toContain("317-555-0100");
  });

  it("emits unreviewed review packets", async () => {
    const tempOutput = await mkdtemp(path.join(os.tmpdir(), "appraisal-review-"));
    await runCli({
      input: fileURLToPath(new URL("../fixtures/", import.meta.url)),
      output: tempOutput,
      evalRatio: 0.5,
      seed: 42,
      redact: true,
      includeNeedsReview: true,
      emitReviewPackets: true
    });

    const reviewFiles = await readdir(path.join(tempOutput, "review_packets"));
    expect(reviewFiles.length).toBeGreaterThan(0);
    const packet = JSON.parse(await readFile(path.join(tempOutput, "review_packets", reviewFiles[0]!), "utf8"));
    expect(packet.reviewer_decision.status).toBe("unreviewed");
    expect(packet.tier_status.tier_1_reconciliation_explanation).toBeDefined();
    expect(packet.tier_reasons.tier_3_comp_selection).toBeDefined();
    expect(packet.review_checklist.map((item: { item: string }) => item.item).join("\n")).toContain("Comparable GLA present");
  });

  it("approved export excludes unapproved packets and includes approved packets", async () => {
    const reviewed = await mkdtemp(path.join(os.tmpdir(), "appraisal-reviewed-"));
    const output = await mkdtemp(path.join(os.tmpdir(), "appraisal-approved-"));
    await mkdir(path.join(reviewed, "nested"), { recursive: true });

    const normalized = await loadCase(gridFixture);
    const trainingCase = buildTrainingCase(normalized);
    const approvedPacket = {
      case_id: normalized.case_id,
      proposed_training_case: trainingCase,
      reviewer_decision: {
        status: "approved",
        reviewer: "Synthetic Reviewer",
        reviewed_at: "2026-04-11T00:00:00.000Z",
        notes: "Synthetic approval."
      }
    };
    const unapprovedPacket = {
      case_id: "unapproved",
      proposed_training_case: trainingCase,
      reviewer_decision: {
        status: "unreviewed",
        reviewer: null,
        reviewed_at: null,
        notes: null
      }
    };

    await writeFile(path.join(reviewed, "approved.review.json"), JSON.stringify(approvedPacket, null, 2), "utf8");
    await writeFile(path.join(reviewed, "nested", "unapproved.review.json"), JSON.stringify(unapprovedPacket, null, 2), "utf8");

    await runApprovedExport({
      reviewed,
      output,
      evalRatio: 0,
      seed: 42
    });

    const manifest = JSON.parse(await readFile(path.join(output, "reports", "approved_manifest.json"), "utf8"));
    const allLines = (await readFile(path.join(output, "exports", "all.jsonl"), "utf8")).trim().split("\n").filter(Boolean);
    expect(manifest.counts.review_files_found).toBe(2);
    expect(manifest.counts.approved_cases).toBe(1);
    expect(allLines).toHaveLength(1);
  });

  it("classifies safe and private-risk value shapes", () => {
    expect(classifyValueShape("C3", true).shape).toBe("condition_code");
    expect(classifyValueShape("Q4", true).shape).toBe("quality_code");
    expect(classifyValueShape("1850", true).sanitized_sample).toBe("1500-1999");
    expect(classifyValueShape("123 Main St", true).shape).toBe("address_like_private_risk");
    expect(classifyValueShape("test@example.invalid", true).shape).toBe("email_private_risk");
    expect(classifyValueShape("317-555-0100", true).shape).toBe("phone_private_risk");
  });

  it("loads verified local mappings and ignores unverified mappings", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "mapping-load-"));
    const mappingPath = path.join(tempDir, "mapping.json");
    await writeFile(
      mappingPath,
      JSON.stringify(
        {
          version: 1,
          mappings: {
            "subject.condition": [
              {
                path: "VendorValuationEnvelope.VendorSubjectRatings.CondCode",
                strategy: "direct",
                verified: true
              }
            ],
            "subject.quality": [
              {
                path: "VendorValuationEnvelope.VendorSubjectRatings.QualCode",
                strategy: "direct",
                verified: false
              }
            ]
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const mappings = await loadLocalFieldMappings(mappingPath);
    expect(mappings).toHaveLength(1);
    expect(mappings[0]?.field).toBe("subject.condition");
  });

  it("verified local mappings fill subject condition quality and comparable GLA", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "mapping-fill-"));
    const mappingPath = await writeSyntheticVerifiedMapping(tempDir);
    const mappings = await loadLocalFieldMappings(mappingPath);
    const parsed = parseXml(await readFile(weirdFixture, "utf8"));
    const normalized = validateNormalizedCase(
      normalizeParsedXml(parsed, weirdFixture.pathname, new Date("2026-01-01T00:00:00.000Z"), {
        localFieldMappings: mappings
      })
    );

    expect(normalized.subject.condition).toBe("C3");
    expect(normalized.subject.quality).toBe("Q4");
    expect(normalized.comparables[0]?.gla_sqft).toBe(1680);
    expect(normalized.comparables[1]?.gla_sqft).toBe(1815);
    expect(normalized.quality_flags.parser_notes).toContain("local_mapping_filled_subject_condition");
  });

  it("classifies mapping review contexts", () => {
    expect(
      classifyMappingContext(
        "VALUATION_RESPONSE.VALUATION_METHODS.SALES_COMPARISON.COMPARABLE_SALE.GSEOverallConditionType"
      )
    ).toBe("comparable_context");
    expect(classifyMappingContext("VALUATION_RESPONSE.PROPERTY.STRUCTURE.GrossLivingAreaSquareFeetCount")).toBe(
      "subject_context"
    );
    expect(
      classifyMappingContext("VALUATION_RESPONSE.VALUATION_METHODS.SALES_COMPARISON.COMPARABLE_SALE.SalesPricePerGrossLivingAreaAmount")
    ).toBe("price_per_unit_context");
  });

  it("recommends likely accepts and rejects by target semantics", () => {
    const comparableConditionPath =
      "VALUATION_RESPONSE.VALUATION_METHODS.SALES_COMPARISON.COMPARABLE_SALE.GSEOverallConditionType";
    expect(
      recommendCandidate({
        target: "subject.condition",
        path: comparableConditionPath,
        strategy: "direct",
        value_shapes: { condition_code: 3 }
      }).recommendation
    ).toBe("likely_reject");
    expect(
      recommendCandidate({
        target: "comparables.condition",
        path: comparableConditionPath,
        strategy: "direct",
        value_shapes: { condition_code: 3 }
      }).recommendation
    ).toBe("likely_accept");
    expect(
      recommendCandidate({
        target: "comparables.gla_sqft",
        path: "VALUATION_RESPONSE.PROPERTY.STRUCTURE.GrossLivingAreaSquareFeetCount",
        strategy: "direct",
        value_shapes: { numeric: 10 }
      }).recommendation
    ).toBe("likely_reject");
    expect(
      recommendCandidate({
        target: "comparables.gla_sqft",
        path: "VALUATION_RESPONSE.VALUATION_METHODS.SALES_COMPARISON.COMPARABLE_SALE.SalesPricePerGrossLivingAreaAmount",
        strategy: "direct",
        value_shapes: { currency: 10 }
      }).recommendation
    ).toBe("likely_reject");
    expect(
      recommendCandidate({
        target: "comparables.adjusted_sale_price",
        path: "VALUATION_RESPONSE.VALUATION_METHODS.SALES_COMPARISON.COMPARABLE_SALE.AdjustedSalesPriceAmount",
        strategy: "direct",
        value_shapes: { currency: 10 }
      }).recommendation
    ).toBe("likely_accept");
    expect(
      recommendCandidate({
        target: "comparables.sale_date",
        path: "VALUATION_RESPONSE.VALUATION_METHODS.SALES_COMPARISON.COMPARABLE_SALE.PRIOR_SALES.GSEPriorSaleDate",
        strategy: "direct",
        value_shapes: { date: 10 }
      }).recommendation
    ).toBe("likely_reject");
  });

  it("private value review refuses output outside private", async () => {
    const tempInput = await mkdtemp(path.join(os.tmpdir(), "review-input-"));
    const tempDiscovery = await mkdtemp(path.join(os.tmpdir(), "review-discovery-"));
    const tempOutput = await mkdtemp(path.join(os.tmpdir(), "review-output-"));
    await expect(
      runMappingReview({
        input: tempInput,
        discovery: tempDiscovery,
        output: tempOutput,
        targets: ["subject.condition"],
        allowPrivateValueReview: true
      })
    ).rejects.toThrow(/private/i);
  });

  it("private value review redacts email phone and full street address", () => {
    expect(redactPrivateReviewValue("Some.EmailAddress", "test@example.invalid")).toBe("[REDACTED EMAIL]");
    expect(redactPrivateReviewValue("Some.PhoneNumber", "317-555-0100")).toBe("[REDACTED PHONE]");
    expect(redactPrivateReviewValue("Property.Address", "123 Main St, Exampleville, IN")).toBe("[REDACTED STREET], Exampleville, IN");
  });

  it("mapping review writes packets and leaves proposed template unverified", async () => {
    const tempInput = await mkdtemp(path.join(os.tmpdir(), "review-input-"));
    const tempDiscovery = await mkdtemp(path.join(os.tmpdir(), "review-discovery-"));
    const tempOutput = await mkdtemp(path.join(os.tmpdir(), "review-output-"));
    await writeFile(path.join(tempInput, "sample.xml"), await readFile(weirdFixture, "utf8"), "utf8");

    await runMappingReview({
      input: tempInput,
      discovery: tempDiscovery,
      output: tempOutput,
      targets: ["comparables.condition", "comparables.quality", "comparables.gla_sqft"],
      allowPrivateValueReview: false
    });

    const packets = JSON.parse(await readFile(path.join(tempOutput, "mapping_review_packets.json"), "utf8"));
    const template = JSON.parse(await readFile(path.join(tempOutput, "proposed_verified_mapping.template.json"), "utf8"));
    const compConditionPacket = packets.packets.find((packet: { target: string }) => packet.target === "comparables.condition");
    expect(compConditionPacket.candidates.some((candidate: { recommendation: string }) => candidate.recommendation === "likely_accept")).toBe(true);
    for (const entries of Object.values(template.mappings) as Array<Array<{ verified: boolean }>>) {
      expect(entries.every((entry) => entry.verified === false)).toBe(true);
    }
  });

  it("verified local mappings fill comparable condition and quality", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "mapping-comp-condition-"));
    const mappingPath = path.join(tempDir, "field-mapping.local.json");
    await writeFile(
      mappingPath,
      JSON.stringify(
        {
          version: 1,
          mappings: {
            "comparables.condition": [
              {
                path: "VendorValuationEnvelope.VendorSales.SaleRecord.Ratings.VendorCondition",
                strategy: "direct",
                verified: true
              }
            ],
            "comparables.quality": [
              {
                path: "VendorValuationEnvelope.VendorSales.SaleRecord.Ratings.VendorQuality",
                strategy: "direct",
                verified: true
              }
            ]
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const mappings = await loadLocalFieldMappings(mappingPath);
    const parsed = parseXml(await readFile(weirdFixture, "utf8"));
    const normalized = validateNormalizedCase(
      normalizeParsedXml(parsed, weirdFixture.pathname, new Date("2026-01-01T00:00:00.000Z"), {
        localFieldMappings: mappings
      })
    );

    expect(normalized.comparables[0]?.condition).toBe("C3");
    expect(normalized.comparables[1]?.condition).toBe("C4");
    expect(normalized.comparables[0]?.quality).toBe("Q4");
    expect(normalized.comparables[1]?.quality).toBe("Q3");
    expect(normalized.quality_flags.parser_notes).toContain("local_mapping_filled_comparables_condition");
    expect(normalized.quality_flags.parser_notes).toContain("local_mapping_filled_comparables_quality");
    expect(() => assertNoInputLeakage(buildTrainingCase(normalized).input_case)).not.toThrow();
  });

  it("promotes 1004 comparable adjustment rows into structured comparable facts", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Root>
  <SubjectProperty>
    <PropertyType>Single family</PropertyType>
    <City>Exampleville</City>
    <State>IN</State>
    <GrossLivingAreaSquareFeet>1778</GrossLivingAreaSquareFeet>
  </SubjectProperty>
  <ComparableSale>
    <CompId>1</CompId>
    <PropertySalesAmount>$250,000</PropertySalesAmount>
    <SalesPricePerGrossLivingAreaAmount>$128.47</SalesPricePerGrossLivingAreaAmount>
    <GSEShortDateDescription>s02/25;c01/25</GSEShortDateDescription>
    <SalePriceTotalAdjustmentAmount>-$19,580</SalePriceTotalAdjustmentAmount>
    <SalesPriceTotalAdjustmentNetPercent>-7.8</SalesPriceTotalAdjustmentNetPercent>
    <SalesPriceTotalAdjustmentGrossPercent>9.8</SalesPriceTotalAdjustmentGrossPercent>
    <AdjustedSalesPriceAmount>$230,420</AdjustedSalesPriceAmount>
    <ROOM_ADJUSTMENT TotalRoomCount="11" TotalBedroomCount="4" TotalBathroomCount="2.1" RoomAdjustmentAmount="-$2,500" />
    <SALE_PRICE_ADJUSTMENT Type="PropertyRights" Description="Fee Simple" Amount="0" />
    <SALE_PRICE_ADJUSTMENT Type="FinancingConcessions" Description="Conventional;0" Amount="0" />
    <SALE_PRICE_ADJUSTMENT Type="DateOfSale" Description="s02/25;c01/25" Amount="0" />
    <SALE_PRICE_ADJUSTMENT Type="Location" Description="N;Res" Amount="0" />
    <SALE_PRICE_ADJUSTMENT Type="SiteArea" Description="1.25 ac" Amount="0" />
    <SALE_PRICE_ADJUSTMENT Type="View" Description="N;Residential" Amount="0" />
    <SALE_PRICE_ADJUSTMENT Type="DesignStyle" Description="DT1;Ranch" Amount="0" />
    <SALE_PRICE_ADJUSTMENT Type="Quality" Description="Q4" Amount="0" />
    <SALE_PRICE_ADJUSTMENT Type="Age" Description="55" Amount="-$5,000" />
    <SALE_PRICE_ADJUSTMENT Type="Condition" Description="C4" Amount="0" />
    <SALE_PRICE_ADJUSTMENT Type="GrossLivingArea" Description="1946" Amount="-$5,880" />
    <SALE_PRICE_ADJUSTMENT Type="BasementArea" Description="1800sf0sfwo" Amount="0" />
    <SALE_PRICE_ADJUSTMENT Type="BasementFinish" Description="0sf" Amount="0" />
    <SALE_PRICE_ADJUSTMENT Type="FunctionalUtility" Description="Average" Amount="0" />
    <SALE_PRICE_ADJUSTMENT Type="HeatingCooling" Description="FWA/CAC" Amount="0" />
    <SALE_PRICE_ADJUSTMENT Type="EnergyEfficient" Description="None" Amount="0" />
    <SALE_PRICE_ADJUSTMENT Type="CarStorage" Description="2ga2dw" Amount="0" />
    <SALE_PRICE_ADJUSTMENT Type="PorchDeck" Description="Patio" Amount="0" />
    <OTHER_FEATURE_ADJUSTMENT Type="Other" TypeOtherDescription="Fireplace" Description="1 Fireplace" Amount="-$1,000" />
  </ComparableSale>
  <Reconciliation>
    <FinalOpinionOfValue>$230,000</FinalOpinionOfValue>
    <Narrative>Synthetic reconciliation.</Narrative>
  </Reconciliation>
</Root>`;

    const normalized = normalizeParsedXml(parseXml(xml), "synthetic-1004-grid.xml");
    const comp = normalized.comparables[0];
    expect(comp?.sale_price).toBe(250000);
    expect(comp?.sales_price_per_gla).toBe(128.47);
    expect(comp?.sale_date_raw).toBe("s02/25;c01/25");
    expect(comp?.sale_date).toBe("2025-02");
    expect(comp?.contract_date).toBe("2025-01");
    expect(comp?.property_rights).toBe("Fee Simple");
    expect(comp?.financing_concessions).toBe("Conventional;0");
    expect(comp?.total_rooms).toBe(11);
    expect(comp?.bedrooms).toBe(4);
    expect(comp?.bathrooms).toBe(2.1);
    expect(comp?.full_bathrooms).toBe(2);
    expect(comp?.half_bathrooms).toBe(1);
    expect(comp?.site_size).toBe("1.25 ac");
    expect(comp?.view).toBe("N;Residential");
    expect(comp?.location).toBe("N;Res");
    expect(comp?.design_style).toBe("DT1;Ranch");
    expect(comp?.quality).toBe("Q4");
    expect(comp?.condition).toBe("C4");
    expect(comp?.actual_age).toBe(55);
    expect(comp?.gla_sqft).toBe(1946);
    expect(comp?.basement_description).toBe("1800sf0sfwo");
    expect(comp?.basement_area_sqft).toBe(1800);
    expect(comp?.basement_finished_sqft).toBe(0);
    expect(comp?.basement_finish).toBe("0sf");
    expect(comp?.functional_utility).toBe("Average");
    expect(comp?.heating_cooling).toBe("FWA/CAC");
    expect(comp?.energy_efficient).toBeNull();
    expect(comp?.garage_carport).toBe("2ga2dw");
    expect(comp?.garage_spaces).toBe(2);
    expect(comp?.porch_deck).toBe("Patio");
    expect(comp?.fireplaces).toBe("1 Fireplace");
    expect(comp?.net_adjustment).toBe(-19580);
    expect(comp?.net_adjustment_percent).toBe(-7.8);
    expect(comp?.gross_adjustment_percent).toBe(9.8);
    expect(normalized.quality_flags.parser_notes).toContain("adjustment_row_filled_comparables_gla_sqft");
    expect(normalized.quality_flags.parser_notes).toContain("adjustment_row_filled_comparables_garage_carport");
  });

  it("fills subject condition and quality from subject analysis rows when direct fields are missing", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Root>
  <SubjectProperty>
    <PropertyType>Single family</PropertyType>
    <City>Exampleville</City>
    <State>IN</State>
    <GrossLivingAreaSquareFeet>1778</GrossLivingAreaSquareFeet>
    <PROPERTY_ANALYSIS Type="QualityAndAppearance" Comment="The dwelling is considered Q4 and C4 from overall quality and appearance." />
    <PROPERTY_ANALYSIS Type="PropertyCondition" Comment="The subject condition is best represented as C3." />
  </SubjectProperty>
  <ValuationMethods>
    <CostAnalysis>
      <CostServiceQualityRatingDescription>Q4</CostServiceQualityRatingDescription>
    </CostAnalysis>
  </ValuationMethods>
  <ComparableSale>
    <CompId>1</CompId>
    <SalePrice>$100,000</SalePrice>
    <AdjustedSalePrice>$105,000</AdjustedSalePrice>
    <SALE_PRICE_ADJUSTMENT Type="GrossLivingArea" Description="1778" Amount="0" />
  </ComparableSale>
  <Reconciliation>
    <FinalOpinionOfValue>$105,000</FinalOpinionOfValue>
    <Narrative>Synthetic reconciliation.</Narrative>
  </Reconciliation>
</Root>`;

    const normalized = normalizeParsedXml(parseXml(xml), "synthetic-subject-analysis.xml");
    expect(normalized.subject.condition).toBe("C3");
    expect(normalized.subject.quality).toBe("Q4");
    expect(normalized.quality_flags.parser_notes).toContain("subject_analysis_filled_subject_condition");
    expect(normalized.quality_flags.parser_notes).toContain("subject_analysis_filled_subject_quality");
    expect(normalized.quality_flags.warnings).toContain("subject_condition_analysis_conflict");
  });

  it("tier 1 candidate does not require subject condition quality or comparable GLA", async () => {
    const normalized = validateNormalizedCase(redactCase(normalizeParsedXml(parseXml(tierOneOnlyXml), "tier-one.xml"), true));
    expect(normalized.subject.condition).toBeNull();
    expect(normalized.subject.quality).toBeNull();
    expect(normalized.comparables.some((comp) => comp.gla_sqft == null)).toBe(true);
    expect(normalized.quality_flags.tier_status.tier_1_reconciliation_explanation).toBe("candidate");
  });

  it("tier 2 needs review when subject condition quality or comparable GLA are missing", async () => {
    const normalized = validateNormalizedCase(redactCase(normalizeParsedXml(parseXml(tierOneOnlyXml), "tier-one.xml"), true));
    expect(normalized.quality_flags.tier_status.tier_2_sales_comparison_analysis).toBe("needs_review");
    expect(normalized.quality_flags.tier_reasons.tier_2_sales_comparison_analysis).toContain(
      "missing_subject_condition_or_quality"
    );
    expect(normalized.quality_flags.tier_reasons.tier_2_sales_comparison_analysis).toContain(
      "insufficient_comparable_gla_coverage"
    );
  });

  it("applies case repair overlays before missing-field validation", () => {
    const sourcePath = "tier-one-repaired.xml";
    const normalized = validateNormalizedCase(
      redactCase(
        normalizeParsedXml(parseXml(tierOneOnlyXml), sourcePath, new Date("2026-01-01T00:00:00.000Z"), {
          caseRepair: {
            version: 1,
            case_id: stableCaseId(sourcePath),
            source_file_id: null,
            reviewer: "Test",
            updated_at: "2026-01-01T00:00:00.000Z",
            repairs: [
              { target: "subject.condition", value: "C4", status: "applied" },
              { target: "subject.quality", value: "Q4", status: "applied" },
              { target: "comparables.gla_sqft", comp_index: 1, value: "1,650 sf", status: "applied" },
              { target: "reconciliation.narrative", value: "Synthetic repaired reconciliation.", status: "ignored" }
            ]
          }
        }),
        true
      )
    );

    expect(normalized.subject.condition).toBe("C4");
    expect(normalized.subject.quality).toBe("Q4");
    expect(normalized.comparables[0]?.gla_sqft).toBe(1650);
    expect(normalized.reconciliation.narrative).toBe("Synthetic tier one reconciliation.");
    expect(normalized.quality_flags.missing_fields).not.toContain("missing_subject_condition");
    expect(normalized.quality_flags.missing_fields).not.toContain("missing_subject_quality");
    expect(normalized.quality_flags.missing_fields).not.toContain("missing_comparable_gla");
    expect(normalized.quality_flags.parser_notes).toContain("repair_overlay_applied_subject_condition");
  });

  it("tier 3 needs review when candidate and rejected comp pool is missing", async () => {
    const normalized = await loadCase(gridFixture);
    expect(normalized.quality_flags.tier_status.tier_3_comp_selection).toBe("needs_review");
    expect(normalized.quality_flags.tier_reasons.tier_3_comp_selection).toContain(
      "candidate_or_rejected_comp_pool_unavailable"
    );
  });

  it("target tier 1 exports tier 1 candidates", async () => {
    const tempInput = await mkdtemp(path.join(os.tmpdir(), "tier1-input-"));
    const tempOutput = await mkdtemp(path.join(os.tmpdir(), "tier1-output-"));
    await writeFile(path.join(tempInput, "sample.xml"), tierOneOnlyXml, "utf8");

    await runCli({
      input: tempInput,
      output: tempOutput,
      evalRatio: 0,
      seed: 42,
      redact: true,
      includeNeedsReview: true,
      targetTier: "tier1"
    });

    const lines = (await readFile(path.join(tempOutput, "exports", "candidate_all.jsonl"), "utf8")).trim().split("\n").filter(Boolean);
    const manifest = JSON.parse(await readFile(path.join(tempOutput, "reports", "manifest.json"), "utf8"));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).metadata.target_tier).toBe("tier1");
    expect(JSON.parse(lines[0]!).metadata.quality_status).toBe("candidate");
    expect(manifest.target_tier).toBe("tier1");
    expect(manifest.tier_counts.tier_1_reconciliation_explanation.candidate).toBe(1);
  });

  it("CLI --repairs applies saved case repair overlays", async () => {
    const tempInput = await mkdtemp(path.join(os.tmpdir(), "repair-input-"));
    const tempOutput = await mkdtemp(path.join(os.tmpdir(), "repair-output-"));
    const tempRepairs = await mkdtemp(path.join(os.tmpdir(), "repair-overlays-"));
    const xmlPath = path.join(tempInput, "sample.xml");
    await writeFile(xmlPath, tierOneOnlyXml, "utf8");
    const caseId = stableCaseId(xmlPath);
    await writeFile(
      path.join(tempRepairs, `${caseId}.repair.json`),
      JSON.stringify(
        {
          version: 1,
          case_id: caseId,
          source_file_id: "sample.xml",
          reviewer: "Test",
          updated_at: "2026-01-01T00:00:00.000Z",
          repairs: [
            { target: "subject.condition", value: "C3", status: "applied" },
            { target: "subject.quality", value: "Q4", status: "applied" },
            { target: "comparables.gla_sqft", comp_index: 1, value: "1700", status: "applied" },
            { target: "comparables.adjusted_sale_price", comp_index: 1, value: "$106,000", status: "applied" },
            { target: "parser.path_selection", status: "needs_mapping", note: "Synthetic mapping task." }
          ]
        },
        null,
        2
      ),
      "utf8"
    );

    await runCli({
      input: tempInput,
      output: tempOutput,
      evalRatio: 0,
      seed: 42,
      redact: true,
      includeNeedsReview: true,
      repairs: tempRepairs
    });

    const normalized = JSON.parse(await readFile(path.join(tempOutput, "normalized", `${caseId}.json`), "utf8"));
    expect(normalized.subject.condition).toBe("C3");
    expect(normalized.subject.quality).toBe("Q4");
    expect(normalized.comparables[0].gla_sqft).toBe(1700);
    expect(normalized.comparables[0].adjusted_sale_price).toBe(106000);
    expect(normalized.quality_flags.parser_notes).toContain("repair_overlay_applied_4_fields");
    expect(normalized.quality_flags.warnings).not.toContain("repair_overlay_unknown_target_parser_path_selection");
  });

  it("target tier 2 does not export cases missing tier 2 fields", async () => {
    const tempInput = await mkdtemp(path.join(os.tmpdir(), "tier2-input-"));
    const tempOutput = await mkdtemp(path.join(os.tmpdir(), "tier2-output-"));
    await writeFile(path.join(tempInput, "sample.xml"), tierOneOnlyXml, "utf8");

    await runCli({
      input: tempInput,
      output: tempOutput,
      evalRatio: 0,
      seed: 42,
      redact: true,
      includeNeedsReview: true,
      targetTier: "tier2"
    });

    const output = await readFile(path.join(tempOutput, "exports", "candidate_all.jsonl"), "utf8");
    const manifest = JSON.parse(await readFile(path.join(tempOutput, "reports", "manifest.json"), "utf8"));
    expect(output.trim()).toBe("");
    expect(manifest.target_tier).toBe("tier2");
    expect(manifest.tier_counts.tier_2_sales_comparison_analysis.candidate).toBe(0);
  });

  it("adjusted sale price conflict audit writes private reports without private text", async () => {
    const tempInput = await mkdtemp(path.join(os.tmpdir(), "conflict-input-"));
    const tempMapping = await mkdtemp(path.join(os.tmpdir(), "conflict-mapping-"));
    await mkdir("private", { recursive: true });
    const tempOutput = await mkdtemp(path.join("private", "conflict-output-"));
    await writeFile(
      path.join(tempInput, "sample.xml"),
      `<?xml version="1.0" encoding="UTF-8"?>
<Root>
  <SubjectProperty>
    <StreetAddress>123 Conflict Test St</StreetAddress>
    <City>Exampleville</City>
    <State>IN</State>
    <GrossLivingArea>1800</GrossLivingArea>
    <Bedrooms>3</Bedrooms>
  </SubjectProperty>
  <ComparableSale>
    <CompId>1</CompId>
    <SalePrice>$100,000</SalePrice>
    <AdjustedSalePrice>$110,000</AdjustedSalePrice>
    <ManualAdjusted>$120,000</ManualAdjusted>
    <Adjustment>
      <Field>Condition</Field>
      <Amount>$10,000</Amount>
    </Adjustment>
  </ComparableSale>
  <Reconciliation>
    <FinalOpinionOfValue>$120,000</FinalOpinionOfValue>
    <Narrative>Synthetic conflict narrative.</Narrative>
  </Reconciliation>
</Root>`,
      "utf8"
    );
    const mappingPath = path.join(tempMapping, "mapping.json");
    await writeFile(
      mappingPath,
      JSON.stringify(
        {
          version: 1,
          mappings: {
            "comparables.adjusted_sale_price": [
              {
                path: "Root.ComparableSale.ManualAdjusted",
                strategy: "direct",
                verified: true,
                confidence: "manual_verified"
              }
            ]
          }
        },
        null,
        2
      ),
      "utf8"
    );

    await runConflictAudit({
      input: tempInput,
      mapping: mappingPath,
      output: tempOutput
    });

    const details = JSON.parse(await readFile(path.join(tempOutput, "conflict_details.json"), "utf8"));
    const serialized = JSON.stringify(details);
    expect(details.summary.total_conflicts).toBe(1);
    expect(details.summary.local_mapping_differed_from_built_in_values).toBe(1);
    expect(serialized).not.toContain("123 Conflict Test St");
    expect(serialized).not.toContain("Exampleville");
  });

  it("calculates arithmetic adjusted price from sale price plus net adjustment", () => {
    const result = arithmeticAdjustedSalePrice(
      makeComparable({
        sale_price: 100000,
        net_adjustment: 12500,
        adjustments: [
          { field: "GLA", amount: 999, description: null, raw_value: null }
        ]
      })
    );
    expect(result.value).toBe(112500);
    expect(result.source).toBe("net_adjustment");
  });

  it("calculates arithmetic adjusted price from sale price plus individual adjustment sum", () => {
    const result = arithmeticAdjustedSalePrice(
      makeComparable({
        sale_price: 100000,
        adjustments: [
          { field: "Condition", amount: 5000, description: null, raw_value: null },
          { field: "GLA", amount: -2500, description: null, raw_value: null }
        ]
      })
    );
    expect(result.value).toBe(102500);
    expect(result.source).toBe("individual_adjustment_sum");
    expect(result.sum_of_adjustment_amounts).toBe(2500);
  });

  it("arithmetic resolver keeps local adjusted price when local matches arithmetic and built-in does not", () => {
    const result = resolveAdjustedPriceConflict({
      policy: "arithmetic_resolver",
      comparable: makeComparable({
        sale_price: 100000,
        net_adjustment: 20000,
        adjusted_sale_price: 110000
      }),
      localValue: 120000,
      compIndex: 0,
      arithmeticValuesByIndex: [120000]
    });
    expect(result.value).toBe(120000);
    expect(result.selectedSource).toBe("local");
    expect(result.parserNotes).toContain("adjusted_price_conflict_resolved_arithmetic");
  });

  it("arithmetic resolver keeps built-in adjusted price when built-in matches arithmetic and local does not", () => {
    const result = resolveAdjustedPriceConflict({
      policy: "arithmetic_resolver",
      comparable: makeComparable({
        sale_price: 100000,
        net_adjustment: 20000,
        adjusted_sale_price: 120000
      }),
      localValue: 110000,
      compIndex: 0,
      arithmeticValuesByIndex: [120000]
    });
    expect(result.value).toBe(120000);
    expect(result.selectedSource).toBe("builtin");
    expect(result.parserNotes).toContain("adjusted_price_conflict_resolved_builtin");
  });

  it("builtin_wins policy keeps built-in adjusted price on conflict", () => {
    const result = resolveAdjustedPriceConflict({
      policy: "builtin_wins",
      comparable: makeComparable({
        sale_price: 100000,
        net_adjustment: 20000,
        adjusted_sale_price: 110000
      }),
      localValue: 120000,
      compIndex: 0,
      arithmeticValuesByIndex: [120000]
    });
    expect(result.value).toBe(110000);
    expect(result.selectedSource).toBe("builtin");
    expect(result.parserNotes).toContain("adjusted_price_conflict_resolved_builtin");
  });

  it("local_override policy keeps local adjusted price on conflict", () => {
    const result = resolveAdjustedPriceConflict({
      policy: "local_override",
      comparable: makeComparable({
        sale_price: 100000,
        net_adjustment: 20000,
        adjusted_sale_price: 110000
      }),
      localValue: 120000,
      compIndex: 0,
      arithmeticValuesByIndex: [120000]
    });
    expect(result.value).toBe(120000);
    expect(result.selectedSource).toBe("local");
    expect(result.parserNotes).toContain("adjusted_price_conflict_resolved_local");
  });

  it("disable_local policy ignores local adjusted sale price mapping", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Root>
  <SubjectProperty><PropertyType>Single family</PropertyType><City>Exampleville</City><State>IN</State></SubjectProperty>
  <ComparableSale>
    <CompId>1</CompId>
    <SalePrice>$100,000</SalePrice>
    <ManualAdjusted>$120,000</ManualAdjusted>
  </ComparableSale>
  <Reconciliation><FinalOpinionOfValue>$120,000</FinalOpinionOfValue><Narrative>Synthetic.</Narrative></Reconciliation>
</Root>`;
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "disable-local-"));
    const mappingPath = path.join(tempDir, "mapping.json");
    await writeFile(
      mappingPath,
      JSON.stringify({
        version: 1,
        mappings: {
          "comparables.adjusted_sale_price": [
            {
              path: "Root.ComparableSale.ManualAdjusted",
              strategy: "direct",
              verified: true,
              confidence: "manual_verified"
            }
          ]
        }
      }),
      "utf8"
    );

    const mappings = await loadLocalFieldMappings(mappingPath);
    const normalized = normalizeParsedXml(parseXml(xml), "disable-local.xml", new Date("2026-01-01T00:00:00.000Z"), {
      localFieldMappings: mappings,
      adjustedPriceConflictPolicy: "disable_local"
    });

    expect(normalized.comparables[0]?.adjusted_sale_price).toBeNull();
    expect(normalized.quality_flags.parser_notes).toContain("adjusted_price_local_mapping_disabled");
  });

  it("arithmetic_resolver flags unresolved when neither adjusted price matches arithmetic", () => {
    const result = resolveAdjustedPriceConflict({
      policy: "arithmetic_resolver",
      comparable: makeComparable({
        sale_price: 100000,
        net_adjustment: 30000,
        adjusted_sale_price: 110000
      }),
      localValue: 120000,
      compIndex: 0,
      arithmeticValuesByIndex: [130000]
    });
    expect(result.value).toBe(110000);
    expect(result.warnings).toContain("adjusted_price_conflict_unresolved");
    expect(result.classification.classifications).toContain("neither_matches_arithmetic");
  });

  it("adjusted price resolution audit detects possible index misalignment on synthetic fixture", async () => {
    const tempInput = await mkdtemp(path.join(os.tmpdir(), "resolution-input-"));
    const tempMapping = await mkdtemp(path.join(os.tmpdir(), "resolution-mapping-"));
    await mkdir("private", { recursive: true });
    const tempOutput = await mkdtemp(path.join("private", "resolution-output-"));
    await writeFile(
      path.join(tempInput, "sample.xml"),
      `<?xml version="1.0" encoding="UTF-8"?>
<Root>
  <SubjectProperty><PropertyType>Single family</PropertyType><City>Exampleville</City><State>IN</State></SubjectProperty>
  <ComparableSale>
    <CompId>1</CompId>
    <SalePrice>$100,000</SalePrice>
    <NetAdjustment>$20,000</NetAdjustment>
    <AdjustedSalePrice>$120,000</AdjustedSalePrice>
    <ManualAdjusted>$220,000</ManualAdjusted>
  </ComparableSale>
  <ComparableSale>
    <CompId>2</CompId>
    <SalePrice>$200,000</SalePrice>
    <NetAdjustment>$20,000</NetAdjustment>
    <AdjustedSalePrice>$220,000</AdjustedSalePrice>
    <ManualAdjusted>$120,000</ManualAdjusted>
  </ComparableSale>
  <Reconciliation><FinalOpinionOfValue>$170,000</FinalOpinionOfValue><Narrative>Synthetic.</Narrative></Reconciliation>
</Root>`,
      "utf8"
    );
    const mappingPath = path.join(tempMapping, "mapping.json");
    await writeFile(
      mappingPath,
      JSON.stringify({
        version: 1,
        mappings: {
          "comparables.adjusted_sale_price": [
            {
              path: "Root.ComparableSale.ManualAdjusted",
              strategy: "direct",
              verified: true,
              confidence: "manual_verified"
            }
          ]
        }
      }),
      "utf8"
    );

    await runAdjustedPriceResolutionAudit({
      input: tempInput,
      mapping: mappingPath,
      output: tempOutput
    });

    const alignment = JSON.parse(await readFile(path.join(tempOutput, "index_alignment_check.json"), "utf8"));
    const summary = JSON.parse(await readFile(path.join(tempOutput, "resolution_details.json"), "utf8")).summary;
    expect(alignment.summary.possible_index_misalignment).toBe(2);
    expect(summary.classification_counts.possible_index_misalignment).toBe(2);
  });

  it("candidate JSONL input_case still does not leak final value keys under adjusted price policy", async () => {
    const tempInput = await mkdtemp(path.join(os.tmpdir(), "leakage-policy-input-"));
    const tempOutput = await mkdtemp(path.join(os.tmpdir(), "leakage-policy-output-"));
    await writeFile(path.join(tempInput, "sample.xml"), tierOneOnlyXml, "utf8");

    await runCli({
      input: tempInput,
      output: tempOutput,
      evalRatio: 0,
      seed: 42,
      redact: true,
      includeNeedsReview: true,
      targetTier: "tier1",
      adjustedPriceConflictPolicy: "arithmetic_resolver"
    });

    const jsonl = await readFile(path.join(tempOutput, "exports", "candidate_all.jsonl"), "utf8");
    const line = JSON.parse(jsonl.trim());
    const userMessage = line.messages.find((message: { role: string }) => message.role === "user").content;
    expect(userMessage).not.toContain("final_opinion_of_value");
    expect(userMessage).not.toContain("final_value");
  });

  it("prepares review batch applies decisions and exports only approved cases", async () => {
    await mkdir("private", { recursive: true });
    const tempInput = await mkdtemp(path.join(os.tmpdir(), "review-e2e-input-"));
    const packetOutput = await mkdtemp(path.join(os.tmpdir(), "review-e2e-packets-"));
    const auditOutput = await mkdtemp(path.join("private", "review-e2e-audit-"));
    const batchOutput = await mkdtemp(path.join("private", "review-e2e-batch-"));
    const reviewedOutput = await mkdtemp(path.join("private", "review-e2e-reviewed-"));
    const approvedOutput = await mkdtemp(path.join("private", "review-e2e-approved-"));

    await writeFile(path.join(tempInput, "one.xml"), tierOneOnlyXml, "utf8");
    await writeFile(path.join(tempInput, "two.xml"), await readFile(gridFixture, "utf8"), "utf8");
    await writeFile(path.join(tempInput, "three.xml"), await readFile(uadFixture, "utf8"), "utf8");

    await runCli({
      input: tempInput,
      output: packetOutput,
      evalRatio: 0,
      seed: 42,
      redact: true,
      includeNeedsReview: true,
      emitReviewPackets: true,
      targetTier: "tier1"
    });
    await writeFile(
      path.join(auditOutput, "resolution_details.json"),
      JSON.stringify({ details: [] }, null, 2),
      "utf8"
    );

    await runPrepareReviewBatch({
      reviewPackets: path.join(packetOutput, "review_packets"),
      conflictAudit: auditOutput,
      output: batchOutput
    });

    const reviewPacketFiles = (await readdir(path.join(packetOutput, "review_packets")))
      .filter((file) => file.endsWith(".review.json"))
      .sort();
    expect(reviewPacketFiles.length).toBeGreaterThanOrEqual(3);
    const decisionCaseIds = reviewPacketFiles.slice(0, 3).map((file) => file.replace(".review.json", ""));
    const decisionsCsv = [
      "case_id,status,reviewer,reviewed_at,notes",
      `${decisionCaseIds[0]},approved,Synthetic Reviewer,2026-01-01T00:00:00.000Z,approved synthetic case`,
      `${decisionCaseIds[1]},rejected,Synthetic Reviewer,2026-01-01T00:00:00.000Z,rejected synthetic case`,
      `${decisionCaseIds[2]},needs_revision,Synthetic Reviewer,2026-01-01T00:00:00.000Z,needs revision synthetic case`
    ].join("\n");
    const decisionsPath = path.join(batchOutput, "review_decisions.csv");
    await writeFile(decisionsPath, `${decisionsCsv}\n`, "utf8");

    await runApplyReviewDecisions({
      reviewPackets: path.join(packetOutput, "review_packets"),
      decisions: decisionsPath,
      output: reviewedOutput
    });
    await runApprovedExport({
      reviewed: reviewedOutput,
      output: approvedOutput,
      evalRatio: 0,
      seed: 42
    });

    const batchIndex = await readFile(path.join(batchOutput, "review_index.md"), "utf8");
    const batchPrivacy = JSON.parse(await readFile(path.join(batchOutput, "privacy_audit.json"), "utf8"));
    const applyManifest = JSON.parse(await readFile(path.join(reviewedOutput, "review_apply_manifest.json"), "utf8"));
    const approvedManifest = JSON.parse(await readFile(path.join(approvedOutput, "reports", "approved_manifest.json"), "utf8"));
    const approvedLines = (await readFile(path.join(approvedOutput, "exports", "all.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean);

    expect(batchIndex).toContain("No cases are auto-approved");
    expect(batchPrivacy.auto_approved_cases).toBe(0);
    expect(applyManifest.counts.approved).toBe(1);
    expect(applyManifest.counts.rejected).toBe(1);
    expect(applyManifest.counts.needs_revision).toBe(1);
    expect(approvedManifest.counts.approved_cases).toBe(1);
    expect(approvedLines).toHaveLength(1);

    const approvedLine = JSON.parse(approvedLines[0] ?? "{}");
    expect(approvedLine.metadata.case_id).toBe(decisionCaseIds[0]);
    const userMessage = approvedLine.messages.find((message: { role: string }) => message.role === "user").content;
    expect(userMessage).not.toContain("final_opinion_of_value");
    expect(userMessage).not.toContain("final_value");
    expect(approvedLine.metadata.case_id).not.toBe(decisionCaseIds[1]);
    expect(approvedLine.metadata.case_id).not.toBe(decisionCaseIds[2]);
  });

  it("review UI data builder creates simplified case cards", () => {
    const state = buildReviewUiState({
      packets: [reviewPacketFromXml(tierOneOnlyXml)],
      auditDetails: [],
      generatedAt: new Date("2026-01-01T00:00:00.000Z")
    });

    expect(state.cases).toHaveLength(1);
    expect(state.cases[0]?.comps[0]?.sale_price).toBe(100000);
    expect(state.cases[0]?.recommendation.level).toBe("green");
    expect(state.cases[0]?.training_example.input_case).toBeDefined();
  });

  it("review UI recommendation logic returns green yellow and red", () => {
    const base = {
      tier1Status: "candidate",
      finalValue: 100000,
      narrative: "Synthetic narrative.",
      comparableCount: 1,
      adjustedPresent: true,
      manualAdjustedRows: 0,
      unresolvedAdjustedRows: 0,
      warnings: [],
      missingFields: [],
      inputLeakage: false,
      privacy: { email: 0, phone: 0, full_street_address: 0, private_name_label: 0, license_or_private_id: 0 }
    };

    expect(recommendCase(base).level).toBe("green");
    expect(recommendCase({ ...base, manualAdjustedRows: 1 }).level).toBe("yellow");
    expect(recommendCase({ ...base, comparableCount: 0 }).level).toBe("red");
  });

  it("review UI flags adjusted-price local-filled rows", () => {
    const packet = reviewPacketFromXml(tierOneOnlyXml);
    const state = buildReviewUiState({
      packets: [packet],
      auditDetails: [
        {
          case_id: packet.case_id,
          comp_id: "1",
          comp_index: 1,
          classifications: ["local_filled_missing_builtin", "no_arithmetic_check_available"]
        }
      ]
    });

    expect(state.cases[0]?.comps[0]?.adjusted_price_source).toBe("local-filled");
    expect(state.cases[0]?.comps[0]?.needs_manual_attention).toBe(true);
    expect(state.cases[0]?.recommendation.level).toBe("yellow");
  });

  it("review UI does not treat resolved built-in adjusted-price conflicts as unresolved", () => {
    const packet = reviewPacketFromXml(tierOneOnlyXml);
    const state = buildReviewUiState({
      packets: [packet],
      auditDetails: [
        {
          case_id: packet.case_id,
          comp_id: "1",
          comp_index: 1,
          classifications: ["builtin_matches_arithmetic", "possible_index_misalignment"],
          values_conflict: true,
          possible_index_misalignment: true
        }
      ]
    });

    expect(state.cases[0]?.comps[0]?.adjusted_price_source).toBe("built-in");
    expect(state.cases[0]?.comps[0]?.adjusted_price_badge).toBe("Conflict resolved by built-in");
    expect(state.cases[0]?.comps[0]?.needs_manual_attention).toBe(false);
    expect(state.cases[0]?.recommendation.level).toBe("green");
  });

  it("review UI decisions CSV is written correctly", () => {
    const csv = decisionsToCsv(
      [
        {
          case_id: "case_1",
          status: "approved",
          reviewer: "Synthetic Reviewer",
          reviewed_at: "2026-01-01T00:00:00.000Z",
          notes: "Good case"
        },
        {
          case_id: "case_2",
          status: "skipped",
          reviewer: "Synthetic Reviewer",
          reviewed_at: "2026-01-01T00:00:00.000Z",
          notes: "Look later, maybe"
        }
      ],
      ["case_1", "case_2", "case_3"]
    );

    expect(csv).toContain("case_id,status,reviewer,reviewed_at,notes");
    expect(csv).toContain("case_1,approved");
    expect(csv).toContain('case_2,skipped,Synthetic Reviewer,2026-01-01T00:00:00.000Z,"Look later, maybe"');
    expect(csv).toContain("case_3,,,,");
  });

  it("review UI bulk approve only affects green cases", () => {
    const green = buildReviewUiState({ packets: [reviewPacketFromXml(tierOneOnlyXml, "green.xml")], auditDetails: [] });
    const yellowPacket = reviewPacketFromXml(tierOneOnlyXml, "yellow.xml");
    const yellow = buildReviewUiState({
      packets: [yellowPacket],
      auditDetails: [
        {
          case_id: yellowPacket.case_id,
          comp_id: "1",
          comp_index: 1,
          classifications: ["local_filled_missing_builtin"]
        }
      ]
    });
    const state = {
      ...green,
      cases: [...green.cases, ...yellow.cases],
      progress: green.progress,
      privacy: green.privacy
    };

    const decisions = bulkApproveGreenCases(state, [], "Synthetic Reviewer", new Date("2026-01-01T00:00:00.000Z"));
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.case_id).toBe(green.cases[0]?.case_id);
    expect(decisions[0]?.status).toBe("approved");
  });

  it("review UI requires notes for needs_revision and rejected decisions", () => {
    expect(
      validateDecisionDraft({
        case_id: "case_1",
        status: "needs_revision",
        notes: ""
      })
    ).toContain("Notes are required for Needs Fix and Reject.");
    expect(
      validateDecisionDraft({
        case_id: "case_1",
        status: "rejected",
        notes: "Bad extraction"
      })
    ).toEqual([]);
  });

  it("review UI cards do not leak final value into input_case", () => {
    const state = buildReviewUiState({
      packets: [reviewPacketFromXml(tierOneOnlyXml)],
      auditDetails: []
    });

    expect(state.cases[0]?.final_value_leakage).toBe(false);
    expect(JSON.stringify(state.cases[0]?.training_example.input_case)).not.toContain("final_opinion_of_value");
  });

  it("review UI privacy audit flags email phone and full-address patterns", () => {
    const scan = scanPrivacyRisk({
      email: "test@example.invalid",
      phone: "317-555-0100",
      address: "123 Main St"
    });

    expect(scan.email).toBeGreaterThan(0);
    expect(scan.phone).toBeGreaterThan(0);
    expect(scan.full_street_address).toBeGreaterThan(0);
  });

  it("workbench state summarizes the local appraisal workflow", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "appraisal-workbench-"));
    const privateRoot = path.join(workspaceRoot, "private");
    const trainingOutput = path.join(privateRoot, "appraisal-training-tier1-builtin-wins");
    const reviewPackets = path.join(trainingOutput, "review_packets");
    const reports = path.join(trainingOutput, "reports");
    const reviewBatch = path.join(privateRoot, "tier1-human-review-batch");
    const sessionOutput = path.join(privateRoot, "tier1-review-session");
    const conflictAudit = path.join(privateRoot, "appraisal-adjusted-price-resolution-audit");
    const inspection = path.join(privateRoot, "appraisal-xml-inspection-real");
    const mappingReview = path.join(privateRoot, "appraisal-mapping-review");
    const mappingValidation = path.join(privateRoot, "appraisal-mapping-validation");
    const approvedExport = path.join(privateRoot, "approved-training-export");

    async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    }

    await writeJsonFile(path.join(reports, "manifest.json"), {
      run_id: "run_test",
      input_folder: path.join(privateRoot, "xmls"),
      redaction_enabled: true,
      target_tier: "tier1",
      counts: { xml_files_found: 2, parsed: 2, candidate: 1, needs_review: 1, rejected: 0 },
      tier_counts: { tier_1_reconciliation_explanation: { candidate: 1, needs_review: 1, rejected: 0 } },
      adjusted_price_conflict_policy: "builtin_wins",
      adjusted_price_conflict_stats: { conflicts_count: 1 },
      warnings_by_type: { missing_subject_condition: 2, parse_path_low_confidence: 1 }
    });
    await writeJsonFile(path.join(reports, "field_coverage.json"), [
      { field: "subject.condition", coverage_pct: 0 },
      { field: "comparables.adjusted_sale_price", coverage_pct: 100 }
    ]);
    await writeJsonFile(path.join(privateRoot, "appraisal-field-mapping.local.json"), {
      version: 1,
      mappings: {
        "comparables.adjusted_sale_price": [
          {
            path: "Root.AdjustedSalesPriceAmount",
            strategy: "direct",
            verified: true,
            confidence: "manual_verified"
          }
        ]
      }
    });
    await writeJsonFile(path.join(mappingReview, "mapping_review_packets.json"), {
      packets: [
        {
          target: "comparables.adjusted_sale_price",
          candidates: [
            {
              path: "Root.AdjustedSalesPriceAmount",
              score: 1,
              context: "comparable_context",
              recommendation: "likely_accept",
              value_shape_summary: { dominant_shape: "currency" }
            }
          ]
        }
      ]
    });
    await writeJsonFile(path.join(mappingValidation, "mapping_validation.json"), {
      xml_files_found: 2,
      parsed: 2,
      parse_failures: 0,
      verified_mappings_loaded: 1,
      coverage_before: [{ field: "comparables.adjusted_sale_price", coverage_pct: 50 }],
      coverage_with_mapping: [{ field: "comparables.adjusted_sale_price", coverage_pct: 100 }],
      mapping_applications: [
        {
          field: "comparables.adjusted_sale_price",
          path: "Root.AdjustedSalesPriceAmount",
          value_count: 2,
          filled_count: 1,
          conflict_count: 0
        }
      ]
    });
    await writeJsonFile(path.join(inspection, "grid_inventory.json"), [{ row_label: "gla" }]);
    await writeJsonFile(path.join(inspection, "safe_value_profile.json"), [{ field: "comparables.gla_sqft" }]);
    await writeJsonFile(path.join(inspection, "privacy_audit.json"), { privacy_pattern_total: 0 });
    await writeJsonFile(path.join(reviewBatch, "privacy_audit.json"), { privacy_pattern_total: 0 });
    await writeJsonFile(path.join(sessionOutput, "privacy_audit.json"), {
      raw_xml_included: false,
      privacy_pattern_counts: { email: 0, phone: 0 },
      final_value_leakage_cases: 0
    });
    await writeJsonFile(path.join(conflictAudit, "index_alignment_check.json"), { possible_index_misalignment: 1 });
    await writeJsonFile(path.join(approvedExport, "reports", "approved_manifest.json"), {
      counts: { approved_cases: 1, train_lines: 1, eval_lines: 0 }
    });
    await mkdir(path.join(approvedExport, "exports"), { recursive: true });
    await writeFile(path.join(approvedExport, "exports", "train.jsonl"), "{}\n", "utf8");
    await writeFile(path.join(approvedExport, "exports", "eval.jsonl"), "", "utf8");
    await writeFile(path.join(approvedExport, "exports", "all.jsonl"), "{}\n", "utf8");
    await mkdir(reviewPackets, { recursive: true });
    await writeFile(path.join(reviewPackets, "case_1.review.json"), "{}", "utf8");

    const workbench = await buildWorkbenchState(
      {
        reviewBatch,
        reviewPackets,
        conflictAudit,
        output: sessionOutput,
        workspaceRoot
      },
      {
        total: 2,
        reviewed: 1,
        approved: 1,
        needs_revision: 0,
        rejected: 0,
        skipped: 0,
        unreviewed: 1,
        green: 1,
        yellow: 1,
        red: 0,
        adjusted_price_rows_needing_attention: 0
      },
      { email: 0, phone: 0, full_street_address: 0, private_name_label: 0, license_or_private_id: 0 }
    );

    expect(workbench.intake.xml_files_found).toBe(2);
    expect(workbench.mapping.verified_count).toBe(1);
    expect(workbench.mapping.review_targets[0]?.likely_accept).toBe(1);
    expect(workbench.mapping.validation.target_coverage).toContainEqual({
      field: "comparables.adjusted_sale_price",
      before_pct: 50,
      after_pct: 100,
      delta_pct: 50
    });
    expect(workbench.export.all_lines).toBe(1);
    expect(workbench.review.packet_files).toBe(1);
    expect(workbench.stages.find((stage) => stage.id === "audit")?.status).toBe("ready");
  });

  it("discovery command creates safe candidate files", async () => {
    const tempInput = await mkdtemp(path.join(os.tmpdir(), "discovery-input-"));
    const tempOutput = await mkdtemp(path.join(os.tmpdir(), "discovery-output-"));
    await writeFile(path.join(tempInput, "sample.xml"), await readFile(weirdFixture, "utf8"), "utf8");

    await runFieldDiscovery({
      input: tempInput,
      output: tempOutput,
      targets: ["subject.condition", "subject.quality", "comparables.gla_sqft"],
      safeValueProfile: true
    });

    const candidates = JSON.parse(await readFile(path.join(tempOutput, "target_field_candidates.json"), "utf8"));
    const template = JSON.parse(
      await readFile(path.join(tempOutput, "proposed-field-mapping.local.template.json"), "utf8")
    );
    const privacyAudit = JSON.parse(await readFile(path.join(tempOutput, "privacy_audit.json"), "utf8"));
    const serialized = JSON.stringify({ candidates, template });

    expect(candidates["subject.condition"].length).toBeGreaterThan(0);
    expect(template.mappings["subject.condition"][0].verified).toBe(false);
    expect(privacyAudit.raw_values_exported).toBe(false);
    expect(privacyAudit.safe_value_shapes_only).toBe(true);
    expect(serialized).not.toContain("Synthetic Mapping Way");
  });

  it("mapping validation reports coverage improvements", async () => {
    const tempInput = await mkdtemp(path.join(os.tmpdir(), "validation-input-"));
    const tempOutput = await mkdtemp(path.join(os.tmpdir(), "validation-output-"));
    const mappingPath = await writeSyntheticVerifiedMapping(tempInput);
    await writeFile(path.join(tempInput, "sample.xml"), await readFile(weirdFixture, "utf8"), "utf8");

    await runMappingValidation({
      input: tempInput,
      mapping: mappingPath,
      output: tempOutput
    });

    const coverage = JSON.parse(await readFile(path.join(tempOutput, "coverage_with_mapping.json"), "utf8"));
    const privacyAudit = JSON.parse(await readFile(path.join(tempOutput, "privacy_audit.json"), "utf8"));
    const condition = coverage.find((row: { field: string }) => row.field === "subject.condition");
    const compGla = coverage.find((row: { field: string }) => row.field === "comparables.gla_sqft");
    expect(condition.coverage_delta_pct).toBeGreaterThan(0);
    expect(compGla.coverage_delta_pct).toBeGreaterThan(0);
    expect(privacyAudit.raw_values_exported).toBe(false);
    expect(privacyAudit.safe_value_shapes_only).toBe(true);
  });

  it("main pipeline can run with a verified local mapping", async () => {
    const tempInput = await mkdtemp(path.join(os.tmpdir(), "pipeline-mapping-input-"));
    const tempOutput = await mkdtemp(path.join(os.tmpdir(), "pipeline-mapping-output-"));
    const mappingPath = await writeSyntheticVerifiedMapping(tempInput);
    await writeFile(path.join(tempInput, "sample.xml"), await readFile(weirdFixture, "utf8"), "utf8");

    await runCli({
      input: tempInput,
      output: tempOutput,
      evalRatio: 0,
      seed: 42,
      redact: true,
      includeNeedsReview: true,
      emitReviewPackets: true,
      mapping: mappingPath
    });

    const warnings = JSON.parse(await readFile(path.join(tempOutput, "reports", "warnings.json"), "utf8"));
    expect(warnings[0].parser_notes).toContain("local_mapping_filled_subject_condition");
    expect(warnings[0].parser_notes).toContain("local_mapping_filled_comparables_gla_sqft");
  });
});

async function writeSyntheticVerifiedMapping(folder: string): Promise<string> {
  const mappingPath = path.join(folder, "field-mapping.local.json");
  await writeFile(
    mappingPath,
    JSON.stringify(
      {
        version: 1,
        mappings: {
          "subject.condition": [
            {
              path: "VendorValuationEnvelope.VendorSubjectRatings.CondCode",
              strategy: "direct",
              confidence: "manual_verified"
            }
          ],
          "subject.quality": [
            {
              path: "VendorValuationEnvelope.VendorSubjectRatings.QualCode",
              strategy: "direct",
              verified: true
            }
          ],
          "comparables.gla_sqft": [
            {
              path: "VendorValuationEnvelope.VendorSales.SaleRecord.Metrics.VendorLivingSqFt",
              strategy: "direct",
              verified: true
            }
          ]
        }
      },
      null,
      2
    ),
    "utf8"
  );
  return mappingPath;
}
