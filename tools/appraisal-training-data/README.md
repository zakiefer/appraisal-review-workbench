# Appraisal XML Training Data Prep

This tool converts local appraisal XML files into normalized appraisal cases, candidate supervised training cases, candidate JSONL exports, and audit reports.

It is designed as a first-pass data-prep foundation for historical appraisal XMLs that may be UAD-like, MISMO-like, appraisal software exports, or another structured XML variant.

## What It Does

- Recursively reads `.xml` files from a local input folder.
- Parses namespaced and nested XML with a resilient first-pass parser.
- Normalizes subject, market, selected comparable, adjustment, reconciliation, and comment fields into a consistent schema.
- Redacts sensitive/private fields by default.
- Validates each normalized case as `candidate`, `needs_review`, or `rejected`.
- Builds supervised examples for the task `explain_selected_comps_adjustments_and_reconciliation`.
- Prevents `final_opinion_of_value` from leaking into `input_case`.
- Exports `candidate_train.jsonl`, `candidate_eval.jsonl`, and `candidate_all.jsonl`.
- Writes `manifest.json`, `warnings.json`, and `summary.md`.

## What It Does Not Do

- It does not fine-tune a model.
- It does not call OpenAI, Anthropic, Google, AWS, MLS, county, or any external API.
- It does not upload appraisal data anywhere.
- It does not create approved production training data.
- It does not replace review by a licensed appraiser.
- It does not claim complete UAD or MISMO coverage.

## Why XML

XML exports often preserve structured appraisal fields that PDFs flatten or obscure: subject characteristics, comparable sales, grid adjustments, reconciliation values, and appraiser narratives. This tool uses that structure to create auditable candidate examples while preserving warnings for missing or low-confidence mappings.

## Run It

Install dependencies once:

```bash
npm install
```

Inspect XML shape without exporting values:

```bash
npm run appraisal:inspect-xml -- \
  --input ./private/appraisal-xmls-sample \
  --output ./private/appraisal-xml-inspection
```

Optionally include a sanitized value profile for whitelisted low-risk appraisal attributes:

```bash
npm run appraisal:inspect-xml -- \
  --input ./private/appraisal-xmls-sample \
  --output ./private/appraisal-xml-inspection \
  --safe-value-profile true
```

Run against local XMLs:

```bash
npm run appraisal:training-data -- \
  --input ./private/appraisal-xmls \
  --output ./private/appraisal-training-output \
  --eval-ratio 0.2 \
  --seed 42 \
  --redact true \
  --include-needs-review true \
  --emit-review-packets true
```

Useful options:

- `--input`: required folder containing XML files.
- `--output`: required folder for generated artifacts.
- `--eval-ratio`: optional, defaults to `0.2`.
- `--seed`: optional, defaults to `42`.
- `--redact`: optional, defaults to `true`.
- `--include-needs-review`: optional, defaults to `false`. When true, `needs_review` cases are included in candidate JSONL exports.

## Output Files

```text
output/
  normalized/
    <case_id>.json
  training_cases/
    <case_id>.json
  exports/
    candidate_train.jsonl
    candidate_eval.jsonl
    candidate_all.jsonl
  reports/
    manifest.json
    summary.md
    warnings.json
    field_coverage.json
    field_coverage.md
  review_packets/
    <case_id>.review.json
```

The word `candidate` is intentional. These files are not approved for fine-tuning until a human appraiser reviews them.

## Redaction

Redaction is enabled by default. The tool attempts to redact:

- Full street addresses and street numbers.
- Full postal codes.
- Emails and phone numbers.
- Obvious borrower/client/appraiser names in labeled text.
- Obvious license numbers.
- Obvious internal private identifiers.

The tool preserves useful market-level geography where possible, including city, state, county, and generic neighborhood names. If address parsing is uncertain, it redacts more aggressively and adds a warning.

## Leakage Prevention

The current supervised task is:

```text
explain_selected_comps_adjustments_and_reconciliation
```

For this task, `input_case` contains metadata, subject data, market data, selected comparables, and context. It does not contain `final_opinion_of_value` or reconciliation narrative. The final opinion and reconciliation narrative live in `expert_answer`.

Adjusted sale prices may remain in `input_case` because the task is to explain selected comps, adjustment logic, and reconciliation from an existing comp grid. This does not teach full comparable selection unless the XML contains a candidate/rejected comp pool.

## Candidate Vs Approved Data

`candidate`: enough structure exists for a plausible example, subject to human review.

`needs_review`: parsed successfully but has missing fields, parser uncertainty, or notable warnings.

`rejected`: no usable appraisal signal was found, or parsing failed badly.

The CLI does not create production `train.jsonl` or `eval.jsonl` files. It only creates candidate exports.

`candidate_all.jsonl` is not ready for fine-tuning by itself. A later review workflow should promote reviewed cases from `candidate` or `needs_review` to an explicit approved state. Only approved cases should be used for final fine-tuning datasets.

## XML Shape Inspection

The inspection command is for parser calibration. It writes:

```text
private/appraisal-xml-inspection/
  tag_inventory.json
  path_inventory.json
  likely_field_matches.json
  grid_inventory.json
  grid_inventory.md
  safe_value_profile.json
  summary.md
```

These reports contain tag names, paths, counts, likely normalized-field matches, and safe grid row labels. They intentionally do not include raw XML text, source filenames, addresses, names, phone numbers, emails, signatures, or license numbers.

`safe_value_profile.json` is written only when `--safe-value-profile true` is used. It includes sanitized samples only for whitelisted low-risk values such as condition/quality codes, dates, square-footage numbers, prices, and adjustment amounts. Private-looking values are skipped.

Use inspection before editing aliases for a new XML vendor format:

1. Place a small real sample in `./private/appraisal-xmls-sample/`.
2. Run `npm run appraisal:inspect-xml`.
3. Open `likely_field_matches.json` and `path_inventory.json`.
4. Add missing aliases to `src/fieldAliases.ts`.
5. Re-run the main pipeline and compare `reports/field_coverage.md`.

## Field Discovery Workbench

Use field discovery when a normalized field is still missing and you need safe candidate paths:

```bash
npm run appraisal:discover-fields -- \
  --input ./private/appraisal-xmls-sample \
  --output ./private/appraisal-field-discovery \
  --targets subject.condition,subject.quality,comparables.condition,comparables.quality,comparables.gla_sqft,comparables.sale_date,comparables.adjusted_sale_price \
  --safe-value-profile true
```

The command writes:

```text
private/appraisal-field-discovery/
  discovery_summary.md
  discovery_candidates.json
  target_field_candidates.json
  unmapped_paths.json
  value_shape_profile.json
  privacy_audit.json
  proposed-field-mapping.local.template.json
```

Discovery reports contain paths, scores, value-shape categories, sanitized buckets, and candidate mappings only. They do not include raw XML values.

The value-shape profiler classifies values as categories such as `condition_code`, `quality_code`, `numeric`, `currency`, `date`, `address_like_private_risk`, `email_private_risk`, or `phone_private_risk`. Sanitized samples are limited to safe values such as `C3`, `Q4`, square-footage buckets, date formats, and currency buckets.

## Mapping Review Workbench

Use mapping review after discovery to create human-review packets before creating a verified local mapping file:

```bash
npm run appraisal:review-mappings -- \
  --input ./private/appraisal-xmls-sample \
  --discovery ./private/appraisal-field-discovery \
  --output ./private/appraisal-mapping-review \
  --targets subject.condition,subject.quality,comparables.condition,comparables.quality,comparables.gla_sqft,comparables.sale_date,comparables.adjusted_sale_price
```

The command writes:

```text
private/appraisal-mapping-review/
  mapping_review_summary.md
  mapping_review_packets.json
  proposed_verified_mapping.template.json
  rejected_candidate_notes.md
  privacy_audit.json
```

Review packets include path names, semantic context labels, recommendation labels, value-shape categories, sanitized buckets, occurrence counts, review questions, and unverified suggested mapping entries. They do not include raw XML values by default.

The review command distinguishes subject-level and comparable-level condition/quality targets. For example, comparable-level `GSEOverallConditionType` should be reviewed for `comparables.condition`, not copied to `subject.condition`.

For local-only semantic verification, an optional private-value review file can be generated:

```bash
npm run appraisal:review-mappings -- \
  --input ./private/appraisal-xmls-sample \
  --discovery ./private/appraisal-field-discovery \
  --output ./private/appraisal-mapping-review-private \
  --targets subject.condition,subject.quality,comparables.condition,comparables.quality,comparables.gla_sqft,comparables.sale_date,comparables.adjusted_sale_price \
  --allow-private-value-review true
```

This mode refuses outputs outside `./private/`, never prints raw values to the terminal, writes `private_value_review.json`, redacts obvious emails, phone numbers, street addresses, names, parcel/loan/license IDs, and truncates long text. Treat that file as private local review material only.

## Local Mapping Overrides

Manual mapping overrides belong in:

```text
private/appraisal-field-mapping.local.json
```

This file is ignored by git because it lives under `private/`. The pipeline ignores unverified candidate mappings. It only uses entries with `verified: true` or `confidence: "manual_verified"`.

Example:

```json
{
  "version": 1,
  "mappings": {
    "subject.condition": [
      {
        "path": "Some.Real.Xml.Path.ConditionRating",
        "strategy": "direct",
        "confidence": "manual_verified"
      }
    ],
    "comparables.condition": [
      {
        "path": "Some.Real.Xml.Path.Comparable.ConditionRating",
        "strategy": "direct",
        "verified": true
      }
    ],
    "comparables.quality": [
      {
        "path": "Some.Real.Xml.Path.Comparable.QualityRating",
        "strategy": "direct",
        "verified": true
      }
    ],
    "comparables.gla_sqft": [
      {
        "path": "Some.Real.Xml.Path.Comparable.GrossLivingArea",
        "strategy": "direct",
        "verified": true
      }
    ]
  }
}
```

To validate a mapping file without exporting JSONL:

```bash
npm run appraisal:validate-mapping -- \
  --input ./private/appraisal-xmls-sample \
  --mapping ./private/appraisal-field-mapping.local.json \
  --output ./private/appraisal-mapping-validation
```

To run the main redacted pipeline with verified mappings:

```bash
npm run appraisal:training-data -- \
  --input ./private/appraisal-xmls-sample \
  --output ./private/appraisal-training-sample-output \
  --redact true \
  --include-needs-review true \
  --emit-review-packets true \
  --mapping ./private/appraisal-field-mapping.local.json
```

Direct built-in extraction still wins unless the local mapping is `manual_verified`. Conflicts are reported as warnings.

## Grid Extraction

Some appraisal XMLs represent sales comparison data as row/column grids instead of simple nested comparable objects. The parser includes conservative grid fallback extraction for:

- condition and quality rows
- gross living area / GLA rows
- sale date rows
- sale price and adjusted sale price rows
- net/gross adjustment rows
- bedroom, bathroom, year-built, site, view, and location rows

Direct aliases and comparable-object fields win over grid guesses. Grid rows only fill missing fields, and conflicts are recorded as warnings.

## Field Coverage

Every main pipeline run writes:

- `reports/field_coverage.json`
- `reports/field_coverage.md`

Field coverage shows how often important normalized fields were populated. Low-coverage rows are the best signal for where parser aliases need work before any fine-tuning discussion.

If an earlier `field_coverage.json` exists in the same output folder, the next run includes previous coverage and delta columns in `field_coverage.md`.

Example:

```text
| subject.gla_sqft | 8 | 2 | 80.0% |
| reconciliation.final_opinion_of_value | 3 | 7 | 30.0% |
```

## Add New XML Mappings

Most extraction aliases live in `src/fieldAliases.ts`. To support a new vendor export:

1. Run the safe inspection command on a small private sample.
2. Add tag/path aliases for subject, market, comparable, adjustment, reconciliation, or comment fields.
3. Add a synthetic fixture that resembles the structure without real data when test coverage needs it.
4. Add or update tests under `tests/`.
5. Run `npm run test:appraisal-training-data`.
6. Run the CLI on synthetic fixtures before using private inputs.

Do not commit real appraisal XMLs or generated private outputs.

## Review Packets

Pass `--emit-review-packets true` to write unreviewed review packets:

```text
review_packets/
  <case_id>.review.json
```

Each packet contains the redacted normalized case, proposed training case, warnings, missing fields, a review checklist, and:

```json
{
  "status": "unreviewed",
  "reviewer": null,
  "reviewed_at": null,
  "notes": null
}
```

These packets are not approved. They are a file-based foundation for qualified appraiser review.

## Approved Export

Only approved review packets can produce final `train.jsonl`, `eval.jsonl`, and `all.jsonl`:

```bash
npm run appraisal:export-approved -- \
  --reviewed ./private/reviewed-appraisal-cases \
  --output ./private/approved-training-export \
  --eval-ratio 0.2 \
  --seed 42
```

The approved exporter includes only packets where `reviewer_decision.status` is `"approved"`. If no approved packets exist, it writes empty approved export files and a clear manifest without crashing.

## Private File Safety

Keep real files under `./private/`, which is gitignored. Recommended sample layout:

```text
private/
  appraisal-xmls-sample/
    sample-1.xml
  appraisal-training-sample-output/
  appraisal-xml-inspection/
```

When the main CLI runs on an input under `private/`, it prints a private-data warning. Redaction is enabled by default. If `--redact false` is passed, the CLI refuses to run unless `--allow-unredacted-output` is also provided.

## Inspect Warnings

Review:

- `reports/summary.md` for counts and top warnings.
- `reports/warnings.json` for per-case warning details.
- `reports/manifest.json` for run metadata and rejected file reasons.

Common warnings:

- `missing_subject_gla`: subject gross living area was not found.
- `missing_subject_condition`: subject condition was not found.
- `missing_comparable_sale_price`: at least one comparable is missing sale price.
- `missing_adjusted_sale_price`: at least one comparable is missing adjusted sale price.
- `missing_final_opinion_of_value`: final value was not found.
- `selected_comps_only_candidate_pool_unavailable`: selected comps were found, but no broader candidate/rejected comp pool was detected.
- `redaction_uncertain`: a field looked private but did not match a confident pattern, so it was aggressively masked.
- `unknown_xml_format`: detector could not classify the XML.
- `reconciliation_narrative_missing`: reconciliation narrative was not found.
- `parse_path_low_confidence`: expected high-level sections were not found by alias.
- `missing_subject_gla_no_alias_matched`: no configured alias populated subject GLA.
- `missing_final_value_no_alias_matched`: no configured alias populated final opinion of value.
- `comparable_adjustments_empty`: selected comps were found but adjustment lines were not extracted.

## Synthetic Fixtures

Fake fixtures live in `fixtures/`:

- `synthetic-uad-like-appraisal.xml`
- `synthetic-generic-appraisal.xml`

Run the pipeline against them:

```bash
npm run appraisal:training-data -- \
  --input tools/appraisal-training-data/fixtures \
  --output appraisal-training-output \
  --eval-ratio 0.5 \
  --seed 42 \
  --include-needs-review true
```

## Appraiser Review Checklist

Before using any candidate JSONL for fine-tuning or evals, a qualified reviewer should verify:

- Private data is redacted.
- Subject and comparable fields mapped correctly.
- Adjustments and narratives are faithful to the source XML.
- Warnings are understood and acceptable.
- The example is suitable for explaining selected comps, adjustments, reconciliation, and caveats.
- The example does not imply autonomous valuation or replacement of licensed appraisal judgment.
