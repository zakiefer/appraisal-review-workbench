import { readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { assertReadableDirectory, assertWritableOutput, ensureDir, writeJson } from "./fileUtils.js";
import { assertPrivateOutput, loadAdjustedPriceAuditDetails, loadReviewPackets, parseDecisionCsv } from "./reviewWorkflow.js";
import {
  buildReviewUiState,
  bulkApproveGreenCases,
  decisionsToCsv,
  decisionsToJson,
  normalizeDecisionDraft,
  privacyTotal,
  type ReviewDecisionDraft,
  type ReviewUiState
} from "./reviewUiData.js";
import type { DecisionRow } from "./reviewWorkflow.js";
import { buildWorkbenchState } from "./workbenchData.js";

interface ReviewUiOptions {
  reviewBatch: string;
  reviewPackets: string;
  conflictAudit: string;
  output: string;
  port: number;
}

interface ReviewUiRuntime {
  options: ReviewUiOptions;
  decisions: DecisionRow[];
  caseIds: string[];
}

interface StaticReviewUiPayload {
  state: ReviewUiState;
  workbench: unknown;
}

async function main(): Promise<void> {
  try {
    await runReviewUi(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(`appraisal-review-ui failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

export async function runReviewUi(options: ReviewUiOptions): Promise<void> {
  const runtime = await initializeReviewUi(options);
  const state = await loadState(runtime);
  await new Promise<void>((resolve, reject) => {
    const server = createServer((request, response) => {
      void handleRequest(runtime, request, response);
    });

    server.once("error", reject);
    server.once("close", resolve);
    server.listen(options.port, "127.0.0.1", () => {
      console.log(`Tier 1 review UI ready at http://localhost:${options.port}`);
      console.log(`Cases: ${state.progress.total}. Green: ${state.progress.green}. Yellow: ${state.progress.yellow}. Red: ${state.progress.red}.`);
      console.log(`Decisions save to: ${path.join(options.output, "review_decisions.csv")}`);
    });
  });
}

export async function initializeReviewUi(options: ReviewUiOptions): Promise<ReviewUiRuntime> {
  await assertReadableDirectory(options.reviewBatch);
  await assertReadableDirectory(options.reviewPackets);
  await assertReadableDirectory(options.conflictAudit);
  assertPrivateOutput(options.output, "Review UI session");
  await assertWritableOutput(options.output);
  await ensureDir(options.output);

  const packets = await loadReviewPackets(options.reviewPackets);
  const decisions = await loadInitialDecisions(options);
  const runtime: ReviewUiRuntime = {
    options,
    decisions,
    caseIds: packets.map((packet) => packet.case_id).sort((a, b) => a.localeCompare(b))
  };
  const state = await loadState(runtime);
  await writeSessionFiles(runtime, state);
  return runtime;
}

async function loadState(runtime: ReviewUiRuntime) {
  const packets = await loadReviewPackets(runtime.options.reviewPackets);
  const auditDetails = await loadAdjustedPriceAuditDetails(runtime.options.conflictAudit);
  return buildReviewUiState({
    packets,
    auditDetails,
    decisions: runtime.decisions
  });
}

async function handleRequest(runtime: ReviewUiRuntime, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${runtime.options.port}`);
  try {
    if (request.method === "GET" && url.pathname === "/") {
      sendHtml(response, buildHtml(runtime.options));
      return;
    }
    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, { ok: true });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/state") {
      sendJson(response, await loadState(runtime));
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/workbench") {
      const state = await loadState(runtime);
      sendJson(response, await buildWorkbenchState(runtime.options, state.progress, state.privacy));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/decision") {
      const body = (await readJsonBody(request)) as ReviewDecisionDraft;
      const decision = normalizeDecisionDraft(body);
      runtime.decisions = upsertDecision(runtime.decisions, decision);
      const state = await loadState(runtime);
      await writeSessionFiles(runtime, state);
      sendJson(response, state);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/bulk-approve-green") {
      const body = (await readJsonBody(request)) as { reviewer?: string; confirm?: boolean };
      if (body.confirm !== true) {
        sendJson(response, { error: "Confirmation is required." }, 400);
        return;
      }
      const stateBefore = await loadState(runtime);
      runtime.decisions = bulkApproveGreenCases(stateBefore, runtime.decisions, body.reviewer || "Zachary");
      const state = await loadState(runtime);
      await writeSessionFiles(runtime, state);
      sendJson(response, state);
      return;
    }
    sendJson(response, { error: "Not found" }, 404);
  } catch (error) {
    sendJson(response, { error: error instanceof Error ? error.message : String(error) }, 400);
  }
}

async function writeSessionFiles(runtime: ReviewUiRuntime, state: Awaited<ReturnType<typeof loadState>>): Promise<void> {
  const output = runtime.options.output;
  await writeFile(path.join(output, "review_decisions.csv"), decisionsToCsv(runtime.decisions, runtime.caseIds), "utf8");
  await writeJson(path.join(output, "review_decisions.json"), decisionsToJson(runtime.decisions));
  await writeJson(path.join(output, "review_progress.json"), state.progress);
  await writeJson(path.join(output, "review_ui_manifest.json"), {
    created_at: new Date().toISOString(),
    review_batch: path.resolve(runtime.options.reviewBatch),
    review_packets: path.resolve(runtime.options.reviewPackets),
    conflict_audit: path.resolve(runtime.options.conflictAudit),
    output: path.resolve(output),
    local_url: `http://localhost:${runtime.options.port}`,
    commands: buildFollowupCommands(runtime.options),
    cases: state.progress.total,
    green: state.progress.green,
    yellow: state.progress.yellow,
    red: state.progress.red,
    auto_approved_cases: 0
  });
  await writeJson(path.join(output, "privacy_audit.json"), {
    ui_runs_local_only: true,
    raw_xml_included: false,
    output_folder_must_remain_private: true,
    privacy_pattern_counts: state.privacy,
    privacy_pattern_total: privacyTotal(state.privacy),
    final_value_leakage_cases: state.cases.filter((item) => item.final_value_leakage).length,
    auto_approved_cases: 0
  });
}

async function loadInitialDecisions(options: ReviewUiOptions): Promise<DecisionRow[]> {
  for (const candidate of [
    path.join(options.output, "review_decisions.csv"),
    path.join(options.reviewBatch, "review_decisions.csv")
  ]) {
    try {
      return parseDecisionCsv(await readFile(candidate, "utf8"));
    } catch {
      // Try the next candidate.
    }
  }
  return [];
}

function upsertDecision(decisions: DecisionRow[], decision: DecisionRow): DecisionRow[] {
  const map = new Map(decisions.map((item) => [item.case_id, item]));
  map.set(decision.case_id, decision);
  return [...map.values()].sort((a, b) => a.case_id.localeCompare(b.case_id));
}

function sendHtml(response: ServerResponse, html: string): void {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(html);
}

function sendJson(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(value, null, 2));
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
  }
  return body.trim().length > 0 ? JSON.parse(body) : {};
}

export function buildStaticReviewUiHtml(payload: StaticReviewUiPayload): string {
  return buildHtml(
    {
      reviewBatch: "./demo/review-batch",
      reviewPackets: "./demo/review-packets",
      conflictAudit: "./demo/conflict-audit",
      output: "./demo/review-session",
      port: 0
    },
    payload
  );
}

function buildHtml(options: ReviewUiOptions, staticPayload: StaticReviewUiPayload | null = null): string {
  const commands = buildFollowupCommands(options);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Tier 1 Appraisal Review</title>
  <link rel="icon" href="data:,">
  <style>
    :root {
      color-scheme: light;
      --bg: #f4f6f8;
      --surface: #ffffff;
      --surface-raised: #fbfcfe;
      --panel: #f7f9fc;
      --ink: #1e2633;
      --muted: #687386;
      --quiet: #8b95a5;
      --line: #dce3ec;
      --line-strong: #c7d0dc;
      --accent: #1f5f99;
      --accent-bg: #e8f2fb;
      --green: #0b7a4a;
      --green-bg: #e8f6ee;
      --yellow: #9a6400;
      --yellow-bg: #fff5dc;
      --red: #aa2f35;
      --red-bg: #fdeaea;
      --shadow: 0 12px 36px rgba(29, 43, 68, 0.08);
    }
    * { box-sizing: border-box; }
    html { background: var(--bg); }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--ink);
      background: var(--bg);
      font-size: 14px;
      line-height: 1.42;
    }
    header {
      position: sticky;
      top: 0;
      z-index: 5;
      background: rgba(255, 255, 255, 0.96);
      border-bottom: 1px solid var(--line);
      padding: 14px 24px;
      backdrop-filter: blur(10px);
    }
    .topline {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 24px;
      align-items: start;
      width: min(1680px, calc(100vw - 48px));
      margin: 0 auto;
    }
    h1 { margin: 0; font-size: 22px; line-height: 1.1; letter-spacing: 0; }
    .subtitle { margin: 5px 0 12px; color: var(--muted); max-width: 760px; }
    .progress-row {
      display: grid;
      grid-template-columns: minmax(180px, 1fr) auto;
      gap: 12px;
      align-items: center;
    }
    .progress-track {
      height: 8px;
      background: #e8edf3;
      border-radius: 999px;
      overflow: hidden;
      box-shadow: inset 0 0 0 1px rgba(31, 95, 153, 0.05);
    }
    .progress-fill {
      height: 100%;
      background: linear-gradient(90deg, var(--accent), #3980bb);
      width: 0%;
      transition: width 180ms ease;
    }
    .progress-label {
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
      white-space: nowrap;
    }
    .metrics {
      display: flex;
      flex-wrap: wrap;
      gap: 7px;
      margin-top: 10px;
    }
    .metric {
      border: 1px solid var(--line);
      padding: 5px 8px;
      border-radius: 999px;
      font-size: 12px;
      color: var(--muted);
      background: var(--surface);
      white-space: nowrap;
    }
    .metric strong { color: var(--ink); }
    .reviewer {
      display: grid;
      gap: 6px;
      align-items: center;
      min-width: 210px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }
    input, textarea, select {
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 8px 10px;
      font: inherit;
      background: #fff;
      color: var(--ink);
      outline: none;
    }
    input:focus, textarea:focus, select:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(31, 95, 153, 0.12);
    }
    main {
      width: min(1680px, calc(100vw - 48px));
      margin: 0 auto;
      padding: 22px 0 34px;
      display: grid;
      grid-template-columns: 320px minmax(0, 1fr);
      gap: 22px;
      align-items: start;
    }
    nav {
      position: sticky;
      top: 116px;
      align-self: start;
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px;
      box-shadow: var(--shadow);
      min-width: 0;
    }
    .nav-actions, .decision-actions {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
      margin-bottom: 12px;
    }
    button {
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 9px 11px;
      background: #fff;
      color: var(--ink);
      cursor: pointer;
      font: inherit;
      font-weight: 700;
      transition: background 140ms ease, border-color 140ms ease, color 140ms ease, transform 140ms ease;
    }
    button:hover {
      background: var(--panel);
      border-color: var(--line-strong);
      transform: translateY(-1px);
    }
    button.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
    button.green { background: var(--green); color: #fff; border-color: var(--green); }
    button.yellow { background: var(--yellow); color: #fff; border-color: var(--yellow); }
    button.red { background: var(--red); color: #fff; border-color: var(--red); }
    button:disabled {
      opacity: 0.55;
      cursor: not-allowed;
      transform: none;
    }
    button:disabled:hover {
      transform: none;
    }
    .filters {
      display: grid;
      gap: 7px;
      padding: 8px 0 12px;
      border-top: 1px solid var(--line);
      border-bottom: 1px solid var(--line);
      margin-bottom: 12px;
      color: var(--muted);
    }
    .filters label {
      display: flex;
      gap: 8px;
      align-items: center;
      font-size: 13px;
    }
    .case-list {
      display: grid;
      gap: 8px;
      max-height: calc(100vh - 315px);
      overflow: auto;
      padding-right: 2px;
    }
    .case-tab {
      text-align: left;
      border: 1px solid var(--line);
      border-left: 4px solid var(--line);
      background: #fff;
      padding: 10px;
      min-height: 70px;
    }
    .case-tab.active {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(31, 95, 153, 0.11);
    }
    .case-tab.green,
    .case-tab.yellow,
    .case-tab.red {
      background: var(--surface);
      color: var(--ink);
    }
    .case-tab.green { border-left-color: var(--green); }
    .case-tab.yellow { border-left-color: var(--yellow); }
    .case-tab.red { border-left-color: var(--red); }
    .case-tab.green.active { background: var(--green-bg); }
    .case-tab.yellow.active { background: #fffaf0; }
    .case-tab.red.active { background: var(--red-bg); }
    .case-tab.green:hover,
    .case-tab.yellow:hover,
    .case-tab.red:hover { background: var(--panel); }
    .case-tab .case-id {
      display: block;
      overflow-wrap: anywhere;
      line-height: 1.2;
      margin-bottom: 6px;
    }
    .case-tab small {
      display: block;
      color: var(--muted);
      line-height: 1.25;
      overflow-wrap: anywhere;
    }
    .case-status-row { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 7px; }
    section {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 14px;
      background: var(--surface);
      box-shadow: 0 1px 0 rgba(29, 43, 68, 0.03);
      overflow-x: auto;
    }
    .workspace {
      min-width: 0;
    }
    h2 {
      margin: 0 0 12px;
      font-size: 16px;
      line-height: 1.2;
      letter-spacing: 0;
    }
    h3 {
      margin: 0 0 8px;
      font-size: 13px;
      line-height: 1.2;
      color: var(--muted);
      letter-spacing: 0;
    }
    .banner {
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 14px;
      border: 1px solid transparent;
      box-shadow: var(--shadow);
    }
    .banner h2 { margin-bottom: 8px; font-size: 18px; }
    .banner ul { margin: 0; padding-left: 18px; }
    .banner.green { background: var(--green-bg); color: #075735; border-color: #bfe5cf; }
    .banner.yellow { background: var(--yellow-bg); color: #714a00; border-color: #f1d89a; }
    .banner.red { background: var(--red-bg); color: #7d1f24; border-color: #f0b8bc; }
    .facts {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }
    .fact {
      background: var(--surface-raised);
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 10px;
      min-height: 64px;
      overflow-wrap: anywhere;
    }
    .fact span {
      display: block;
      color: var(--quiet);
      font-size: 11px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.03em;
      margin-bottom: 5px;
    }
    table {
      width: 100%;
      min-width: 840px;
      border-collapse: collapse;
      font-size: 13px;
      font-variant-numeric: tabular-nums;
    }
    th, td {
      border-bottom: 1px solid var(--line);
      padding: 9px 10px;
      text-align: left;
      vertical-align: top;
    }
    th {
      color: var(--muted);
      font-weight: 800;
      background: var(--panel);
      text-transform: uppercase;
      letter-spacing: 0.025em;
      font-size: 11px;
    }
    tr:hover td { background: #fbfcff; }
    .badge {
      display: inline-flex;
      align-items: center;
      padding: 3px 7px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 800;
      border: 1px solid var(--line);
      background: var(--panel);
      white-space: nowrap;
    }
    .badge.pass { color: var(--green); background: var(--green-bg); border-color: #b9dfc8; }
    .badge.warn { color: var(--yellow); background: var(--yellow-bg); border-color: #ead28d; }
    .badge.bad { color: var(--red); background: var(--red-bg); border-color: #efb3b3; }
    .level-chip {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      padding: 3px 7px;
      font-size: 11px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.025em;
    }
    .level-chip.green { color: var(--green); background: var(--green-bg); }
    .level-chip.yellow { color: var(--yellow); background: var(--yellow-bg); }
    .level-chip.red { color: var(--red); background: var(--red-bg); }
    .decision-chip { color: var(--muted); background: var(--panel); border: 1px solid var(--line); }
    .muted { color: var(--muted); }
    pre {
      white-space: pre-wrap;
      word-break: break-word;
      background: #16202b;
      color: #f4f7fb;
      padding: 12px;
      border-radius: 6px;
      max-height: 420px;
      overflow: auto;
      font-size: 12px;
      line-height: 1.45;
    }
    textarea {
      width: 100%;
      min-height: 86px;
      resize: vertical;
      margin-bottom: 10px;
    }
    .commands pre {
      background: var(--surface-raised);
      color: var(--ink);
      border: 1px solid var(--line);
      max-height: none;
    }
    details summary {
      cursor: pointer;
      color: var(--ink);
      font-weight: 800;
    }
    header {
      background: #ffffff;
      box-shadow: 0 1px 0 rgba(20, 30, 46, 0.04);
    }
    .topline {
      width: min(1760px, calc(100vw - 48px));
      grid-template-columns: minmax(0, 1fr) 220px;
      align-items: center;
    }
    .app-tabs {
      width: min(1760px, calc(100vw - 48px));
      margin: 12px auto 0;
      display: flex;
      gap: 6px;
      overflow-x: auto;
      scrollbar-width: none;
    }
    .app-tabs::-webkit-scrollbar {
      display: none;
    }
    .app-tab {
      min-height: 34px;
      padding: 7px 11px;
      border-radius: 999px;
      color: #526071;
      background: #f6f8fb;
      border-color: #dbe3ed;
      font-size: 12px;
      font-weight: 850;
      white-space: nowrap;
    }
    .app-tab:hover {
      transform: none;
      background: #edf3f8;
    }
    .app-tab.active {
      color: #ffffff;
      background: #1f5f99;
      border-color: #1f5f99;
    }
    .app-tab[data-status="attention"]:not(.active) {
      border-color: #f0d38f;
      color: #74500a;
      background: #fff9eb;
    }
    .app-tab[data-status="blocked"]:not(.active) {
      border-color: #efb9bc;
      color: #8d252c;
      background: #fff2f2;
    }
    main {
      width: min(1760px, calc(100vw - 48px));
      grid-template-columns: 340px minmax(0, 1fr);
      gap: 22px;
    }
    nav {
      top: 174px;
      height: calc(100vh - 196px);
      display: flex;
      flex-direction: column;
      padding: 14px;
      overflow: hidden;
      background: #151b24;
      color: #e8edf4;
      border: 0;
      box-shadow: 0 20px 50px rgba(15, 23, 38, 0.18);
    }
    .queue-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      padding: 4px 2px 14px;
      border-bottom: 1px solid rgba(232, 237, 244, 0.12);
      margin-bottom: 12px;
    }
    .queue-head span {
      display: block;
      color: #9ba8b7;
      font-size: 11px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .queue-head strong {
      display: block;
      margin-top: 4px;
      color: #ffffff;
      font-size: 18px;
      line-height: 1.1;
    }
    #queueMode {
      padding: 5px 8px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.08);
      color: #dce5ef;
    }
    .nav-actions {
      grid-template-columns: 1fr 1fr;
      margin-bottom: 12px;
    }
    .queue-tools {
      display: grid;
      gap: 10px;
      margin-bottom: 12px;
    }
    #caseSearch {
      width: 100%;
      background: rgba(255, 255, 255, 0.08);
      border-color: rgba(255, 255, 255, 0.14);
      color: #ffffff;
      min-height: 38px;
    }
    .sort-menu {
      position: relative;
    }
    .sort-button {
      width: 100%;
      min-height: 38px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 8px 10px;
      background: rgba(255, 255, 255, 0.08);
      border-color: rgba(255, 255, 255, 0.14);
      color: #f5f7fb;
      font-size: 12px;
      font-weight: 850;
      text-align: left;
    }
    .sort-button::after {
      content: "";
      width: 8px;
      height: 8px;
      border-right: 2px solid #9fb0c4;
      border-bottom: 2px solid #9fb0c4;
      transform: rotate(45deg) translateY(-2px);
      flex: 0 0 auto;
      transition: transform 140ms ease;
    }
    .sort-menu.open .sort-button::after {
      transform: rotate(225deg) translateY(-2px);
    }
    .sort-button:hover {
      transform: none;
      background: rgba(255, 255, 255, 0.12);
      border-color: rgba(255, 255, 255, 0.22);
    }
    .sort-button:focus {
      border-color: #78b9ef;
      box-shadow: 0 0 0 3px rgba(120, 185, 239, 0.16);
    }
    .sort-options {
      z-index: 10;
      display: none;
      margin-top: 6px;
      padding: 6px;
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 8px;
      background: #202833;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
    }
    .sort-menu.open .sort-options {
      display: grid;
      gap: 2px;
    }
    .sort-option {
      width: 100%;
      min-height: 32px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 7px 8px;
      border: 0;
      border-radius: 6px;
      background: transparent;
      color: #dce5ef;
      font-size: 12px;
      font-weight: 750;
      text-align: left;
    }
    .sort-option:hover {
      transform: none;
      background: rgba(255, 255, 255, 0.08);
    }
    .sort-option.active {
      color: #ffffff;
      background: rgba(120, 185, 239, 0.18);
    }
    .sort-menu.open .sort-option.active::after {
      content: "✓";
      color: #78b9ef;
      font-weight: 900;
    }
    #caseSearch::placeholder {
      color: #94a1b3;
    }
    #caseSearch:focus {
      border-color: #78b9ef;
      box-shadow: 0 0 0 3px rgba(120, 185, 239, 0.16);
    }
    .filter-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .filter-chip {
      padding: 5px 8px;
      min-height: 28px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.06);
      border-color: rgba(255, 255, 255, 0.12);
      color: #cfd8e4;
      font-size: 11px;
      font-weight: 900;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .filter-chip:hover {
      transform: none;
      background: rgba(255, 255, 255, 0.1);
      border-color: rgba(255, 255, 255, 0.22);
    }
    .filter-chip.active {
      background: #ffffff;
      color: #17202b;
      border-color: #ffffff;
    }
    .nav-actions button {
      background: rgba(255, 255, 255, 0.06);
      border-color: rgba(255, 255, 255, 0.12);
      color: #f5f7fb;
    }
    .nav-actions button:hover {
      background: rgba(255, 255, 255, 0.1);
      border-color: rgba(255, 255, 255, 0.22);
      transform: none;
    }
    .nav-actions button.green {
      background: #128255;
      border-color: #128255;
      color: #ffffff;
    }
    .shortcut-hint {
      padding: 9px 2px 13px;
      margin-bottom: 12px;
      border-bottom: 1px solid rgba(232, 237, 244, 0.12);
      color: #91a0b3;
      font-size: 11px;
      font-weight: 800;
      line-height: 1.35;
    }
    .filters {
      border-color: rgba(232, 237, 244, 0.12);
      color: #c8d1dd;
      margin-bottom: 12px;
    }
    .case-list {
      flex: 1;
      min-height: 0;
      max-height: none;
      gap: 9px;
      padding: 1px 8px 10px 0;
      scrollbar-width: thin;
      scrollbar-color: rgba(163, 176, 196, 0.48) transparent;
      scrollbar-gutter: stable;
    }
    .case-list::-webkit-scrollbar {
      width: 10px;
    }
    .case-list::-webkit-scrollbar-track {
      background: rgba(255, 255, 255, 0.05);
      border-radius: 999px;
    }
    .case-list::-webkit-scrollbar-thumb {
      background: rgba(170, 183, 202, 0.42);
      border: 2px solid #151b24;
      border-radius: 999px;
    }
    .case-list::-webkit-scrollbar-thumb:hover {
      background: rgba(196, 207, 221, 0.58);
    }
    .empty-queue {
      padding: 18px 10px;
      color: #aeb9c8;
      border: 1px dashed rgba(255, 255, 255, 0.18);
      border-radius: 8px;
      text-align: center;
      font-weight: 800;
    }
    .case-tab,
    .case-tab.green,
    .case-tab.yellow,
    .case-tab.red {
      display: grid;
      gap: 5px;
      align-content: start;
      width: 100%;
      min-height: 94px;
      padding: 12px 12px 13px;
      background: rgba(255, 255, 255, 0.055);
      color: #eef3f8;
      border-color: rgba(255, 255, 255, 0.1);
      border-left-width: 3px;
      border-radius: 8px;
      box-shadow: none;
    }
    .case-tab .case-id {
      margin-bottom: 0;
      line-height: 1.2;
    }
    .case-tab small {
      color: #9eaabd;
      margin: 0;
      min-height: 16px;
    }
    .case-tab:hover,
    .case-tab.green:hover,
    .case-tab.yellow:hover,
    .case-tab.red:hover {
      background: rgba(255, 255, 255, 0.09);
      border-color: rgba(255, 255, 255, 0.18);
      transform: none;
    }
    .case-tab.active,
    .case-tab.green.active,
    .case-tab.yellow.active,
    .case-tab.red.active {
      background: #ffffff;
      color: var(--ink);
      border-color: #ffffff;
      box-shadow: 0 12px 28px rgba(0, 0, 0, 0.2);
    }
    .case-tab.active small {
      color: var(--muted);
    }
    .case-tab.yellow { border-left-color: #d99b18; }
    .case-tab.red { border-left-color: #ef646d; }
    .case-tab.green { border-left-color: #2cbe7b; }
    .case-tab.active .decision-chip {
      background: #f0f3f7;
    }
    .case-status-row {
      align-items: center;
      min-height: 22px;
      margin-top: 2px;
    }
    .case-status-row .level-chip {
      line-height: 1;
    }
    .workspace {
      min-width: 0;
    }
    .case-layout {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 360px;
      gap: 18px;
      align-items: start;
    }
    .case-main {
      min-width: 0;
    }
    .record-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 18px;
      padding: 20px 22px;
      margin-bottom: 14px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #ffffff;
      box-shadow: var(--shadow);
    }
    .record-header h2 {
      margin: 3px 0 5px;
      font-size: 24px;
      line-height: 1.1;
      overflow-wrap: anywhere;
    }
    .record-header p {
      margin: 0;
      color: var(--muted);
      font-weight: 700;
    }
    .record-stats {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 12px;
    }
    .record-stats span {
      display: inline-flex;
      gap: 5px;
      align-items: center;
      padding: 5px 8px;
      border: 1px solid var(--line);
      border-radius: 999px;
      color: var(--muted);
      background: #f7f9fc;
      font-size: 12px;
      font-weight: 800;
    }
    .record-stats strong {
      color: var(--ink);
    }
    .cockpit {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
      margin: 0 0 14px;
    }
    .cockpit-item {
      min-height: 112px;
      padding: 12px;
      border: 1px solid var(--line);
      border-top: 4px solid #b7c4d2;
      border-radius: 8px;
      background: #ffffff;
      box-shadow: 0 1px 0 rgba(25, 39, 61, 0.03);
      overflow-wrap: anywhere;
    }
    .cockpit-item span {
      display: block;
      margin-bottom: 8px;
      color: var(--quiet);
      font-size: 10px;
      font-weight: 900;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .cockpit-item strong {
      display: block;
      margin-bottom: 7px;
      font-size: 15px;
      line-height: 1.2;
    }
    .cockpit-item small {
      display: block;
      color: var(--muted);
      font-weight: 700;
      line-height: 1.3;
    }
    .cockpit-item.green { border-top-color: var(--green); }
    .cockpit-item.yellow { border-top-color: #d99b18; }
    .cockpit-item.red { border-top-color: var(--red); }
    .eyebrow {
      color: var(--quiet);
      font-size: 11px;
      font-weight: 900;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .record-pills {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 6px;
      min-width: 190px;
    }
    .section-jumps {
      position: sticky;
      top: 128px;
      z-index: 2;
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin: 0 0 14px;
      padding: 8px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.94);
      backdrop-filter: blur(8px);
      box-shadow: 0 8px 24px rgba(25, 39, 61, 0.06);
    }
    .section-jumps button {
      padding: 6px 9px;
      min-height: 30px;
      border-radius: 999px;
      color: #35526f;
      background: #eef5fb;
      border-color: #cfe0ee;
      font-size: 12px;
    }
    .section-jumps button:hover {
      transform: none;
      background: #e1eef8;
    }
    .neutral-chip {
      color: #35526f;
      background: var(--accent-bg);
    }
    .review-section,
    .decision-box {
      padding: 18px;
      border-radius: 8px;
      border: 1px solid var(--line);
      background: #ffffff;
      box-shadow: 0 1px 0 rgba(25, 39, 61, 0.03);
    }
    .review-section {
      margin-bottom: 14px;
      scroll-margin-top: 184px;
    }
    .section-title {
      display: flex;
      align-items: baseline;
      gap: 10px;
      margin-bottom: 12px;
      padding-bottom: 10px;
      border-bottom: 1px solid var(--line);
    }
    .section-title span {
      color: var(--accent);
      font-size: 11px;
      font-weight: 900;
      letter-spacing: 0.08em;
    }
    .section-title h2 {
      margin: 0;
      font-size: 17px;
    }
    .table-toolbar {
      margin-left: auto;
      display: flex;
      gap: 6px;
      align-items: center;
    }
    .table-toolbar button {
      min-height: 28px;
      padding: 5px 8px;
      border-radius: 999px;
      background: #f7f9fc;
      color: #3e536b;
      border-color: #d9e3ee;
      font-size: 11px;
      font-weight: 900;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }
    .table-toolbar button.active {
      background: var(--accent);
      border-color: var(--accent);
      color: #ffffff;
    }
    .table-toolbar button:hover {
      transform: none;
    }
    .review-section .facts,
    .reconciliation-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 0 20px;
    }
    .review-section .fact {
      min-height: 0;
      padding: 10px 0;
      border: 0;
      border-bottom: 1px solid var(--line);
      border-radius: 0;
      background: transparent;
    }
    .review-section .fact span {
      margin-bottom: 5px;
    }
    .field-note {
      margin: 14px 0 0;
      padding: 10px 12px;
      border-radius: 6px;
      background: #f8fafc;
      color: var(--muted);
      font-weight: 700;
    }
    .table-wrap {
      overflow-x: auto;
    }
    .review-section table {
      min-width: 760px;
    }
    .narrative {
      margin: 0 0 14px;
      color: #273244;
    }
    .caveats {
      margin: 0;
      padding-left: 18px;
      color: var(--muted);
    }
    .decision-panel {
      position: sticky;
      top: 128px;
      display: grid;
      gap: 14px;
      min-width: 0;
    }
    .recommendation-card {
      padding: 18px;
      border-radius: 8px;
      background: #ffffff;
      border: 1px solid var(--line);
      box-shadow: var(--shadow);
    }
    .recommendation-card span {
      color: var(--quiet);
      font-size: 11px;
      font-weight: 900;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .recommendation-card h2 {
      margin: 6px 0 10px;
      font-size: 20px;
    }
    .recommendation-card ul {
      margin: 0;
      padding-left: 18px;
      color: #4a3720;
    }
    .recommendation-card.yellow {
      border-top: 4px solid #d99b18;
      background: #fffaf0;
    }
    .recommendation-card.red {
      border-top: 4px solid var(--red);
      background: #fff6f6;
    }
    .recommendation-card.green {
      border-top: 4px solid var(--green);
      background: #f4fbf7;
    }
    .decision-box {
      margin-bottom: 0;
    }
    .focus-card {
      margin: 0;
      padding: 16px;
      border-radius: 8px;
      border: 1px solid var(--line);
      background: #ffffff;
      box-shadow: 0 1px 0 rgba(25, 39, 61, 0.03);
    }
    .focus-card h2 {
      margin-bottom: 10px;
      font-size: 15px;
    }
    .focus-card ol {
      margin: 0;
      padding-left: 20px;
      color: #3f4a5a;
      display: grid;
      gap: 8px;
      font-weight: 700;
    }
    .decision-box h2 {
      font-size: 17px;
      margin-bottom: 10px;
    }
    .decision-context {
      margin: -2px 0 10px;
      padding: 8px 10px;
      border: 1px solid var(--line);
      border-left: 4px solid #c78105;
      border-radius: 4px;
      background: #fffdf7;
      color: #465466;
      font-size: 12px;
      font-weight: 750;
      line-height: 1.35;
    }
    .note-templates {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 7px;
      margin: 0 0 10px;
    }
    .note-templates button {
      min-height: 32px;
      padding: 6px 8px;
      background: #f7f9fc;
      color: #3e536b;
      border-color: #d9e3ee;
      font-size: 12px;
      font-weight: 800;
    }
    .note-templates button:hover {
      transform: none;
      background: #eef5fb;
    }
    .decision-actions {
      grid-template-columns: 1fr;
      margin-bottom: 0;
    }
    .decision-actions button {
      min-height: 42px;
    }
    .save-msg {
      min-height: 18px;
      margin: 8px 0 0;
      color: var(--muted);
      font-weight: 700;
    }
    .rail-details {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #ffffff;
      padding: 12px;
    }
    .rail-details summary {
      font-size: 13px;
    }
    .rail-details pre {
      max-height: 280px;
      margin-bottom: 0;
      font-size: 11px;
    }
    .review-section .badge {
      white-space: nowrap;
      max-width: 140px;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .empty-table {
      padding: 18px 10px;
      color: var(--muted);
      text-align: center;
      font-weight: 800;
      background: #fbfcfe;
    }
    .repair-panel {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 280px;
      gap: 20px;
      align-items: center;
      margin-bottom: 14px;
      padding: 22px;
      border: 1px solid #efc2c6;
      border-top: 5px solid var(--red);
      border-radius: 8px;
      background: linear-gradient(180deg, #fff7f7 0%, #ffffff 100%);
      box-shadow: var(--shadow);
    }
    .repair-copy h2 {
      margin: 5px 0 8px;
      font-size: 26px;
      line-height: 1.08;
    }
    .repair-copy p {
      margin: 0;
      max-width: 760px;
      color: #5f4550;
      font-weight: 700;
    }
    .repair-action {
      padding: 14px;
      border-radius: 8px;
      background: #ffffff;
      border: 1px solid #f0c9ce;
    }
    .repair-action strong,
    .repair-action span {
      display: block;
    }
    .repair-action strong {
      margin-bottom: 6px;
      color: var(--red);
      font-size: 15px;
    }
    .repair-action span {
      color: #5f4550;
      font-weight: 800;
      line-height: 1.3;
    }
    .repair-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 14px;
      margin-bottom: 14px;
      padding: 0;
      border: 0;
      background: transparent;
      box-shadow: none;
      overflow: visible;
    }
    .repair-card {
      min-height: 170px;
      padding: 16px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #ffffff;
      box-shadow: 0 1px 0 rgba(25, 39, 61, 0.03);
    }
    .repair-card span {
      display: block;
      margin-bottom: 10px;
      color: var(--quiet);
      font-size: 11px;
      font-weight: 900;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .repair-card ul {
      margin: 0;
      padding-left: 18px;
      color: #344054;
      font-weight: 750;
      display: grid;
      gap: 6px;
    }
    .repair-card dl {
      display: grid;
      grid-template-columns: 120px 1fr;
      gap: 8px 12px;
      margin: 0;
    }
    .repair-card dt {
      color: var(--quiet);
      font-size: 11px;
      font-weight: 900;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .repair-card dd {
      margin: 0;
      color: #263242;
      font-weight: 800;
    }
    .repair-details {
      margin-bottom: 14px;
      padding: 14px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #ffffff;
    }
    .repair-detail-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
      margin-top: 12px;
    }
    .workbench-view {
      display: grid;
      gap: 16px;
    }
    .workbench-hero {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 18px;
      align-items: end;
      padding: 22px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #ffffff;
      box-shadow: var(--shadow);
    }
    .workbench-hero h2 {
      margin: 4px 0 6px;
      font-size: 28px;
      line-height: 1.05;
    }
    .workbench-hero p {
      margin: 0;
      max-width: 800px;
      color: var(--muted);
      font-weight: 700;
    }
    .hero-actions {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 8px;
    }
    .stage-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
    }
    .stage-card,
    .workbench-panel {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #ffffff;
      box-shadow: 0 1px 0 rgba(25, 39, 61, 0.03);
    }
    .stage-card {
      min-height: 108px;
      padding: 14px;
      display: grid;
      align-content: space-between;
      border-top: 4px solid #9db0c3;
    }
    .stage-card.ready { border-top-color: var(--green); }
    .stage-card.attention { border-top-color: #d99b18; }
    .stage-card.blocked { border-top-color: var(--red); }
    .stage-card span,
    .panel-kicker {
      color: var(--quiet);
      font-size: 10px;
      font-weight: 900;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .stage-card strong {
      display: block;
      margin: 7px 0 5px;
      font-size: 16px;
    }
    .stage-card small {
      color: var(--muted);
      font-weight: 750;
    }
    .operator-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 14px;
    }
    .workbench-panel {
      padding: 16px;
      min-width: 0;
      overflow: hidden;
    }
    .workbench-panel h2 {
      margin: 4px 0 12px;
      font-size: 17px;
    }
    .full-span {
      grid-column: 1 / -1;
    }
    .metric-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
    }
    .metric-tile {
      padding: 12px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #f9fbfd;
      min-height: 84px;
    }
    .metric-tile span {
      display: block;
      color: var(--quiet);
      font-size: 10px;
      font-weight: 900;
      text-transform: uppercase;
      letter-spacing: 0.07em;
    }
    .metric-tile strong {
      display: block;
      margin-top: 8px;
      font-size: 22px;
      line-height: 1.05;
    }
    .data-table {
      width: 100%;
      min-width: 0;
      border-collapse: collapse;
    }
    .data-table th,
    .data-table td {
      padding: 9px 8px;
      border-bottom: 1px solid var(--line);
      vertical-align: top;
    }
    .data-table th {
      background: #f7f9fc;
    }
    .path-cell {
      max-width: 420px;
      word-break: break-word;
      color: #354255;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 11px;
      line-height: 1.35;
    }
    .path-list {
      display: grid;
      gap: 8px;
      margin: 0;
    }
    .path-row {
      display: grid;
      grid-template-columns: 150px minmax(0, 1fr);
      gap: 10px;
      padding: 9px 0;
      border-bottom: 1px solid var(--line);
    }
    .path-row dt {
      color: var(--quiet);
      font-size: 11px;
      font-weight: 900;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .path-row dd {
      margin: 0;
      overflow-wrap: anywhere;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      color: #334155;
    }
    .command-block {
      margin: 0;
      padding: 12px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #111827;
      color: #edf2f7;
      max-height: none;
      font-size: 12px;
      line-height: 1.5;
    }
    .action-list {
      display: grid;
      gap: 9px;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .action-list li {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      gap: 10px;
      align-items: center;
      padding: 10px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fbfcfe;
    }
    .status-dot {
      width: 9px;
      height: 9px;
      border-radius: 999px;
      background: #9db0c3;
    }
    .status-dot.ready { background: var(--green); }
    .status-dot.attention { background: #d99b18; }
    .status-dot.blocked { background: var(--red); }
    .case-link-button {
      padding: 6px 8px;
      min-height: 30px;
      color: #315b85;
      background: #eef5fb;
      border-color: #d6e5f1;
      font-size: 12px;
    }
    .case-link-button:hover {
      transform: none;
    }
    .empty-state {
      padding: 18px;
      border: 1px dashed var(--line-strong);
      border-radius: 8px;
      color: var(--muted);
      font-weight: 800;
      text-align: center;
      background: #fbfcfe;
    }
    :root {
      --bg: #eef2f6;
      --surface: #ffffff;
      --surface-raised: #f8fafc;
      --panel: #f3f6fa;
      --ink: #1c2533;
      --muted: #657386;
      --quiet: #8a97a8;
      --line: #d7e0ea;
      --line-strong: #b9c6d6;
      --accent: #1b5f93;
      --accent-bg: #e6f1fa;
      --green: #0f7a52;
      --green-bg: #e7f5ee;
      --yellow: #a36700;
      --yellow-bg: #fff4d8;
      --red: #a9323b;
      --red-bg: #fdebed;
      --nav: #101721;
      --nav-soft: #17212d;
      --nav-line: rgba(221, 230, 242, 0.13);
      --shadow: 0 16px 38px rgba(24, 39, 62, 0.08);
    }
    body {
      background:
        linear-gradient(180deg, #f8fafc 0, #eef2f6 220px),
        var(--bg);
      color: var(--ink);
    }
    header {
      padding: 15px 28px 0;
      background: rgba(248, 250, 252, 0.96);
      border-bottom: 1px solid #dbe3ec;
      box-shadow: 0 1px 0 rgba(19, 31, 49, 0.04);
    }
    .topline {
      width: min(1840px, calc(100vw - 56px));
      grid-template-columns: minmax(0, 1fr) 240px;
      gap: 24px;
      align-items: start;
    }
    h1 {
      font-size: 24px;
      font-weight: 850;
    }
    .subtitle {
      margin: 5px 0 11px;
      max-width: 860px;
      color: #627084;
      font-weight: 650;
    }
    .progress-row {
      grid-template-columns: minmax(220px, 1fr) auto;
    }
    .progress-track {
      height: 7px;
      background: #e2e8f0;
    }
    .metrics {
      gap: 6px;
      margin-top: 9px;
    }
    .metric {
      min-height: 27px;
      display: inline-flex;
      align-items: center;
      gap: 3px;
      background: #ffffff;
      border-color: #d7e0ea;
      color: #667386;
      font-weight: 720;
    }
    .reviewer {
      min-width: 0;
    }
    .reviewer input {
      min-height: 38px;
      border-radius: 8px;
      background: #ffffff;
    }
    .app-tabs {
      width: min(1840px, calc(100vw - 56px));
      margin: 12px auto 0;
      gap: 2px;
      border-top: 1px solid #e2e8f0;
      padding-top: 8px;
    }
    .app-tab {
      position: relative;
      min-height: 40px;
      padding: 8px 13px 10px;
      border: 0;
      border-bottom: 3px solid transparent;
      border-radius: 0;
      background: transparent;
      color: #59677a;
      font-size: 12px;
      letter-spacing: 0.01em;
    }
    .app-tab::before {
      content: "";
      display: inline-block;
      width: 7px;
      height: 7px;
      margin-right: 7px;
      border-radius: 999px;
      background: #94a3b8;
      vertical-align: 1px;
    }
    .app-tab[data-status="ready"]::before { background: var(--green); }
    .app-tab[data-status="attention"]::before { background: #d28b0e; }
    .app-tab[data-status="blocked"]::before { background: var(--red); }
    .app-tab:hover {
      background: #eef4fa;
      color: #223149;
    }
    .app-tab.active {
      background: transparent;
      color: var(--accent);
      border-bottom-color: var(--accent);
    }
    .app-tab[data-status="attention"]:not(.active),
    .app-tab[data-status="blocked"]:not(.active) {
      background: transparent;
    }
    main {
      width: min(1840px, calc(100vw - 56px));
      grid-template-columns: 360px minmax(0, 1fr);
      gap: 24px;
      padding: 20px 0 40px;
    }
    nav {
      top: 154px;
      height: calc(100vh - 178px);
      padding: 16px;
      border-radius: 12px;
      background: var(--nav);
      box-shadow: 0 22px 48px rgba(15, 23, 38, 0.22);
    }
    .queue-head {
      padding: 2px 0 15px;
      margin-bottom: 14px;
    }
    .queue-head strong {
      font-size: 20px;
      letter-spacing: 0;
    }
    #queueMode {
      background: #223044;
      color: #dbe6f3;
      border: 1px solid rgba(255, 255, 255, 0.07);
    }
    .queue-tools {
      gap: 12px;
    }
    #caseSearch {
      min-height: 42px;
      border-radius: 8px;
      background: #1a2532;
      border-color: rgba(255, 255, 255, 0.1);
    }
    .sort-control {
      display: grid;
      gap: 7px;
      padding: 10px;
      border: 1px solid var(--nav-line);
      border-radius: 10px;
      background: rgba(255, 255, 255, 0.035);
    }
    .sort-control > span {
      color: #93a2b6;
      font-size: 10px;
      font-weight: 900;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .sort-options {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 6px;
      margin: 0;
      padding: 0;
      border: 0;
      border-radius: 0;
      background: transparent;
      box-shadow: none;
    }
    .sort-option {
      min-height: 31px;
      justify-content: center;
      padding: 6px 8px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 7px;
      background: rgba(255, 255, 255, 0.045);
      color: #c9d5e4;
      font-size: 11px;
    }
    .sort-option:hover {
      background: rgba(255, 255, 255, 0.09);
      border-color: rgba(255, 255, 255, 0.18);
    }
    .sort-option.active {
      background: #e8f2fb;
      border-color: #e8f2fb;
      color: #17314a;
    }
    .sort-option.active::after {
      content: "";
    }
    .filter-chips {
      gap: 7px;
    }
    .filter-chip {
      min-height: 30px;
      padding: 6px 9px;
    }
    .nav-actions {
      gap: 8px;
      margin-bottom: 13px;
    }
    .nav-actions button {
      min-height: 38px;
      border-radius: 8px;
    }
    .case-list {
      gap: 10px;
      padding: 1px 6px 12px 0;
      scrollbar-width: thin;
      scrollbar-color: rgba(142, 157, 178, 0.52) transparent;
      scrollbar-gutter: stable;
    }
    .case-list::-webkit-scrollbar {
      width: 8px;
    }
    .case-list::-webkit-scrollbar-track {
      background: transparent;
    }
    .case-list::-webkit-scrollbar-thumb {
      background: rgba(142, 157, 178, 0.42);
      border: 2px solid var(--nav);
      border-radius: 999px;
    }
    .case-list::-webkit-scrollbar-thumb:hover {
      background: rgba(183, 196, 214, 0.66);
    }
    .case-tab,
    .case-tab.green,
    .case-tab.yellow,
    .case-tab.red {
      min-height: 126px;
      grid-template-rows: auto auto auto minmax(26px, auto);
      gap: 7px;
      padding: 13px 13px 12px;
      border-radius: 10px;
      overflow: hidden;
    }
    .case-topline {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      min-width: 0;
    }
    .case-id {
      min-width: 0;
      font-size: 13px;
      font-weight: 900;
    }
    .case-value {
      flex: 0 0 auto;
      color: #c9d5e4;
      font-size: 12px;
      font-weight: 850;
      font-variant-numeric: tabular-nums;
    }
    .case-tab.active .case-value {
      color: var(--accent);
    }
    .case-reason {
      min-height: 17px;
    }
    .case-meta {
      display: block;
      color: #8796aa;
      font-size: 11px;
      font-weight: 760;
      line-height: 1.25;
      overflow-wrap: anywhere;
    }
    .case-tab.active .case-meta {
      color: #667386;
    }
    .case-status-row {
      align-self: end;
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      min-height: 26px;
      margin-top: 1px;
      overflow: visible;
    }
    .level-chip {
      min-height: 21px;
      line-height: 1;
      white-space: nowrap;
    }
    .workspace {
      min-width: 0;
    }
    .workbench-view {
      gap: 18px;
    }
    .workbench-hero {
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      padding: 8px 0 18px;
      border: 0;
      border-bottom: 1px solid var(--line);
      border-radius: 0;
      background: transparent;
      box-shadow: none;
    }
    .workbench-hero h2 {
      margin: 4px 0 5px;
      font-size: 30px;
      line-height: 1.08;
    }
    .workbench-hero p {
      max-width: 900px;
      color: #617083;
    }
    .hero-actions button,
    .case-link-button {
      min-height: 32px;
      border-radius: 8px;
      background: #edf5fb;
      color: #244e74;
      border-color: #cfe0ee;
    }
    .hero-actions button.primary-lite {
      background: var(--accent);
      color: #ffffff;
      border-color: var(--accent);
    }
    .metric-grid {
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px;
    }
    .metric-tile {
      min-height: 96px;
      padding: 15px;
      border-radius: 10px;
      background: #ffffff;
      box-shadow: 0 1px 0 rgba(25, 39, 61, 0.035);
    }
    .metric-tile strong {
      margin: 9px 0 3px;
      font-size: 25px;
    }
    .stage-grid {
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 12px;
    }
    .stage-card {
      min-height: 118px;
      padding: 16px;
      border-radius: 10px;
      text-align: left;
      transition: border-color 140ms ease, box-shadow 140ms ease, transform 140ms ease;
    }
    .stage-card:hover {
      transform: translateY(-2px);
      box-shadow: 0 12px 28px rgba(24, 39, 62, 0.08);
    }
    .operator-grid {
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: 16px;
    }
    .workbench-panel,
    .review-section,
    .decision-box,
    .recommendation-card,
    .focus-card,
    .rail-details {
      border-radius: 10px;
    }
    .workbench-panel {
      padding: 18px;
      box-shadow: 0 1px 0 rgba(25, 39, 61, 0.035);
    }
    .action-list li {
      border-radius: 10px;
      background: #ffffff;
    }
    .lane-grid {
      display: grid;
      grid-template-columns: repeat(6, minmax(0, 1fr));
      gap: 10px;
    }
    .lane-item {
      min-height: 82px;
      display: grid;
      align-content: center;
      gap: 6px;
      padding: 12px;
      border-radius: 10px;
      background: #f8fafc;
      text-align: left;
      border-top: 4px solid #9db0c3;
    }
    .lane-item span {
      color: var(--quiet);
      font-size: 10px;
      font-weight: 900;
      letter-spacing: 0.07em;
      text-transform: uppercase;
    }
    .lane-item strong {
      font-size: 24px;
      line-height: 1;
    }
    .lane-item.ready { border-top-color: var(--green); }
    .lane-item.attention { border-top-color: #d99b18; }
    .lane-item.blocked { border-top-color: var(--red); }
    .lane-item:hover {
      transform: translateY(-1px);
      background: #ffffff;
    }
    .mapping-target-list {
      display: grid;
      gap: 10px;
    }
    .mapping-target-row {
      display: grid;
      grid-template-columns: minmax(180px, 260px) minmax(0, 1fr) auto;
      gap: 12px;
      align-items: start;
      padding: 12px;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: #f8fafc;
    }
    .mapping-target-row strong,
    .mapping-target-row span,
    .mapping-target-row code {
      min-width: 0;
    }
    .mapping-target-row strong {
      display: block;
      margin-bottom: 5px;
      color: var(--ink);
    }
    .mapping-target-row div > span {
      display: block;
      color: var(--muted);
      font-size: 12px;
      font-weight: 760;
      line-height: 1.35;
    }
    .mapping-target-row code {
      color: #34445a;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 11px;
      line-height: 1.35;
      overflow-wrap: anywhere;
      white-space: normal;
    }
    .command-panel {
      display: grid;
      gap: 8px;
    }
    .command-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .command-header button {
      min-height: 30px;
      padding: 5px 9px;
      border-radius: 7px;
      color: #244e74;
      background: #edf5fb;
      border-color: #cfe0ee;
      font-size: 12px;
    }
    .command-block {
      border-radius: 10px;
      background: #111821;
      color: #eef4fb;
      border-color: #1f2b3a;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.035);
    }
    .record-header {
      border-radius: 10px;
      padding: 21px 23px;
    }
    .record-header h2 {
      font-size: 23px;
    }
    .cockpit {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .case-command-bar {
      position: sticky;
      top: 128px;
      z-index: 3;
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      margin: -2px 0 14px;
      padding: 9px;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: rgba(255, 255, 255, 0.94);
      box-shadow: 0 10px 28px rgba(24, 39, 62, 0.07);
      backdrop-filter: blur(10px);
    }
    .case-command-bar button {
      min-height: 31px;
      padding: 6px 9px;
      border-radius: 8px;
      background: #f8fafc;
      color: #34465c;
      font-size: 12px;
    }
    .case-command-bar button.active {
      background: var(--accent);
      border-color: var(--accent);
      color: #ffffff;
    }
    .case-command-bar .spacer {
      flex: 1 1 auto;
    }
    .case-index-label {
      color: var(--muted);
      font-size: 12px;
      font-weight: 850;
    }
    .section-jumps {
      top: 180px;
    }
    .repair-panel {
      grid-template-columns: 1fr;
      align-items: start;
      padding: 20px;
    }
    .repair-copy h2 {
      font-size: 24px;
      max-width: 760px;
    }
    .repair-copy p {
      max-width: 860px;
    }
    .repair-action {
      max-width: 640px;
    }
    .decision-panel {
      top: 128px;
    }
    .decision-actions button {
      border-radius: 8px;
      min-height: 44px;
    }
    .note-templates {
      grid-template-columns: 1fr 1fr;
    }
    .note-templates button {
      border-radius: 8px;
    }
    .data-table th {
      background: #f2f6fa;
    }
    @media (min-width: 1720px) {
      .cockpit {
        grid-template-columns: repeat(4, minmax(0, 1fr));
      }
      .repair-panel {
        grid-template-columns: minmax(0, 1fr) 300px;
      }
    }
    @media (max-width: 1350px) {
      .case-layout {
        grid-template-columns: 1fr;
      }
      .decision-panel {
        position: static;
        grid-template-columns: minmax(0, 1fr);
      }
      .section-jumps {
        position: static;
      }
      .mapping-target-row {
        grid-template-columns: 1fr;
      }
    }
    /* Sober operations-console pass: remove generated-dashboard styling. */
    :root {
      --bg: #f6f7f9;
      --surface: #ffffff;
      --surface-raised: #fafbfc;
      --panel: #f1f4f7;
      --ink: #202733;
      --muted: #687386;
      --quiet: #8b96a6;
      --line: #d9e0e8;
      --line-strong: #b8c2cf;
      --accent: #185a8d;
      --accent-bg: #e7f0f8;
      --green: #13724f;
      --green-bg: #edf7f2;
      --yellow: #9a6500;
      --yellow-bg: #fff7e5;
      --red: #a3333a;
      --red-bg: #fff0f1;
      --shadow: none;
    }
    body {
      background: var(--bg);
      font-size: 13px;
      line-height: 1.38;
    }
    header {
      padding: 12px 24px 0;
      background: #ffffff;
      border-bottom: 1px solid var(--line);
      box-shadow: none;
    }
    .topline {
      width: min(1760px, calc(100vw - 48px));
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: start;
    }
    h1 {
      font-size: 20px;
      font-weight: 800;
    }
    .subtitle {
      margin: 4px 0 9px;
      color: #5f6b7b;
      font-weight: 600;
    }
    .top-actions {
      display: flex;
      align-items: end;
      gap: 10px;
    }
    .queue-toggle {
      min-height: 36px;
      padding: 7px 10px;
      border-radius: 4px;
      background: #f7f9fb;
      color: #334155;
      border-color: var(--line);
      white-space: nowrap;
    }
    .progress-track {
      height: 5px;
      border-radius: 0;
      background: #e5eaf0;
      box-shadow: none;
    }
    .progress-fill {
      background: var(--accent);
    }
    .progress-label {
      font-size: 12px;
      color: #536173;
    }
    .metrics {
      gap: 0;
      margin-top: 8px;
    }
    .metric {
      min-height: 24px;
      padding: 4px 8px;
      border-radius: 0;
      border-right: 0;
      background: #ffffff;
      font-size: 12px;
    }
    .metric:first-child {
      border-radius: 4px 0 0 4px;
    }
    .metric:last-child {
      border-right: 1px solid var(--line);
      border-radius: 0 4px 4px 0;
    }
    .reviewer {
      min-width: 210px;
    }
    .reviewer input,
    input,
    textarea,
    select {
      border-radius: 4px;
    }
    button {
      border-radius: 4px;
      box-shadow: none;
      font-weight: 750;
      transform: none;
    }
    button:hover {
      transform: none;
    }
    .app-tabs {
      width: min(1760px, calc(100vw - 48px));
      margin-top: 10px;
      padding-top: 0;
      border-top: 1px solid var(--line);
    }
    .app-tab {
      min-height: 36px;
      padding: 8px 12px;
      color: #4e5c6d;
      border-bottom-width: 2px;
      font-size: 12px;
      font-weight: 800;
    }
    .app-tab::before {
      display: none;
    }
    .app-tab:hover {
      background: #f4f6f8;
    }
    .app-tab.active {
      color: #123d61;
      border-bottom-color: var(--accent);
    }
    .app-tab[data-status="attention"]:not(.active) {
      color: #6f4d08;
    }
    .app-tab[data-status="blocked"]:not(.active) {
      color: #7b242b;
    }
    main {
      width: min(1760px, calc(100vw - 48px));
      grid-template-columns: 330px minmax(0, 1fr);
      gap: 18px;
      padding-top: 18px;
    }
    body.queue-hidden main {
      grid-template-columns: minmax(0, 1fr);
    }
    body.queue-hidden nav {
      display: none;
    }
    nav {
      top: 130px;
      height: calc(100vh - 148px);
      padding: 12px;
      border: 1px solid var(--line);
      border-radius: 4px;
      background: #ffffff;
      color: var(--ink);
      box-shadow: none;
    }
    .queue-head {
      padding: 0 0 10px;
      margin-bottom: 10px;
      border-bottom: 1px solid var(--line);
    }
    .queue-head span {
      color: #697586;
      letter-spacing: 0.06em;
    }
    .queue-head strong {
      color: var(--ink);
      font-size: 17px;
      font-weight: 800;
    }
    #queueMode {
      background: #f3f5f7;
      color: #4f5d70;
      border: 1px solid var(--line);
      border-radius: 4px;
    }
    .queue-tools {
      gap: 8px;
    }
    #caseSearch {
      min-height: 36px;
      background: #ffffff;
      color: var(--ink);
      border-color: var(--line);
      border-radius: 4px;
    }
    #caseSearch::placeholder {
      color: #8994a4;
    }
    .sort-control {
      gap: 6px;
      padding: 8px;
      border: 1px solid var(--line);
      border-radius: 4px;
      background: #fafbfc;
    }
    .sort-control > span {
      color: #697586;
      letter-spacing: 0.06em;
    }
    .sort-options {
      gap: 5px;
    }
    .sort-option {
      min-height: 28px;
      border: 1px solid var(--line);
      border-radius: 4px;
      background: #ffffff;
      color: #39465a;
      font-size: 11px;
    }
    .sort-option:hover {
      background: #f3f6f9;
      border-color: var(--line-strong);
    }
    .sort-option.active {
      background: #e9f1f8;
      border-color: #c4d6e7;
      color: #123d61;
    }
    .filter-chips {
      gap: 5px;
    }
    .filter-chip,
    .level-chip,
    .badge {
      border-radius: 4px;
      letter-spacing: 0;
    }
    .filter-chip {
      min-height: 27px;
      padding: 5px 7px;
      background: #ffffff;
      border-color: var(--line);
      color: #455265;
    }
    .filter-chip.active {
      background: #263445;
      color: #ffffff;
      border-color: #263445;
    }
    .nav-actions {
      gap: 6px;
      margin-bottom: 10px;
    }
    .nav-actions button,
    .nav-actions button.green {
      min-height: 34px;
      border-radius: 4px;
      background: #f7f9fb;
      color: #2f3b4d;
      border-color: var(--line);
    }
    .nav-actions button.green:not(:disabled) {
      background: var(--green);
      color: #ffffff;
      border-color: var(--green);
    }
    .case-list {
      gap: 6px;
      padding-right: 4px;
      align-content: start;
      grid-auto-rows: max-content;
      scrollbar-color: #b8c2cf transparent;
    }
    .case-list::-webkit-scrollbar {
      width: 7px;
    }
    .case-list::-webkit-scrollbar-thumb {
      background: #b8c2cf;
      border: 1px solid #ffffff;
      border-radius: 8px;
    }
    .case-tab,
    .case-tab.green,
    .case-tab.yellow,
    .case-tab.red {
      min-height: 0;
      height: auto;
      gap: 5px;
      padding: 10px;
      grid-template-rows: none;
      align-content: start;
      overflow: visible;
      border: 1px solid var(--line);
      border-left-width: 4px;
      border-radius: 4px;
      background: #ffffff;
      color: var(--ink);
    }
    .case-tab:hover,
    .case-tab.green:hover,
    .case-tab.yellow:hover,
    .case-tab.red:hover {
      background: #fafbfc;
      border-color: var(--line-strong);
    }
    .case-tab.active,
    .case-tab.green.active,
    .case-tab.yellow.active,
    .case-tab.red.active {
      background: #f8fafc;
      border-color: #98b7d2;
      box-shadow: inset 0 0 0 1px #98b7d2;
    }
    .case-value,
    .case-tab.active .case-value {
      color: #335574;
    }
    .case-tab small,
    .case-meta,
    .case-tab.active .case-meta {
      color: #667386;
    }
    .case-approval {
      display: grid;
      gap: 5px;
      margin-top: 4px;
      padding-top: 7px;
      border-top: 1px solid var(--line);
      color: #2f3b4d;
      font-size: 11px;
      line-height: 1.25;
      overflow-wrap: anywhere;
    }
    .case-approval strong {
      color: var(--ink);
      font-size: 11px;
      font-weight: 900;
    }
    .case-approval-list {
      display: grid;
      gap: 2px;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .case-approval-point {
      display: grid;
      grid-template-columns: 7px minmax(0, 1fr);
      gap: 5px;
      align-items: start;
      color: #455265;
      font-size: 11px;
      font-weight: 750;
      line-height: 1.18;
    }
    .case-approval-dot {
      width: 6px;
      height: 6px;
      margin-top: 3px;
      border-radius: 50%;
      background: #8795a6;
    }
    .case-approval-point.blocker .case-approval-dot {
      background: var(--red);
    }
    .case-approval-point.required .case-approval-dot {
      background: #c78105;
    }
    .case-approval-point.verify .case-approval-dot {
      background: var(--green);
    }
    .workbench-view {
      gap: 14px;
    }
    .workbench-hero {
      padding: 0 0 12px;
      border-bottom: 1px solid var(--line);
    }
    .workbench-hero h2 {
      margin: 2px 0 4px;
      font-size: 22px;
      line-height: 1.15;
      font-weight: 800;
    }
    .workbench-hero p {
      color: #617083;
      font-weight: 600;
    }
    .view-meta {
      display: block;
      color: #7b8796;
      font-size: 11px;
      font-weight: 800;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .hero-actions {
      gap: 6px;
    }
    .hero-actions button,
    .case-link-button {
      min-height: 30px;
      border-radius: 4px;
      background: #f7f9fb;
      color: #234865;
      border-color: var(--line);
    }
    .hero-actions button.primary-lite {
      background: #263445;
      border-color: #263445;
      color: #ffffff;
    }
    .metric-grid {
      gap: 8px;
    }
    .metric-tile,
    .stage-card,
    .workbench-panel,
    .review-section,
    .decision-box,
    .recommendation-card,
    .focus-card,
    .rail-details,
    .repair-card,
    .repair-details {
      border-radius: 4px;
      box-shadow: none;
    }
    .metric-tile {
      min-height: 74px;
      padding: 11px;
      background: #ffffff;
    }
    .metric-tile strong {
      margin: 5px 0 2px;
      font-size: 20px;
    }
    .stage-grid {
      gap: 8px;
    }
    .stage-card {
      min-height: 82px;
      padding: 11px;
      border-top-width: 0;
      border-left: 4px solid #9db0c3;
    }
    .stage-card:hover {
      transform: none;
      box-shadow: none;
      background: #fafbfc;
    }
    .stage-card.ready { border-left-color: var(--green); }
    .stage-card.attention { border-left-color: #c78105; }
    .stage-card.blocked { border-left-color: var(--red); }
    .stage-card strong {
      margin: 4px 0;
      font-size: 14px;
    }
    .operator-grid {
      gap: 12px;
    }
    .workbench-panel {
      padding: 14px;
    }
    .workbench-panel h2,
    .focus-card h2,
    .decision-box h2 {
      font-size: 15px;
    }
    .lane-grid {
      gap: 6px;
    }
    .lane-item {
      min-height: 64px;
      border-radius: 4px;
      border-top-width: 0;
      border-left: 4px solid #9db0c3;
      padding: 9px;
      background: #ffffff;
    }
    .lane-item:hover {
      transform: none;
      background: #fafbfc;
    }
    .lane-item strong {
      font-size: 20px;
    }
    .lane-item.ready { border-left-color: var(--green); }
    .lane-item.attention { border-left-color: #c78105; }
    .lane-item.blocked { border-left-color: var(--red); }
    .mapping-target-row {
      border-radius: 4px;
      background: #ffffff;
    }
    .command-block,
    pre {
      border-radius: 4px;
      background: #f7f9fb;
      color: #1f2937;
      border: 1px solid var(--line);
      box-shadow: none;
    }
    .command-header button,
    .note-templates button,
    .case-command-bar button {
      border-radius: 4px;
      background: #f7f9fb;
      border-color: var(--line);
      color: #334155;
    }
    .record-header {
      border-radius: 4px;
      padding: 16px;
    }
    .record-header h2 {
      font-size: 21px;
    }
    .cockpit {
      gap: 8px;
    }
    .cockpit-item {
      min-height: 92px;
      border-radius: 4px;
      border-top-width: 0;
      border-left: 4px solid #b7c4d2;
      box-shadow: none;
    }
    .review-guide {
      margin: 0 0 10px;
      padding: 14px;
      border: 1px solid var(--line);
      border-left: 4px solid var(--accent);
      border-radius: 4px;
      background: #ffffff;
    }
    .review-guide.red {
      border-left-color: var(--red);
    }
    .review-guide.yellow {
      border-left-color: #c78105;
    }
    .review-guide.green {
      border-left-color: var(--green);
    }
    .review-guide span {
      color: #7b8796;
      font-size: 11px;
      font-weight: 900;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }
    .review-guide h2 {
      margin: 4px 0 6px;
      font-size: 18px;
      line-height: 1.2;
    }
    .review-guide p {
      margin: 0;
      color: #465466;
      font-weight: 750;
      line-height: 1.35;
    }
    .guide-steps {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 8px;
      margin-top: 10px;
    }
    .guide-step {
      padding: 9px;
      border: 1px solid var(--line);
      border-radius: 4px;
      background: #fafbfc;
    }
    .guide-step strong {
      display: block;
      margin-bottom: 4px;
      color: var(--ink);
      font-size: 12px;
    }
    .guide-step small {
      display: block;
      color: #536173;
      font-weight: 700;
      line-height: 1.3;
    }
    .case-command-bar {
      border-radius: 4px;
      box-shadow: none;
      background: #ffffff;
      backdrop-filter: none;
    }
    .case-command-bar button.active {
      background: #263445;
      border-color: #263445;
    }
    .approval-panel {
      margin: 0 0 14px;
      padding: 14px;
      border: 1px solid var(--line);
      border-left: 4px solid #c78105;
      border-radius: 4px;
      background: #ffffff;
    }
    .approval-summary-panel {
      margin: 0 0 14px;
      padding: 16px;
      border: 1px solid var(--line);
      border-left: 4px solid var(--accent);
      border-radius: 4px;
      background: #ffffff;
    }
    .approval-summary-header {
      display: grid;
      gap: 4px;
      margin-bottom: 10px;
      padding-bottom: 10px;
      border-bottom: 1px solid var(--line);
    }
    .approval-summary-header span {
      color: #7b8796;
      font-size: 11px;
      font-weight: 900;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }
    .approval-summary-header h2 {
      margin: 0;
      font-size: 18px;
      line-height: 1.2;
    }
    .approval-summary-header p {
      margin: 0;
      color: #4d5a6b;
      font-weight: 750;
    }
    .approval-statements {
      display: grid;
      gap: 10px;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .approval-statement {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 164px;
      gap: 12px;
      align-items: start;
      padding: 12px;
      border: 1px solid var(--line);
      border-left: 4px solid #8795a6;
      border-radius: 4px;
      background: #fafbfc;
    }
    .approval-statement.blocker {
      border-left-color: var(--red);
      background: #fff8f8;
    }
    .approval-statement.required {
      border-left-color: #c78105;
      background: #fffdf7;
    }
    .approval-statement.verify {
      border-left-color: var(--green);
      background: #fbfdfc;
    }
    .approval-statement strong {
      display: block;
      margin-bottom: 6px;
      color: var(--ink);
      font-size: 14px;
    }
    .approval-statement p {
      margin: 0;
      color: #263445;
      font-size: 13px;
      font-weight: 800;
      line-height: 1.35;
    }
    .approval-statement small {
      display: block;
      margin-top: 6px;
      color: #536173;
      font-size: 11px;
      font-weight: 750;
      line-height: 1.3;
    }
    .approval-statement small b {
      color: #334155;
      font-weight: 900;
    }
    .approval-header {
      display: grid;
      gap: 3px;
      margin-bottom: 10px;
      padding-bottom: 10px;
      border-bottom: 1px solid var(--line);
    }
    .approval-header span {
      color: #7b8796;
      font-size: 11px;
      font-weight: 900;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }
    .approval-header h2 {
      margin: 0;
      font-size: 17px;
      line-height: 1.2;
    }
    .approval-header p {
      margin: 0;
      color: #5d6979;
      font-weight: 650;
    }
    .approval-scope {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 8px;
    }
    .approval-scope span {
      padding: 4px 7px;
      border: 1px solid var(--line);
      border-radius: 4px;
      background: #f7f9fb;
      color: #465466;
      font-size: 11px;
      font-weight: 850;
    }
    .approval-list {
      display: grid;
      gap: 8px;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .approval-item {
      display: grid;
      grid-template-columns: 28px minmax(0, 1fr);
      gap: 10px;
      align-items: start;
      padding: 10px;
      border: 1px solid var(--line);
      border-left: 4px solid #8795a6;
      border-radius: 4px;
      background: #fafbfc;
    }
    .approval-item.blocker {
      border-left-color: var(--red);
      background: #fff8f8;
    }
    .approval-item.required {
      border-left-color: #c78105;
      background: #fffdf7;
    }
    .approval-item.verify {
      border-left-color: var(--green);
    }
    .approval-number {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      border: 1px solid var(--line);
      border-radius: 4px;
      background: #ffffff;
      color: #465466;
      font-size: 12px;
      font-weight: 900;
    }
    .approval-title-row {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
      margin-bottom: 5px;
    }
    .approval-item strong {
      color: var(--ink);
    }
    .approval-item small,
    .approval-meaning,
    .approval-evidence,
    .approval-if-not {
      display: block;
      color: #536173;
      font-weight: 650;
      line-height: 1.35;
      overflow-wrap: anywhere;
    }
    .approval-meaning {
      margin: 0 0 6px;
      color: #263445;
      font-size: 12px;
      font-weight: 800;
    }
    .approval-evidence,
    .approval-if-not {
      margin: 2px 0 0;
      font-size: 12px;
    }
    .approval-evidence span,
    .approval-if-not span {
      color: #7b8796;
      font-size: 10px;
      font-weight: 900;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .approval-item em {
      min-width: 62px;
      padding: 3px 6px;
      border: 1px solid var(--line);
      border-radius: 4px;
      background: #ffffff;
      color: #536173;
      font-size: 11px;
      font-style: normal;
      font-weight: 850;
      text-align: center;
    }
    .approval-confirm-label {
      justify-self: stretch;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      min-height: 38px;
      padding: 7px 9px;
      border: 1px solid var(--line);
      border-radius: 4px;
      background: #ffffff;
      color: #334155;
      font-size: 12px;
      font-weight: 850;
      line-height: 1.2;
      cursor: pointer;
    }
    .approval-confirm-label input {
      width: 14px;
      height: 14px;
      margin: 0;
      accent-color: var(--green);
    }
    .approval-progress {
      margin-top: 8px;
      padding: 7px 9px;
      border: 1px solid var(--line);
      border-left: 4px solid #c78105;
      border-radius: 4px;
      background: #fffdf7;
      color: #334155;
      font-size: 12px;
      font-weight: 850;
    }
    .approval-progress.ready {
      border-left-color: var(--green);
      background: #f7fbf9;
    }
    .approval-rail-list {
      display: grid;
      gap: 8px;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .approval-rail-item {
      display: grid;
      grid-template-columns: 24px minmax(0, 1fr);
      gap: 8px;
      padding: 8px;
      border: 1px solid var(--line);
      border-left: 4px solid #8795a6;
      border-radius: 4px;
      background: #fafbfc;
    }
    .approval-rail-item.blocker {
      border-left-color: var(--red);
      background: #fff8f8;
    }
    .approval-rail-item.required {
      border-left-color: #c78105;
      background: #fffdf7;
    }
    .approval-rail-item.verify {
      border-left-color: var(--green);
    }
    .approval-rail-item .approval-number {
      width: 20px;
      height: 20px;
      font-size: 11px;
    }
    .approval-rail-item strong {
      display: block;
      margin-bottom: 2px;
      font-size: 12px;
      line-height: 1.25;
    }
    .approval-rail-item small {
      display: block;
      color: #536173;
      font-size: 11px;
      font-weight: 650;
      line-height: 1.3;
      overflow-wrap: anywhere;
    }
    .approval-rail-item em {
      display: inline-block;
      margin-top: 5px;
      padding: 2px 5px;
      border: 1px solid var(--line);
      border-radius: 4px;
      background: #ffffff;
      color: #536173;
      font-size: 10px;
      font-style: normal;
      font-weight: 850;
      text-transform: uppercase;
    }
    .rail-confirmed {
      display: block;
      margin-top: 5px;
      font-size: 10px;
      font-weight: 900;
      text-transform: uppercase;
    }
    .rail-confirmed.yes {
      color: #13724f;
    }
    .rail-confirmed.pending {
      color: #7b8796;
    }
    .recommendation-card.yellow,
    .recommendation-card.red,
    .recommendation-card.green,
    .repair-panel {
      background: #ffffff;
      border-top-width: 0;
      border-left: 4px solid var(--line-strong);
    }
    .recommendation-card.yellow,
    .repair-panel {
      border-left-color: #c78105;
    }
    .recommendation-card.red {
      border-left-color: var(--red);
    }
    .recommendation-card.green {
      border-left-color: var(--green);
    }
    .decision-actions button {
      border-radius: 4px;
    }
    body.review-mode .metrics {
      display: none;
    }
    .focused-review-layout {
      display: block;
      max-width: 1180px;
    }
    .focused-review-layout .case-main {
      display: grid;
      gap: 12px;
    }
    .focused-review-layout .record-header {
      margin-bottom: 0;
    }
    .review-action-summary,
    .plain-review-card {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 290px;
      gap: 16px;
      align-items: center;
      padding: 16px;
      border: 1px solid var(--line);
      border-left: 4px solid var(--line-strong);
      border-radius: 4px;
      background: #ffffff;
    }
    .review-action-summary.red {
      border-left-color: var(--red);
      background: #fff8f8;
    }
    .review-action-summary.yellow {
      border-left-color: #c78105;
      background: #fffdf7;
    }
    .review-action-summary.green {
      border-left-color: var(--green);
      background: #f7fbf9;
    }
    .plain-review-card {
      grid-template-columns: minmax(0, 1fr) 360px;
      align-items: stretch;
      padding: 18px;
      border-left-width: 6px;
    }
    .plain-review-card.red {
      border-left-color: var(--red);
      background: #fff8f8;
    }
    .plain-review-card.yellow {
      border-left-color: #c78105;
      background: #fffdf7;
    }
    .plain-review-card.green {
      border-left-color: var(--green);
      background: #f7fbf9;
    }
    .plain-review-card span,
    .plain-steps span,
    .button-meaning-grid span,
    .decision-helper span {
      display: block;
      margin-bottom: 5px;
      color: #7b8796;
      font-size: 11px;
      font-weight: 900;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }
    .plain-review-card h2 {
      margin: 0;
      font-size: 24px;
      line-height: 1.12;
    }
    .plain-review-card p {
      max-width: 760px;
      margin: 8px 0 0;
      color: #334155;
      font-size: 15px;
      font-weight: 850;
      line-height: 1.4;
    }
    .plain-steps {
      display: grid;
      gap: 8px;
      padding: 12px;
      border: 1px solid var(--line);
      border-radius: 4px;
      background: rgba(255, 255, 255, 0.72);
    }
    .plain-steps ol {
      display: grid;
      gap: 7px;
      margin: 0;
      padding-left: 22px;
      color: #263445;
      font-weight: 900;
      line-height: 1.35;
    }
    .button-meaning-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 8px;
      margin: 12px 0;
    }
    .button-meaning-grid.red {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
    .button-meaning {
      padding: 10px;
      border: 1px solid var(--line);
      border-radius: 4px;
      background: #fafbfc;
    }
    .button-meaning strong {
      display: block;
      margin-bottom: 4px;
      color: #1f2937;
      font-size: 13px;
      line-height: 1.2;
    }
    .button-meaning small {
      display: block;
      color: #536173;
      font-size: 12px;
      font-weight: 750;
      line-height: 1.3;
    }
    .review-action-summary span,
    .decision-box-heading span {
      display: block;
      margin-bottom: 4px;
      color: #7b8796;
      font-size: 11px;
      font-weight: 900;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }
    .review-action-summary h2,
    .decision-box-heading h2 {
      margin: 0;
      font-size: 20px;
      line-height: 1.15;
    }
    .review-action-summary p,
    .decision-box-heading p {
      margin: 6px 0 0;
      color: #465466;
      font-weight: 800;
      line-height: 1.35;
    }
    .review-action-side {
      display: grid;
      gap: 6px;
      padding: 10px;
      border: 1px solid var(--line);
      border-radius: 4px;
      background: rgba(255, 255, 255, 0.65);
    }
    .review-action-side strong {
      color: var(--ink);
      font-size: 15px;
    }
    .review-action-side small {
      color: #667386;
      font-weight: 800;
    }
    .review-nav-buttons {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 6px;
      margin-top: 4px;
    }
    .review-nav-buttons button {
      min-height: 30px;
      padding: 5px 7px;
      font-size: 11px;
    }
    .focused-decision-box {
      padding: 16px;
      border-left: 4px solid #263445;
      background: #ffffff;
    }
    .focused-decision-box.red {
      border-left-color: var(--red);
    }
    .focused-decision-box.yellow {
      border-left-color: #c78105;
    }
    .decision-problems {
      margin: 0 0 12px;
      padding: 12px;
      border: 1px solid var(--line);
      border-radius: 4px;
      background: #fafbfc;
    }
    .decision-problems span {
      display: block;
      margin-bottom: 7px;
      color: #7b8796;
      font-size: 11px;
      font-weight: 900;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }
    .decision-problems ul {
      display: grid;
      gap: 6px;
      margin: 0;
      padding-left: 18px;
      color: #334155;
      font-weight: 800;
    }
    .primary-actions {
      margin-top: 10px;
    }
    .primary-actions.red-case-actions {
      grid-template-columns: minmax(0, 1.1fr) minmax(0, 1.1fr) minmax(0, 0.8fr);
    }
    .approval-override {
      margin-top: 12px;
      border: 1px solid #efc2c6;
      border-radius: 4px;
      background: #fff8f8;
      overflow: hidden;
    }
    .approval-override > summary {
      padding: 12px 14px;
      color: #7d2027;
      font-weight: 900;
    }
    .approval-override-body {
      display: grid;
      gap: 10px;
      padding: 0 14px 14px;
    }
    .approval-override-body > p {
      margin: 0;
      color: #5f4550;
      font-weight: 800;
    }
    .approval-override .approval-summary-panel {
      margin-bottom: 0;
    }
    .decision-box-heading {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(260px, 420px);
      gap: 14px;
      align-items: start;
      margin-bottom: 12px;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--line);
    }
    .focused-decision-box textarea {
      min-height: 76px;
    }
    .decision-helper {
      margin: 0 0 10px;
      padding: 10px 12px;
      border: 1px solid var(--line);
      border-left: 4px solid var(--accent);
      border-radius: 4px;
      background: #f7fbff;
      color: #334155;
      font-weight: 850;
    }
    .decision-helper p {
      margin: 0;
    }
    .focused-decision-box .decision-actions {
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 8px;
    }
    .evidence-drawer,
    .case-utility-details .rail-details {
      border: 1px solid var(--line);
      border-radius: 4px;
      background: #ffffff;
    }
    .evidence-drawer {
      margin: 0 0 2px;
      padding: 0;
      overflow: hidden;
    }
    .evidence-drawer > summary {
      padding: 14px 16px;
      color: #334155;
      background: #f7f9fb;
      border-bottom: 1px solid transparent;
    }
    .evidence-drawer[open] > summary {
      border-bottom-color: var(--line);
    }
    .evidence-drawer-body {
      padding: 14px;
    }
    .case-utility-details {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }
    .case-utility-details .rail-details {
      padding: 12px;
    }
    table,
    .data-table {
      font-size: 12px;
    }
    th {
      background: #f3f5f7;
      letter-spacing: 0.02em;
    }
    .hidden { display: none !important; }
    @media (max-width: 900px) {
      header { padding: 12px 14px; }
      .topline, main, .app-tabs { width: calc(100vw - 28px); }
      main { grid-template-columns: 1fr; }
      nav {
        position: static;
        order: 2;
        height: auto;
      }
      .workspace { order: 1; }
      .case-list { max-height: 420px; }
      .case-layout { grid-template-columns: 1fr; }
      .decision-panel { position: static; }
      .case-command-bar { position: static; }
      .cockpit { grid-template-columns: 1fr; }
      .guide-steps { grid-template-columns: 1fr; }
      .repair-panel, .repair-grid, .repair-detail-grid { grid-template-columns: 1fr; }
      .workbench-hero, .operator-grid, .stage-grid, .metric-grid, .lane-grid { grid-template-columns: 1fr; }
      .hero-actions { justify-content: flex-start; }
      .facts { grid-template-columns: 1fr; }
      .topline { grid-template-columns: 1fr; }
      .sort-options { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .review-action-summary,
      .plain-review-card,
      .decision-box-heading,
      .button-meaning-grid,
      .button-meaning-grid.red,
      .case-utility-details {
        grid-template-columns: 1fr;
      }
      .review-nav-buttons,
      .focused-decision-box .decision-actions {
        grid-template-columns: 1fr;
      }
      .approval-item {
        grid-template-columns: 28px minmax(0, 1fr);
      }
      .approval-item em {
        justify-self: start;
      }
      .approval-confirm-label {
        grid-column: 2;
        justify-self: start;
        min-width: 110px;
      }
      .approval-statement {
        grid-template-columns: 1fr;
      }
      .approval-statement .approval-confirm-label {
        grid-column: auto;
      }
    }
  </style>
</head>
<body>
  <header>
    <div class="topline">
      <div>
        <h1>Tier 1 Appraisal Review</h1>
        <p class="subtitle">Open a case, check what is missing or wrong, then choose Approve, Needs Fix, Reject, or Skip.</p>
        <div class="progress-row">
          <div class="progress-track"><div id="progressFill" class="progress-fill"></div></div>
          <div id="progressLabel" class="progress-label">Reviewed 0 / 0</div>
        </div>
        <div id="metrics" class="metrics"></div>
      </div>
      <div class="top-actions">
        <button id="queueToggle" class="queue-toggle" type="button" aria-pressed="false">Show queue</button>
        <label class="reviewer">Reviewer <input id="reviewer" value="${staticPayload ? "Demo Reviewer" : "Zachary"}" autocomplete="off"></label>
      </div>
    </div>
    <div id="appTabs" class="app-tabs" aria-label="Workbench stages">
      <button class="app-tab active" data-view="overview" type="button">Overview</button>
      <button class="app-tab" data-view="intake" type="button">Import</button>
      <button class="app-tab" data-view="mapping" type="button">Mapping</button>
      <button class="app-tab" data-view="review" type="button">Tier Review</button>
      <button class="app-tab" data-view="repairs" type="button">Repairs</button>
      <button class="app-tab" data-view="export" type="button">Export</button>
      <button class="app-tab" data-view="audit" type="button">Audit</button>
    </div>
  </header>
  <main>
    <nav>
      <div class="queue-head">
        <div>
          <span>Review queue</span>
          <strong id="queueCount">0 visible</strong>
        </div>
        <span id="queueMode">Tier 1</span>
      </div>
      <div class="queue-tools">
        <input id="caseSearch" type="search" placeholder="Search case, status, city">
        <div class="sort-control">
          <span>Sort</span>
          <div id="queueSortOptions" class="sort-options" role="listbox" aria-label="Sort review queue">
            <button type="button" class="sort-option active" data-sort="priority" role="option" aria-selected="true">Priority</button>
            <button type="button" class="sort-option" data-sort="case" role="option" aria-selected="false">Case ID</button>
            <button type="button" class="sort-option" data-sort="attention" role="option" aria-selected="false">Attention</button>
            <button type="button" class="sort-option" data-sort="value-desc" role="option" aria-selected="false">Value high</button>
            <button type="button" class="sort-option" data-sort="value-asc" role="option" aria-selected="false">Value low</button>
          </div>
        </div>
        <div class="filter-chips">
          <button class="filter-chip active" data-mode="all">All</button>
          <button class="filter-chip" data-mode="unreviewed">Unreviewed</button>
          <button class="filter-chip" data-mode="attention">Attention</button>
          <button class="filter-chip" data-mode="red">Red</button>
          <button class="filter-chip" data-mode="yellow">Yellow</button>
          <button class="filter-chip" data-mode="reviewed">Reviewed</button>
        </div>
      </div>
      <div class="nav-actions">
        <button id="prevBtn">Previous</button>
        <button id="nextBtn">Next</button>
        <button id="flaggedBtn">Jump flagged</button>
        <button id="bulkBtn" class="green">Approve green</button>
      </div>
      <div id="caseList" class="case-list"></div>
    </nav>
    <div class="workspace">
      <div id="caseRoot"></div>
    </div>
  </main>
  <script>
    const sessionOutput = ${JSON.stringify(options.output)};
    const followupCommands = ${JSON.stringify(commands)};
    const staticPayload = ${JSON.stringify(staticPayload)};
    const isStaticDemo = Boolean(staticPayload);
    const staticDecisionStorageKey = 'appraisalStaticDemoDecisions';
    const defaultReviewer = ${JSON.stringify(staticPayload ? "Demo Reviewer" : "Zachary")};
    let state = null;
    let workbench = null;
    let index = 0;
    let activeView = isStaticDemo ? 'review' : 'overview';
    let queuePreference = localStorage.getItem('appraisalQueuePreference') || 'auto';
    let filters = { mode: 'all', query: '', sort: 'priority', attentionOnlyRows: false };
    const approvalConfirmations = new Map();
    const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
    const fmtMoney = value => typeof value === 'number' ? money.format(value) : 'Missing';
    const fmt = value => value == null || value === '' ? 'Missing' : String(value);
    const humanize = value => fmt(value).replace(/_/g, ' ');
    const humanizeList = values => Array.isArray(values) && values.length ? values.map(humanize).join('; ') : 'None';
    const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

    async function load() {
      if (isStaticDemo) {
        state = structuredClone(staticPayload.state);
        workbench = structuredClone(staticPayload.workbench);
        applyStaticDecisions();
        render();
        return;
      }
      const [stateRes, workbenchRes] = await Promise.all([
        fetch('/api/state'),
        fetch('/api/workbench')
      ]);
      state = await stateRes.json();
      workbench = await workbenchRes.json();
      render();
    }

    function readStaticDecisions() {
      if (!isStaticDemo) return [];
      try {
        const parsed = JSON.parse(localStorage.getItem(staticDecisionStorageKey) || '[]');
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }

    function writeStaticDecisions(decisions) {
      if (!isStaticDemo) return;
      localStorage.setItem(staticDecisionStorageKey, JSON.stringify(decisions));
    }

    function applyStaticDecisions() {
      if (!isStaticDemo || !state) return;
      const decisions = new Map(readStaticDecisions().map(decision => [decision.case_id, decision]));
      state.cases.forEach(item => {
        const decision = decisions.get(item.case_id);
        if (decision) {
          item.decision_status = decision.status;
          item.decision = {
            status: decision.status,
            reviewer: decision.reviewer || null,
            reviewed_at: decision.reviewed_at || null,
            notes: decision.notes || null
          };
        } else {
          item.decision_status = 'unreviewed';
          item.decision = { status: 'unreviewed', reviewer: null, reviewed_at: null, notes: null };
        }
      });
      state.progress = calculateProgress(state.cases);
    }

    function calculateProgress(cases) {
      return {
        total: cases.length,
        reviewed: cases.filter(item => item.decision_status !== 'unreviewed').length,
        approved: cases.filter(item => item.decision_status === 'approved').length,
        needs_revision: cases.filter(item => item.decision_status === 'needs_revision').length,
        rejected: cases.filter(item => item.decision_status === 'rejected').length,
        skipped: cases.filter(item => item.decision_status === 'skipped').length,
        unreviewed: cases.filter(item => item.decision_status === 'unreviewed').length,
        green: cases.filter(item => item.recommendation.level === 'green').length,
        yellow: cases.filter(item => item.recommendation.level === 'yellow').length,
        red: cases.filter(item => item.recommendation.level === 'red').length,
        adjusted_price_rows_needing_attention: cases.reduce((sum, item) => sum + item.comps.filter(comp => comp.needs_manual_attention).length, 0)
      };
    }

    function visibleCases() {
      if (!state) return [];
      return state.cases.filter(item => {
        const query = filters.query.trim().toLowerCase();
        const subject = item.subject || {};
        const haystack = [
          item.case_id,
          item.decision_status,
          item.recommendation.level,
          item.recommendation.label,
          subject.city,
          subject.state,
          item.tier.tier1_status
        ].filter(Boolean).join(' ').toLowerCase();
        if (query && !haystack.includes(query)) return false;
        if (filters.mode === 'unreviewed' && item.decision_status !== 'unreviewed') return false;
        if (filters.mode === 'attention' && !needsAttention(item)) return false;
        if (filters.mode === 'red' && item.recommendation.level !== 'red') return false;
        if (filters.mode === 'yellow' && item.recommendation.level !== 'yellow') return false;
        if (filters.mode === 'reviewed' && item.decision_status === 'unreviewed') return false;
        if (filters.mode === 'approved' && item.decision_status !== 'approved') return false;
        if (filters.mode === 'needs_revision' && item.decision_status !== 'needs_revision') return false;
        if (filters.mode === 'rejected' && item.decision_status !== 'rejected') return false;
        return true;
      }).sort(compareCases);
    }

    function needsAttention(item) {
      return item.recommendation.level !== 'green' || item.comps.some(comp => comp.needs_manual_attention);
    }

    function attentionRows(item) {
      return item.comps.filter(comp => comp.needs_manual_attention).length;
    }

    function priorityScore(item) {
      const levelScore = item.recommendation.level === 'red' ? 0 : item.recommendation.level === 'yellow' ? 1 : 2;
      const reviewedPenalty = item.decision_status === 'unreviewed' ? 0 : 10;
      return levelScore + reviewedPenalty;
    }

    function compareCases(a, b) {
      if (filters.sort === 'case') return a.case_id.localeCompare(b.case_id);
      if (filters.sort === 'attention') return attentionRows(b) - attentionRows(a) || priorityScore(a) - priorityScore(b) || a.case_id.localeCompare(b.case_id);
      const valueA = a.reconciliation.final_opinion_of_value ?? -Infinity;
      const valueB = b.reconciliation.final_opinion_of_value ?? -Infinity;
      if (filters.sort === 'value-desc') return valueB - valueA || a.case_id.localeCompare(b.case_id);
      if (filters.sort === 'value-asc') return valueA - valueB || a.case_id.localeCompare(b.case_id);
      return priorityScore(a) - priorityScore(b) || attentionRows(b) - attentionRows(a) || a.case_id.localeCompare(b.case_id);
    }

    function currentCase() {
      const cases = visibleCases();
      if (index >= cases.length) index = Math.max(0, cases.length - 1);
      return cases[index] || null;
    }

    function render() {
      renderShell();
      renderProgress();
      renderWorkbenchTabs();
      renderSortMenu();
      renderList();
      renderWorkspace();
    }

    function queueVisible() {
      if (queuePreference === 'show') return true;
      if (queuePreference === 'hide') return false;
      return false;
    }

    function renderShell() {
      const visible = queueVisible();
      document.body.classList.toggle('queue-hidden', !visible);
      document.body.classList.toggle('review-mode', activeView === 'review');
      const queueToggle = document.getElementById('queueToggle');
      queueToggle.textContent = visible ? 'Hide queue' : 'Show queue';
      queueToggle.setAttribute('aria-pressed', visible ? 'true' : 'false');
    }

    function renderWorkbenchTabs() {
      const stageById = new Map((workbench?.stages || []).map(stage => [stage.id, stage]));
      document.querySelectorAll('.app-tab').forEach(button => {
        const viewName = button.dataset.view || 'overview';
        button.classList.toggle('active', viewName === activeView);
        const stage = stageById.get(viewName);
        button.dataset.status = stage?.status || '';
        button.title = stage?.detail || '';
      });
    }

    function renderWorkspace() {
      if (activeView === 'review') return renderCase();
      if (activeView === 'intake') return renderIntakeView();
      if (activeView === 'mapping') return renderMappingView();
      if (activeView === 'repairs') return renderRepairsView();
      if (activeView === 'export') return renderExportView();
      if (activeView === 'audit') return renderAuditView();
      return renderOverviewView();
    }

    function renderSortMenu() {
      document.querySelectorAll('.sort-option').forEach(button => {
        const active = button.dataset.sort === filters.sort;
        button.classList.toggle('active', active);
        button.setAttribute('aria-selected', active ? 'true' : 'false');
      });
    }

    function renderProgress() {
      const p = state.progress;
      document.getElementById('progressFill').style.width = p.total ? ((p.reviewed / p.total) * 100) + '%' : '0%';
      document.getElementById('progressLabel').textContent = \`Reviewed \${p.reviewed} / \${p.total}\`;
      const bulkBtn = document.getElementById('bulkBtn');
      bulkBtn.disabled = p.green === 0;
      bulkBtn.textContent = p.green === 0 ? 'No green cases' : \`Approve \${p.green} green\`;
      document.getElementById('metrics').innerHTML = [
        ['Approved', p.approved],
        ['Needs Fix', p.needs_revision],
        ['Rejected', p.rejected],
        ['Skipped/unreviewed', p.skipped + p.unreviewed],
        ['Green', p.green],
        ['Yellow', p.yellow],
        ['Red', p.red],
        ['Adjusted attention rows', p.adjusted_price_rows_needing_attention]
      ].map(([label, value]) => \`<span class="metric"><strong>\${escape(value)}</strong> \${escape(label)}</span>\`).join('');
    }

    function renderList() {
      const cases = visibleCases();
      document.getElementById('queueCount').textContent = \`\${cases.length} visible\`;
      document.querySelectorAll('.filter-chip').forEach(button => {
        button.classList.toggle('active', button.dataset.mode === filters.mode);
      });
      document.getElementById('caseList').innerHTML = cases.map((item, i) => {
        const subject = item.subject || {};
        const location = [subject.city, subject.state].filter(Boolean).join(', ') || 'Location missing';
        const compSummary = \`\${item.comps.length} comp\${item.comps.length === 1 ? '' : 's'} · \${attentionRows(item)} attention\`;
        const approvals = approvalItems(item);
        return \`
        <button class="case-tab \${item.recommendation.level} \${i === index ? 'active' : ''}" onclick="selectCase(\${i})">
          <span class="case-topline">
            <strong class="case-id">\${escape(item.case_id)}</strong>
            <span class="case-value">\${escape(fmtMoney(item.reconciliation.final_opinion_of_value))}</span>
          </span>
          <small class="case-reason">\${escape(item.recommendation.label)}</small>
          <span class="case-meta">\${escape(location)} · \${escape(compSummary)}</span>
          <span class="case-status-row">
            <span class="level-chip \${item.recommendation.level}">\${escape(item.recommendation.level)}</span>
            <span class="level-chip decision-chip">\${escape(item.decision_status)}</span>
          </span>
          \${queueApprovalPreview(item, approvals)}
        </button>
      \`;
      }).join('') || '<div class="empty-queue">No matching cases</div>';
    }

    function approvalItems(item) {
      const items = [];
      const subject = item.subject || {};
      const localFilled = item.comps.filter(comp => comp.needs_manual_attention).length;
      const missingFields = item.missing_fields || [];
      const coveredMissing = new Set();
      const missingMatches = (field, patterns) => patterns.some(pattern => String(field).toLowerCase().includes(pattern));
      const coverMissing = (patterns) => {
        missingFields.forEach(field => {
          if (missingMatches(field, patterns)) coveredMissing.add(field);
        });
      };
      const missingCore = [];
      if (item.comps.length === 0) missingCore.push('selected comparables');
      if (item.reconciliation.final_opinion_of_value == null) missingCore.push('final opinion of value');
      if (!item.reconciliation.narrative) missingCore.push('reconciliation narrative');
      if (missingCore.length) {
        coverMissing(['selected_comparable', 'comparables', 'final_opinion', 'final_value', 'narrative']);
        items.push({
          level: 'blocker',
          title: 'Training evidence',
          queue: missingCore.join(', '),
          question: \`Can this case be used for training even though \${missingCore.join(', ')} \${missingCore.length === 1 ? 'is' : 'are'} missing?\`,
          detail: \`Missing: \${missingCore.join(', ')}. Do not approve unless this is repaired or you document an override.\`,
          approveText: \`You are approving that missing \${missingCore.join(', ')} does not make this case unusable for training.\`,
          evidence: 'Check the selected comps table, final value, and reconciliation narrative sections.',
          ifNot: 'Use Needs Fix for parser or mapping repair, or Reject if the source is not usable.'
        });
      }
      if (!subject.condition || !subject.quality) {
        const missingSubjectRatings = [
          !subject.condition ? 'condition' : null,
          !subject.quality ? 'quality' : null
        ].filter(Boolean);
        coverMissing(['subject_condition', 'subject_quality']);
        items.push({
          level: 'required',
          title: 'Subject condition / quality',
          queue: \`subject \${missingSubjectRatings.join(' and ')} missing\`,
          question: \`Is it acceptable for this training case that subject \${missingSubjectRatings.join(' and ')} \${missingSubjectRatings.length === 1 ? 'is' : 'are'} missing?\`,
          detail: \`Confirm missing subject \${missingSubjectRatings.join(' and ')} \${missingSubjectRatings.length === 1 ? 'is' : 'are'} acceptable for this Tier 1 case.\`,
          approveText: \`You are approving that the missing subject \${missingSubjectRatings.join(' and ')} \${missingSubjectRatings.length === 1 ? 'is' : 'are'} acceptable for this training example.\`,
          evidence: 'Check the Subject section and any available source notes for condition and quality.',
          ifNot: 'Use Needs Fix if a mapping/parser repair should recover it; Reject if the missing rating makes the case unreliable.'
        });
      }
      if (missingFields.some(field => missingMatches(field, ['subject_gla']))) {
        coverMissing(['subject_gla']);
        items.push({
          level: 'required',
          title: 'Subject GLA',
          queue: 'subject GLA missing',
          question: 'Is it acceptable for this training case that subject GLA is missing?',
          detail: 'Confirm the missing subject GLA is acceptable for this Tier 1 selected-comps/reconciliation example.',
          approveText: 'You are approving that missing subject GLA is acceptable for the intended Tier 1 training use.',
          evidence: 'Check the Subject section and source appraisal fields for subject GLA.',
          ifNot: 'Use Needs Fix if GLA should be mapped; Reject if the case should not train without it.'
        });
      }
      if (missingFields.some(field => missingMatches(field, ['comparable_gla']))) {
        coverMissing(['comparable_gla']);
        items.push({
          level: 'required',
          title: 'Comparable GLA',
          queue: 'comparable GLA missing',
          question: 'Is it acceptable for this training case that comparable GLA is missing?',
          detail: 'Confirm comparable GLA is not needed for the training use of this case, or mark it Needs Fix.',
          approveText: 'You are approving that missing comparable GLA does not invalidate this selected-comps/reconciliation example.',
          evidence: 'Check Selected Comps and the Tier limitations for comparable GLA coverage.',
          ifNot: 'Use Needs Fix if comparable GLA should be extracted before approval.'
        });
      }
      const otherMissing = missingFields.filter(field => !coveredMissing.has(field));
      if (otherMissing.length) {
        items.push({
          level: 'required',
          title: 'Other missing fields',
          queue: humanizeList(otherMissing),
          question: \`Are these missing fields acceptable for this training case: \${humanizeList(otherMissing)}?\`,
          detail: humanizeList(otherMissing),
          approveText: \`You are approving that these missing fields are acceptable: \${humanizeList(otherMissing)}.\`,
          evidence: 'Check the case snapshot, subject, comps, and reconciliation sections for the listed fields.',
          ifNot: 'Use Needs Fix if the fields should be mapped before training.'
        });
      }
      if (item.comps.length > 0) {
        items.push({
          level: 'verify',
          title: 'Selected comparables',
          queue: \`\${item.comps.length} selected comp\${item.comps.length === 1 ? '' : 's'}\`,
          question: \`Are the \${item.comps.length} selected comp\${item.comps.length === 1 ? '' : 's'} and key comp facts correct enough for training?\`,
          detail: \`Verify \${item.comps.length} extracted selected comp\${item.comps.length === 1 ? '' : 's'} and the comp facts used for training.\`,
          approveText: \`You are approving that the \${item.comps.length} selected comp\${item.comps.length === 1 ? '' : 's'} and key facts are correct enough for training.\`,
          evidence: 'Check sale price, net adjustment, adjusted price, condition, quality, and sale date in Selected Comps.',
          ifNot: 'Use Needs Fix for extraction errors, or Reject if the comparable set is not reliable.'
        });
      }
      if (localFilled > 0) {
        items.push({
          level: 'required',
          title: 'Adjusted sale price rows',
          queue: \`\${localFilled} adjusted row\${localFilled === 1 ? '' : 's'} need review\`,
          question: \`Have the \${localFilled} adjusted sale price row\${localFilled === 1 ? '' : 's'} been checked and resolved enough for training?\`,
          detail: \`Check \${localFilled} row\${localFilled === 1 ? '' : 's'} where adjusted sale price needs manual attention or conflict review.\`,
          approveText: \`You are approving that \${localFilled} adjusted sale price row\${localFilled === 1 ? '' : 's'} \${localFilled === 1 ? 'has' : 'have'} been checked and resolved enough for training.\`,
          evidence: 'Check the Selected Comps check badge and Adjustment Sanity formula rows.',
          ifNot: 'Use Needs Fix if adjusted sale price mapping or conflict resolution needs repair.'
        });
      }
      if (item.reconciliation.final_opinion_of_value != null) {
        items.push({
          level: 'verify',
          title: 'Final value',
          queue: \`\${fmtMoney(item.reconciliation.final_opinion_of_value)} final value\`,
          question: \`Is the final opinion of value correct: \${fmtMoney(item.reconciliation.final_opinion_of_value)}?\`,
          detail: \`Verify final opinion of value: \${fmtMoney(item.reconciliation.final_opinion_of_value)}.\`,
          approveText: \`You are approving the final opinion of value: \${fmtMoney(item.reconciliation.final_opinion_of_value)}.\`,
          evidence: 'Check the Reconciliation section final opinion of value.',
          ifNot: 'Use Needs Fix if the value was extracted incorrectly.'
        });
      }
      if (item.reconciliation.narrative) {
        items.push({
          level: 'verify',
          title: 'Reconciliation narrative',
          queue: 'narrative extracted',
          question: 'Does the reconciliation narrative support the training example?',
          detail: 'Verify the extracted narrative supports the selected-comps training example.',
          approveText: 'You are approving that the reconciliation narrative supports the training example.',
          evidence: 'Read the Reconciliation narrative and caveats.',
          ifNot: 'Use Needs Fix if the narrative is missing, partial, or mismatched.'
        });
      }
      const warningList = (item.warnings || []).filter(warning => {
        if (['redacted_postal_code', 'redacted_street_address'].includes(warning)) return false;
        if (missingMatches(warning, ['missing_subject_condition', 'missing_subject_quality', 'missing_subject_gla', 'missing_comparable_gla'])) return false;
        if (missingCore.length && missingMatches(warning, ['missing_comparables', 'missing_final', 'narrative_missing'])) return false;
        return true;
      });
      if (warningList.length) {
        items.push({
          level: item.recommendation.level === 'red' ? 'blocker' : 'required',
          title: 'Parser warnings',
          queue: humanizeList(warningList),
          question: 'Do the parser warnings still leave this case reliable enough for training?',
          detail: humanizeList(warningList),
          approveText: \`You are approving that these parser warnings do not invalidate the case: \${humanizeList(warningList)}.\`,
          evidence: 'Scan the warning list, affected fields, and any related table rows.',
          ifNot: 'Use Needs Fix for parser/mapping repair, or Reject if the warnings make the case unreliable.'
        });
      }
      if (!items.length) {
        items.push({
          level: 'verify',
          title: 'Standard review',
          queue: 'spot-check all extracted facts',
          question: 'After spot-checking, is this case suitable for training?',
          detail: 'Spot-check extracted facts, comps, adjusted prices, final value, and narrative before approval.',
          approveText: 'You are approving that the extracted facts are suitable for training after a standard spot-check.',
          evidence: 'Review subject, comps, adjustments, final value, and narrative.',
          ifNot: 'Use Needs Fix or Reject instead of approving.'
        });
      }
      return items;
    }

    function queueApprovalPreview(item, items) {
      if (item.recommendation.level === 'red') {
        const issues = reviewIssues(item).slice(0, 3);
        return \`
        <span class="case-approval">
          <strong>Needs Fix or Reject</strong>
          <span class="case-approval-list">
            \${issues.map(issue => \`
              <span class="case-approval-point blocker">
                <span class="case-approval-dot"></span>
                <span>\${escape(issue)}</span>
              </span>
            \`).join('')}
          </span>
        </span>
      \`;
      }
      const visibleItems = items.slice(0, 3);
      const remaining = items.length - visibleItems.length;
      return \`
        <span class="case-approval">
          <strong>\${escape(items.length)} thing\${items.length === 1 ? '' : 's'} to check</strong>
          <span class="case-approval-list">
            \${visibleItems.map(approvalItem => \`
              <span class="case-approval-point \${escape(approvalItem.level)}">
                <span class="case-approval-dot"></span>
                <span>\${escape(approvalItem.title)}</span>
              </span>
            \`).join('')}
            \${remaining > 0 ? \`
              <span class="case-approval-point">
                <span class="case-approval-dot"></span>
                <span>+\${escape(remaining)} more</span>
              </span>
            \` : ''}
          </span>
        </span>
      \`;
    }

    function approvalDecisionContext(item, items) {
      if (item.recommendation.level === 'red') {
        return 'This case is not training-ready. Use Needs Fix if a parser or mapping repair could recover it. Use Reject if this source should stay out of training data.';
      }
      return \`Approve is locked until all \${items.length} things are checked. If anything is not acceptable, write a note and use Needs Fix or Reject.\`;
    }

    function approvalTitleKey(item) {
      return item.title;
    }

    function approvalSet(caseId) {
      if (!approvalConfirmations.has(caseId)) approvalConfirmations.set(caseId, new Set());
      return approvalConfirmations.get(caseId);
    }

    function isApprovalConfirmed(caseId, approvalItem) {
      return approvalSet(caseId).has(approvalTitleKey(approvalItem));
    }

    function approvalCheckbox(caseId, item) {
      return \`
        <label class="approval-confirm-label">
          <input
            class="approval-confirm"
            type="checkbox"
            data-case-id="\${escape(caseId)}"
            data-approval-title="\${escape(approvalTitleKey(item))}"
            onchange="toggleApprovalConfirmation(this)"
            \${isApprovalConfirmed(caseId, item) ? 'checked' : ''}
          >
          Yes, acceptable
        </label>
      \`;
    }

    function approvalStatementSummary(caseId, items) {
      return \`
        <section class="approval-summary-panel">
          <div class="approval-summary-header">
            <span>Things to check</span>
            <h2>Check these \${escape(items.length)} thing\${items.length === 1 ? '' : 's'} before you approve</h2>
            <p>Mark Yes only when you looked at it and it seems OK. If one is wrong or missing, choose Needs Fix or Reject.</p>
            <div class="approval-progress" data-approval-progress></div>
          </div>
          <ol class="approval-statements">
            \${items.map((item, itemIndex) => \`
              <li class="approval-statement \${escape(item.level)}">
                <div>
                  <strong>\${escape(itemIndex + 1)}. \${escape(item.title)}</strong>
                  <p>\${escape(item.question || item.approveText || item.detail)}</p>
                  <small><b>Look at:</b> \${escape(item.evidence || item.detail)}</small>
                  <small><b>If No or unsure:</b> \${escape(item.ifNot || 'Use Needs Fix or Reject instead of approving.')}</small>
                </div>
                \${approvalCheckbox(caseId, item)}
              </li>
            \`).join('')}
          </ol>
        </section>
      \`;
    }

    function renderOverviewView() {
      const root = document.getElementById('caseRoot');
      const p = state.progress;
      root.innerHTML = \`
        <div class="workbench-view">
          \${viewHero('Appraisal Training Workbench', 'One local surface for XML intake, mapping verification, Tier 1 review, repair tracking, export, and privacy checks.', [
            ['Review queue', 'review'],
            ['Mapping status', 'mapping'],
            ['Export gate', 'export']
          ])}
          <div class="metric-grid">
            \${metricTile('XML parsed', \`\${workbench?.intake?.parsed ?? 0}/\${workbench?.intake?.xml_files_found ?? 0}\`, 'Current private training run')}
            \${metricTile('Review progress', \`\${p.reviewed}/\${p.total}\`, \`\${p.unreviewed} still unreviewed\`)}
            \${metricTile('Verified mappings', workbench?.mapping?.verified_count ?? 0, 'Human-approved local mappings')}
            \${metricTile('Approved export', workbench?.export?.all_lines ?? 0, 'Approved JSONL lines')}
          </div>
          <div class="stage-grid">
            \${(workbench?.stages || []).map(stage => \`
              <button class="stage-card \${escape(stage.status)}" onclick="setView('\${escape(stage.id)}')">
                <span>\${escape(stage.status)}</span>
                <strong>\${escape(stage.label)}</strong>
                <small>\${escape(stage.detail)}</small>
              </button>
            \`).join('')}
          </div>
          <div class="operator-grid">
            <section class="workbench-panel full-span">
              <span class="panel-kicker">Review lane</span>
              <h2>Queue state</h2>
              \${reviewLane()}
            </section>
            <section class="workbench-panel">
              <span class="panel-kicker">Next attention</span>
              <h2>What needs work</h2>
              \${actionList(nextActions())}
            </section>
            <section class="workbench-panel">
              <span class="panel-kicker">Top blockers</span>
              <h2>Parser and review blockers</h2>
              \${blockerTable(workbench?.repairs?.top_blockers || [])}
            </section>
            <section class="workbench-panel full-span">
              <span class="panel-kicker">Run folders</span>
              <h2>Current local workspace</h2>
              \${pathList({
                'Input XMLs': workbench?.paths?.input_folder,
                'Training output': workbench?.paths?.training_output,
                'Review batch': workbench?.paths?.review_batch,
                'Session output': workbench?.paths?.session_output,
                'Mapping file': workbench?.paths?.mapping_file
              })}
            </section>
          </div>
        </div>
      \`;
    }

    function renderIntakeView() {
      const root = document.getElementById('caseRoot');
      root.innerHTML = \`
        <div class="workbench-view">
          \${viewHero('Import & Inspect', 'Track the private XML sample, inspection reports, safe value profiles, and field coverage before review starts.', [
            ['Mapping workbench', 'mapping'],
            ['Tier review', 'review']
          ])}
          <div class="metric-grid">
            \${metricTile('XML files', workbench?.intake?.xml_files_found ?? 0, 'Found in the private input folder')}
            \${metricTile('Parsed', workbench?.intake?.parsed ?? 0, \`\${workbench?.intake?.parse_failures ?? 0} parse failures\`)}
            \${metricTile('Grid rows', workbench?.intake?.inspection_grid_rows ?? 0, 'Shape-only grid inventory')}
            \${metricTile('Safe profiles', workbench?.intake?.safe_value_profile_rows ?? 0, 'Non-private value buckets')}
          </div>
          <div class="operator-grid">
            <section class="workbench-panel">
              <span class="panel-kicker">Coverage</span>
              <h2>Priority field coverage</h2>
              \${coverageTable(workbench?.mapping?.validation?.target_coverage || [])}
            </section>
            <section class="workbench-panel">
              <span class="panel-kicker">Inputs</span>
              <h2>Inspection paths</h2>
              \${pathList({
                'Input folder': workbench?.paths?.input_folder,
                'Inspection output': workbench?.paths?.inspection_output,
                'Discovery output': './private/appraisal-field-discovery',
                'Review packets': workbench?.paths?.review_packets
              })}
            </section>
            <section class="workbench-panel full-span">
              <span class="panel-kicker">Command</span>
              <h2>Refresh inspection</h2>
              \${commandPanel(inspectCommand())}
            </section>
          </div>
        </div>
      \`;
    }

    function renderMappingView() {
      const root = document.getElementById('caseRoot');
      root.innerHTML = \`
        <div class="workbench-view">
          \${viewHero('Mapping Workbench', 'Review likely XML paths, keep human-verified mappings visible, and validate coverage before approving training output.', [
            ['Repairs', 'repairs'],
            ['Audit', 'audit']
          ])}
          <div class="metric-grid">
            \${metricTile('Verified mappings', workbench?.mapping?.verified_count ?? 0, 'Loaded from local mapping config')}
            \${metricTile('Mapping targets', (workbench?.mapping?.review_targets || []).length, 'Targets with candidate packets')}
            \${metricTile('Validation parsed', workbench?.mapping?.validation?.parsed ?? 0, 'XMLs checked with mapping')}
            \${metricTile('Applications', (workbench?.mapping?.validation?.applications || []).length, 'Mapping applications logged')}
          </div>
          <div class="operator-grid">
            <section class="workbench-panel full-span">
              <span class="panel-kicker">Verified</span>
              <h2>Human-approved mappings</h2>
              \${verifiedMappingTable(workbench?.mapping?.verified_mappings || [])}
            </section>
            <section class="workbench-panel full-span">
              <span class="panel-kicker">Candidates</span>
              <h2>Review packet targets</h2>
              \${mappingTargetTable(workbench?.mapping?.review_targets || [])}
            </section>
            <section class="workbench-panel full-span">
              <span class="panel-kicker">Validation</span>
              <h2>Target coverage</h2>
              \${coverageTable(workbench?.mapping?.validation?.target_coverage || [])}
            </section>
            <section class="workbench-panel full-span">
              <span class="panel-kicker">Commands</span>
              <h2>Refresh mapping packets and validation</h2>
              \${commandPanel(mappingCommands())}
            </section>
          </div>
        </div>
      \`;
    }

    function renderRepairsView() {
      const root = document.getElementById('caseRoot');
      const repairCases = state.cases.filter(item =>
        item.recommendation.level === 'red' ||
        item.decision_status === 'needs_revision' ||
        item.comps.some(comp => comp.needs_manual_attention) ||
        item.warnings.some(warning => !['redacted_postal_code', 'redacted_street_address'].includes(warning))
      );
      root.innerHTML = \`
        <div class="workbench-view">
          \${viewHero('Repair Tracking', 'Turn rejected, needs-fix, parser-warning, and adjusted-price attention cases into a visible repair queue.', [
            ['Review selected', 'review'],
            ['Mapping', 'mapping']
          ])}
          <div class="metric-grid">
            \${metricTile('Red cases', workbench?.repairs?.red_cases ?? 0, 'Likely reject or needs fix')}
            \${metricTile('Needs fix', workbench?.repairs?.needs_revision_cases ?? 0, 'Saved reviewer decisions')}
            \${metricTile('Adjusted rows', workbench?.repairs?.adjusted_attention_rows ?? 0, 'Rows needing attention')}
            \${metricTile('Parser warnings', workbench?.repairs?.parser_warning_cases ?? 0, 'Warning count in manifest')}
          </div>
          <div class="operator-grid">
            <section class="workbench-panel full-span">
              <span class="panel-kicker">Case repair queue</span>
              <h2>Cases needing repair or judgment</h2>
              \${repairCaseList(repairCases)}
            </section>
            <section class="workbench-panel full-span">
              <span class="panel-kicker">Blockers</span>
              <h2>Most common blockers</h2>
              \${blockerTable(workbench?.repairs?.top_blockers || [])}
            </section>
          </div>
        </div>
      \`;
    }

    function renderExportView() {
      const root = document.getElementById('caseRoot');
      const p = state.progress;
      root.innerHTML = \`
        <div class="workbench-view">
          \${viewHero('Apply & Export', 'Use reviewer decisions as the approval gate, then export only approved JSONL for training.', [
            ['Tier review', 'review'],
            ['Privacy audit', 'audit']
          ])}
          <div class="metric-grid">
            \${metricTile('Approved', p.approved, 'Cases approved in session')}
            \${metricTile('Needs fix', p.needs_revision, 'Cases held for repair')}
            \${metricTile('Rejected', p.rejected, 'Cases excluded')}
            \${metricTile('Approved lines', workbench?.export?.all_lines ?? 0, 'Current approved export')}
          </div>
          <div class="operator-grid">
            <section class="workbench-panel">
              <span class="panel-kicker">Gate</span>
              <h2>Decision file</h2>
              \${pathList({
                'Review decisions': workbench?.review?.decision_file,
                'Reviewed output': './private/reviewed-appraisal-cases',
                'Approved export': workbench?.paths?.approved_export
              })}
            </section>
            <section class="workbench-panel">
              <span class="panel-kicker">Export files</span>
              <h2>Approved JSONL</h2>
              <div class="metric-grid">
                \${metricTile('Train', workbench?.export?.train_lines ?? 0, 'train.jsonl')}
                \${metricTile('Eval', workbench?.export?.eval_lines ?? 0, 'eval.jsonl')}
                \${metricTile('All', workbench?.export?.all_lines ?? 0, 'all.jsonl')}
              </div>
            </section>
            <section class="workbench-panel full-span">
              <span class="panel-kicker">Commands</span>
              <h2>Apply decisions, then export approved cases</h2>
              \${commandPanel(followupCommands.apply_review_decisions + '\\n\\n' + followupCommands.export_approved)}
            </section>
          </div>
        </div>
      \`;
    }

    function renderAuditView() {
      const root = document.getElementById('caseRoot');
      root.innerHTML = \`
        <div class="workbench-view">
          \${viewHero('Audit & Privacy', 'Keep privacy checks, leakage checks, redaction status, and adjusted-price conflict policy visible before anything leaves the private folder.', [
            ['Export gate', 'export'],
            ['Overview', 'overview']
          ])}
          <div class="metric-grid">
            \${metricTile('Privacy patterns', workbench?.audit?.privacy_total ?? 0, 'Across generated reports')}
            \${metricTile('Leakage cases', workbench?.audit?.final_value_leakage_cases ?? 0, 'Final value in input_case')}
            \${metricTile('Raw XML included', workbench?.audit?.raw_xml_included ? 'Yes' : 'No', 'Review UI output')}
            \${metricTile('Redaction', workbench?.pipeline?.redaction_enabled ? 'On' : 'Check', 'Training pipeline')}
          </div>
          <div class="operator-grid">
            <section class="workbench-panel">
              <span class="panel-kicker">Privacy sources</span>
              <h2>Generated report checks</h2>
              \${privacyTable(workbench?.audit?.privacy_sources || [])}
            </section>
            <section class="workbench-panel">
              <span class="panel-kicker">Adjusted price policy</span>
              <h2>Conflict summary</h2>
              \${jsonSummary(workbench?.pipeline?.adjusted_price_conflict_stats || workbench?.audit?.conflict_summary)}
            </section>
            <section class="workbench-panel full-span">
              <span class="panel-kicker">Warnings</span>
              <h2>Manifest warnings</h2>
              \${blockerTable(workbench?.pipeline?.warnings_by_type || [])}
            </section>
          </div>
        </div>
      \`;
    }

    function viewHero(title, subtitle, actions = []) {
      return \`
        <section class="workbench-hero">
          <div>
            <span class="view-meta">\${escape(workbenchFreshness())}</span>
            <h2>\${escape(title)}</h2>
            <p>\${escape(subtitle)}</p>
          </div>
          <div class="hero-actions">
            \${actions.map(([label, view], actionIndex) => \`<button class="case-link-button \${actionIndex === 0 ? 'primary-lite' : ''}" onclick="setView('\${escape(view)}')">\${escape(label)}</button>\`).join('')}
            <button class="case-link-button" onclick="refreshAndRender()">Refresh</button>
          </div>
        </section>
      \`;
    }

    function metricTile(label, value, detail) {
      return \`
        <div class="metric-tile">
          <span>\${escape(label)}</span>
          <strong>\${escape(value)}</strong>
          <small class="muted">\${escape(detail)}</small>
        </div>
      \`;
    }

    function workbenchFreshness() {
      if (!workbench?.generated_at) return 'waiting for data';
      const date = new Date(workbench.generated_at);
      if (Number.isNaN(date.getTime())) return 'data loaded';
      return \`updated \${date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}\`;
    }

    function commandPanel(command) {
      return \`
        <div class="command-panel">
          <div class="command-header">
            <span class="muted">Local terminal command</span>
            <button type="button" data-command="\${encodeURIComponent(command)}" onclick="copyCommand(this)">Copy command</button>
          </div>
          <pre class="command-block">\${escape(command)}</pre>
        </div>
      \`;
    }

    function pathList(paths) {
      return \`
        <dl class="path-list">
          \${Object.entries(paths).map(([label, value]) => \`
            <div class="path-row"><dt>\${escape(label)}</dt><dd>\${escape(value || 'Not found')}</dd></div>
          \`).join('')}
        </dl>
      \`;
    }

    function actionList(items) {
      if (!items.length) return '<div class="empty-state">No urgent actions. Continue review or export when ready.</div>';
      return \`
        <ul class="action-list">
          \${items.map(item => \`
            <li>
              <span class="status-dot \${escape(item.status)}"></span>
              <strong>\${escape(item.label)}</strong>
              <button class="case-link-button" onclick="setView('\${escape(item.view)}')">\${escape(item.action)}</button>
            </li>
          \`).join('')}
        </ul>
      \`;
    }

    function reviewLane() {
      const p = state.progress;
      const lanes = [
        { label: 'Unreviewed', value: p.unreviewed, mode: 'unreviewed', tone: 'attention' },
        { label: 'Attention', value: p.yellow + p.red, mode: 'attention', tone: 'attention' },
        { label: 'Red', value: p.red, mode: 'red', tone: 'blocked' },
        { label: 'Approved', value: p.approved, mode: 'approved', tone: 'ready' },
        { label: 'Needs fix', value: p.needs_revision, mode: 'needs_revision', tone: 'attention' },
        { label: 'Rejected', value: p.rejected, mode: 'rejected', tone: 'blocked' }
      ];
      return \`
        <div class="lane-grid">
          \${lanes.map(lane => \`
            <button class="lane-item \${escape(lane.tone)}" onclick="setQueueMode('\${escape(lane.mode)}')">
              <span>\${escape(lane.label)}</span>
              <strong>\${escape(lane.value)}</strong>
            </button>
          \`).join('')}
        </div>
      \`;
    }

    function nextActions() {
      const stages = workbench?.stages || [];
      const actions = stages.filter(stage => stage.status !== 'ready').map(stage => ({
        status: stage.status,
        label: \`\${stage.label}: \${stage.detail}\`,
        view: stage.id,
        action: 'Open'
      }));
      if (state.progress.unreviewed > 0) {
        actions.unshift({ status: 'attention', label: \`\${state.progress.unreviewed} cases still need review\`, view: 'review', action: 'Review' });
      }
      return actions.slice(0, 6);
    }

    function blockerTable(rows) {
      if (!rows.length) return '<div class="empty-state">No blockers reported.</div>';
      return \`
        <table class="data-table">
          <thead><tr><th>Blocker</th><th>Count</th></tr></thead>
          <tbody>\${rows.map(row => \`<tr><td>\${escape(humanize(row.blocker || row.warning))}</td><td>\${escape(row.count)}</td></tr>\`).join('')}</tbody>
        </table>
      \`;
    }

    function coverageTable(rows) {
      if (!rows.length) return '<div class="empty-state">Coverage report not found.</div>';
      return \`
        <table class="data-table">
          <thead><tr><th>Field</th><th>Before</th><th>After</th><th>Delta</th></tr></thead>
          <tbody>\${rows.map(row => \`
            <tr>
              <td>\${escape(row.field)}</td>
              <td>\${escape(formatPct(row.before_pct))}</td>
              <td>\${escape(formatPct(row.after_pct))}</td>
              <td>\${escape(formatDelta(row.delta_pct))}</td>
            </tr>
          \`).join('')}</tbody>
        </table>
      \`;
    }

    function verifiedMappingTable(rows) {
      if (!rows.length) return '<div class="empty-state">No verified local mappings loaded yet.</div>';
      return \`
        <table class="data-table">
          <thead><tr><th>Field</th><th>Strategy</th><th>Confidence</th><th>Path</th><th>Notes</th></tr></thead>
          <tbody>\${rows.map(row => \`
            <tr>
              <td>\${escape(row.field)}</td>
              <td>\${escape(row.strategy)}</td>
              <td>\${escape(row.confidence || 'verified')}</td>
              <td class="path-cell">\${escape(row.path)}</td>
              <td>\${escape(row.notes || 'Verified locally')}</td>
            </tr>
          \`).join('')}</tbody>
        </table>
      \`;
    }

    function mappingTargetTable(rows) {
      if (!rows.length) return '<div class="empty-state">Mapping review packets not found.</div>';
      return \`
        <div class="mapping-target-list">
          \${rows.map(row => {
            const top = row.top_candidates?.[0] || null;
            const signalClass = top?.recommendation === 'likely_accept' ? 'pass' : top?.recommendation === 'likely_reject' ? 'bad' : 'warn';
            return \`
            <div class="mapping-target-row">
              <div>
                <strong>\${escape(row.target)}</strong>
                <span>\${escape(row.candidates)} candidates · \${escape(row.likely_accept)} likely · \${escape(row.needs_manual_review)} manual · \${escape(row.likely_reject)} reject</span>
              </div>
              <code>\${escape(top?.path || 'No candidate')}</code>
              <span class="badge \${signalClass}">\${escape(top ? \`\${top.recommendation} · \${top.score}\` : 'Missing')}</span>
            </div>
          \`;
          }).join('')}
        </div>
      \`;
    }

    function repairCaseList(cases) {
      if (!cases.length) return '<div class="empty-state">No repair cases currently match the repair filters.</div>';
      return \`
        <ul class="action-list">
          \${cases.map(item => \`
            <li>
              <span class="status-dot \${escape(item.recommendation.level === 'red' ? 'blocked' : 'attention')}"></span>
              <div>
                <strong>\${escape(item.case_id)}</strong>
                <small class="muted">\${escape(item.recommendation.label)} · \${escape(humanizeList(item.missing_fields.slice(0, 3)))}</small>
              </div>
              <button class="case-link-button" onclick="openCase('\${escape(item.case_id)}')">Open</button>
            </li>
          \`).join('')}
        </ul>
      \`;
    }

    function privacyTable(rows) {
      if (!rows.length) return '<div class="empty-state">No privacy audit reports found.</div>';
      return \`
        <table class="data-table">
          <thead><tr><th>Report</th><th>Total</th><th>Status</th></tr></thead>
          <tbody>\${rows.map(row => \`
            <tr>
              <td>\${escape(row.name)}</td>
              <td>\${escape(row.total)}</td>
              <td>\${row.total === 0 ? badge('Pass') : badge('Needs human check')}</td>
            </tr>
          \`).join('')}</tbody>
        </table>
      \`;
    }

    function jsonSummary(value) {
      if (!value || typeof value !== 'object') return '<div class="empty-state">No conflict summary found.</div>';
      const rows = Object.entries(value).slice(0, 12).map(([key, val]) => ({ key, val: typeof val === 'object' ? JSON.stringify(val) : val }));
      return \`
        <table class="data-table">
          <thead><tr><th>Metric</th><th>Value</th></tr></thead>
          <tbody>\${rows.map(row => \`<tr><td>\${escape(humanize(row.key))}</td><td>\${escape(row.val)}</td></tr>\`).join('')}</tbody>
        </table>
      \`;
    }

    function formatPct(value) {
      return typeof value === 'number' ? \`\${value.toFixed(value % 1 ? 1 : 0)}%\` : 'Missing';
    }

    function formatDelta(value) {
      if (typeof value !== 'number') return 'Missing';
      if (value === 0) return '0%';
      return \`\${value > 0 ? '+' : ''}\${value.toFixed(value % 1 ? 1 : 0)}%\`;
    }

    function inspectCommand() {
      const input = workbench?.paths?.input_folder || './private/appraisal-xmls-sample';
      return \`npm run appraisal:inspect-xml -- \\\\\\n  --input \${input} \\\\\\n  --output ./private/appraisal-xml-inspection-real \\\\\\n  --safe-value-profile true\`;
    }

    function mappingCommands() {
      const input = workbench?.paths?.input_folder || './private/appraisal-xmls-sample';
      return [
        \`npm run appraisal:review-mappings -- \\\\\\n  --input \${input} \\\\\\n  --discovery ./private/appraisal-field-discovery \\\\\\n  --output ./private/appraisal-mapping-review\`,
        \`npm run appraisal:validate-mapping -- \\\\\\n  --input \${input} \\\\\\n  --mapping ./private/appraisal-field-mapping.local.json \\\\\\n  --output ./private/appraisal-mapping-validation\`
      ].join('\\n\\n');
    }

    function setView(viewName) {
      activeView = viewName || 'overview';
      if (queuePreference !== 'show' && queuePreference !== 'hide') queuePreference = 'auto';
      render();
    }

    function toggleQueue() {
      queuePreference = queueVisible() ? 'hide' : 'show';
      localStorage.setItem('appraisalQueuePreference', queuePreference);
      render();
    }

    function setQueueMode(mode) {
      filters.mode = mode || 'all';
      index = 0;
      activeView = 'review';
      render();
    }

    function openCase(caseId) {
      filters.query = '';
      filters.mode = 'all';
      const cases = visibleCases();
      const nextIndex = cases.findIndex(item => item.case_id === caseId);
      if (nextIndex >= 0) index = nextIndex;
      activeView = 'review';
      render();
    }

    function reviewGuide(item, approvals, outcome, issues) {
      const mainIssue = issues[0] || 'No automatic blocker found.';
      return \`
        <section class="review-guide \${escape(item.recommendation.level)}">
          <span>What to do</span>
          <h2>\${escape(outcome.label)}</h2>
          <p>\${escape(mainIssue)} The next section lists the exact things to check for this case.</p>
          <div class="guide-steps">
            <div class="guide-step">
              <strong>1. Read a thing to check</strong>
              <small>Each row names one thing you are accepting before approval.</small>
            </div>
            <div class="guide-step">
              <strong>2. Check the evidence</strong>
              <small>Use the “Look at” line, then mark Yes if it is acceptable.</small>
            </div>
            <div class="guide-step">
              <strong>3. Choose the action</strong>
              <small>All Yes means Approve. Any No or unclear answer means Needs Fix or Reject.</small>
            </div>
          </div>
        </section>
      \`;
    }

    function reviewActionSummary(item, approvals, outcome, issues, visibleCount) {
      const primaryIssue = issues[0] || 'Automatic checks did not find a blocker.';
      const sideLabel = item.recommendation.level === 'red'
        ? 'Needs Fix or Reject'
        : \`\${approvals.length} thing\${approvals.length === 1 ? '' : 's'} to check\`;
      return \`
        <section class="review-action-summary \${escape(item.recommendation.level)}">
          <div>
            <span>Recommended action</span>
            <h2>\${escape(outcome.label)}</h2>
            <p>\${escape(primaryIssue)}</p>
          </div>
          <div class="review-action-side">
            <strong>\${escape(sideLabel)}</strong>
            <small>Case \${escape(index + 1)} of \${escape(visibleCount)}</small>
            <div class="review-nav-buttons">
              <button onclick="move(-1)">Previous</button>
              <button onclick="move(1)">Next</button>
              <button onclick="jumpFlagged()">Jump flagged</button>
            </div>
          </div>
        </section>
      \`;
    }

    function plainReviewMessage(item, approvals) {
      if (item.recommendation.level === 'red') {
        return {
          title: 'This one is not ready.',
          body: 'It is missing important data. Do not approve it. Choose Needs Fix if it can be repaired. Choose Reject if it should not be used.',
          steps: [
            'Look at the problems listed below.',
            'Choose Needs Fix or Reject.',
            'Write one short note saying why.'
          ]
        };
      }
      if (item.recommendation.level === 'yellow') {
        return {
          title: 'This one might be usable.',
          body: \`Check the \${approvals.length} thing\${approvals.length === 1 ? '' : 's'} listed below. If every one is OK, approve it. If anything is wrong or missing, choose Needs Fix or Reject.\`,
          steps: [
            'Read each thing to check.',
            'Mark Yes only if it looks OK.',
            'Approve only when every thing is checked.'
          ]
        };
      }
      return {
        title: 'This one looks usable.',
        body: 'Do a quick spot-check. If it looks right, approve it. If something is wrong, choose Needs Fix or Reject.',
        steps: [
          'Spot-check the case.',
          'Approve if it looks right.',
          'Use Needs Fix or Reject if it does not.'
        ]
      };
    }

    function plainEnglishSummary(item, approvals, issues, visibleCount) {
      const message = plainReviewMessage(item, approvals);
      return \`
        <section class="plain-review-card \${escape(item.recommendation.level)}">
          <div>
            <span>Your job on this case</span>
            <h2>\${escape(message.title)}</h2>
            <p>\${escape(message.body)}</p>
          </div>
          <div class="plain-steps">
            <span>Do this</span>
            <ol>\${message.steps.map(step => \`<li>\${escape(step)}</li>\`).join('')}</ol>
            <div class="review-nav-buttons">
              <button onclick="move(-1)">Previous</button>
              <button onclick="move(1)">Next</button>
              <button onclick="jumpFlagged()">Jump flagged</button>
            </div>
            <small class="muted">Case \${escape(index + 1)} of \${escape(visibleCount)}</small>
          </div>
        </section>
      \`;
    }

    function decisionProblems(issues) {
      const visible = issues.slice(0, 6);
      if (!visible.length) return '';
      return \`
        <div class="decision-problems">
          <span>Problems found</span>
          <ul>\${visible.map(issue => \`<li>\${escape(issue)}</li>\`).join('')}</ul>
        </div>
      \`;
    }

    function buttonMeaningGrid(isRed) {
      const meanings = isRed
        ? [
          ['Needs Fix', 'Repair it later. Use this when missing or wrong data might be fixed.'],
          ['Reject', 'Do not use this case for training.'],
          ['Skip', 'Leave it undecided for now.']
        ]
        : [
          ['Approve', 'Use this case for training.'],
          ['Needs Fix', 'Repair it later. Use this when something is wrong or missing.'],
          ['Reject', 'Do not use this case for training.'],
          ['Skip', 'Leave it undecided for now.']
        ];
      return \`
        <div class="button-meaning-grid \${isRed ? 'red' : ''}">
          \${meanings.map(([label, meaning]) => \`
            <div class="button-meaning">
              <strong>\${escape(label)}</strong>
              <small>\${escape(meaning)}</small>
            </div>
          \`).join('')}
        </div>
      \`;
    }

    function decisionHelper(isRed) {
      return \`
        <div class="decision-helper">
          <span>Note rule</span>
          <p>\${isRed ? 'For Needs Fix or Reject, write one plain sentence. Example: Missing comps and final value, needs parser repair.' : 'If you approve, check every thing first. If you choose Needs Fix or Reject, write one plain sentence why.'}</p>
        </div>
      \`;
    }

    function noteTemplateButtons(isRed) {
      const templates = isRed
        ? [
          ['Needs repair', 'Needs parser or mapping repair before this case can be approved.'],
          ['Missing evidence', 'Needs Fix: selected comparables, final value, or narrative evidence is missing.'],
          ['Reject source', 'Reject: extracted facts are not reliable enough for training use.']
        ]
        : [
          ['Adjusted checked', 'Adjusted sale price rows checked against sale price plus net adjustment.'],
          ['Tier 1 only', 'Missing fields are acceptable for Tier 1 selected-comp/reconciliation training only.'],
          ['Parser fix', 'Needs parser or mapping repair before this case can be approved.'],
          ['Reject note', 'Reject: extracted facts are not reliable enough for training use.']
        ];
      return \`
        <div class="note-templates">
          \${templates.map(([label, text]) => \`<button type="button" data-note-template="\${escape(text)}" onclick="appendNoteTemplate(this.dataset.noteTemplate || '')">\${escape(label)}</button>\`).join('')}
        </div>
      \`;
    }

    function approvalOverridePanel(caseId, approvals) {
      return \`
        <details class="approval-override">
          <summary>Approve anyway (override)</summary>
          <div class="approval-override-body">
            <p>Only use this if you reviewed every problem and still want this case included as training data.</p>
            \${approvalStatementSummary(caseId, approvals)}
            <button id="approveBtn" class="green override-approve" onclick="saveDecision('approved')">Approve override - use anyway (A)</button>
          </div>
        </details>
      \`;
    }

    function decisionBox(item, approvals, issues) {
      const isRed = item.recommendation.level === 'red';
      return \`
        <section class="decision-box focused-decision-box \${escape(item.recommendation.level)}">
          <div class="decision-box-heading">
            <div>
              <span>Final decision</span>
              <h2>\${isRed ? 'Choose Needs Fix or Reject' : 'Choose one action for this case'}</h2>
            </div>
            <p>\${escape(approvalDecisionContext(item, approvals))}</p>
          </div>
          \${decisionProblems(issues)}
          \${isRed ? '' : approvalStatementSummary(item.case_id, approvals)}
          \${buttonMeaningGrid(isRed)}
          \${decisionHelper(isRed)}
          <textarea id="notes" placeholder="\${isRed ? 'Notes required. Say whether this needs parser/mapping repair or should be rejected.' : 'Notes required for Needs Fix or Reject. Notes are also required to approve yellow cases.'}">\${escape(item.decision.notes || '')}</textarea>
          \${noteTemplateButtons(isRed)}
          <div class="decision-actions primary-actions \${isRed ? 'red-case-actions' : ''}">
            \${isRed ? '' : '<button id="approveBtn" class="green" onclick="saveDecision(\\'approved\\')">Approve - use this (A)</button>'}
            <button class="yellow" onclick="saveDecision('needs_revision')">Needs Fix - repair later (F)</button>
            <button class="red" onclick="saveDecision('rejected')">Reject - do not use (R)</button>
            <button onclick="saveDecision('skipped')">Skip - decide later (S)</button>
          </div>
          \${isRed ? approvalOverridePanel(item.case_id, approvals) : ''}
          <p id="saveMsg" class="save-msg"></p>
        </section>
      \`;
    }

    function caseEvidenceSections(item, subject, displayedComps, displayedAdjustments) {
      return \`
        <div class="section-jumps">
          <button onclick="jumpToSection('snapshot')">Snapshot</button>
          <button onclick="jumpToSection('subject')">Subject</button>
          <button onclick="jumpToSection('comps')">Comps</button>
          <button onclick="jumpToSection('adjustments')">Adjustments</button>
          <button onclick="jumpToSection('reconciliation')">Reconciliation</button>
        </div>

        <section id="snapshot" class="review-section">
          <div class="section-title"><span>01</span><h2>Case Snapshot</h2></div>
          <div class="facts">
            \${fact('Tier 1 status', humanize(item.tier.tier1_status))}
            \${fact('Why Tier 1', item.tier.tier1_reasons.length ? humanizeList(item.tier.tier1_reasons) : 'Candidate checks passed')}
            \${fact('Tier 2 limitations', item.tier.tier2_reasons.length ? humanizeList(item.tier.tier2_reasons) : 'None listed')}
            \${fact('Tier 3 limitations', item.tier.tier3_reasons.length ? humanizeList(item.tier.tier3_reasons) : 'None listed')}
          </div>
        </section>

        <section id="subject" class="review-section">
          <div class="section-title"><span>02</span><h2>Subject</h2></div>
          <div class="facts subject-grid">
            \${fact('Property type', subject.property_type)}
            \${fact('Address', subject.address_redacted)}
            \${fact('City / state', [subject.city, subject.state].filter(Boolean).join(', ') || null)}
            \${fact('GLA', subject.gla_sqft)}
            \${fact('Beds / baths', [subject.bedrooms, subject.bathrooms].filter(v => v != null).join(' / ') || null)}
            \${fact('Condition / quality', [subject.condition, subject.quality].filter(Boolean).join(' / ') || null)}
          </div>
          <p class="field-note">Missing important fields: \${escape(humanizeList(item.missing_fields))}</p>
        </section>

        <section id="comps" class="review-section">
          <div class="section-title">
            <span>03</span><h2>Selected Comps</h2>
            <div class="table-toolbar">
              <button class="\${!filters.attentionOnlyRows ? 'active' : ''}" onclick="setAttentionOnlyRows(false)">All rows</button>
              <button class="\${filters.attentionOnlyRows ? 'active' : ''}" onclick="setAttentionOnlyRows(true)">Attention only</button>
            </div>
          </div>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Comp</th><th>Sale price</th><th>Net adj.</th><th>Adjusted</th><th>Source</th><th>Condition</th><th>Quality</th><th>Sale date</th><th>Check</th></tr></thead>
              <tbody>\${displayedComps.length ? displayedComps.map(comp => \`
                <tr>
                  <td>\${escape(comp.comp_index)}</td>
                  <td>\${escape(fmtMoney(comp.sale_price))}</td>
                  <td>\${escape(fmtMoney(comp.net_adjustment))}</td>
                  <td>\${escape(fmtMoney(comp.adjusted_sale_price))}</td>
                  <td>\${escape(comp.adjusted_price_source)}</td>
                  <td>\${escape(fmt(comp.condition))}</td>
                  <td>\${escape(fmt(comp.quality))}</td>
                  <td>\${escape(fmt(comp.sale_date))}</td>
                  <td>\${badge(comp.adjusted_price_badge)}</td>
                </tr>\`).join('') : \`<tr><td class="empty-table" colspan="9">\${filters.attentionOnlyRows ? 'No comparable rows currently need manual attention.' : 'No selected comparables were extracted for this case.'}</td></tr>\`}
              </tbody>
            </table>
          </div>
        </section>

        <section id="adjustments" class="review-section">
          <div class="section-title"><span>04</span><h2>Adjustment Sanity</h2></div>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Comp</th><th>Formula</th><th>Expected</th><th>Extracted</th><th>Check</th></tr></thead>
              <tbody>\${displayedAdjustments.length ? displayedAdjustments.map(comp => \`
                <tr>
                  <td>\${escape(comp.comp_index)}</td>
                  <td>\${escape(fmtMoney(comp.sale_price))} + \${escape(fmtMoney(comp.net_adjustment))}</td>
                  <td>\${escape(fmtMoney(comp.expected_adjusted_sale_price))}</td>
                  <td>\${escape(fmtMoney(comp.adjusted_sale_price))}</td>
                  <td>\${badge(comp.badge)}</td>
                </tr>\`).join('') : \`<tr><td class="empty-table" colspan="5">\${filters.attentionOnlyRows ? 'No adjustment rows currently need manual attention.' : 'No adjustment rows are available for this case.'}</td></tr>\`}
              </tbody>
            </table>
          </div>
        </section>

        <section id="reconciliation" class="review-section">
          <div class="section-title"><span>05</span><h2>Reconciliation</h2></div>
          <div class="reconciliation-grid">
            \${fact('Final opinion of value', fmtMoney(item.reconciliation.final_opinion_of_value))}
            \${fact('Warnings', humanizeList(item.warnings))}
          </div>
          <h3>Narrative</h3>
          <p class="narrative">\${escape(fmt(item.reconciliation.narrative))}</p>
          <h3>Caveats</h3>
          <ul class="caveats">\${item.reconciliation.caveats.map(c => \`<li>\${escape(humanize(c))}</li>\`).join('')}</ul>
        </section>
      \`;
    }

    function renderCase() {
      const item = currentCase();
      const root = document.getElementById('caseRoot');
      if (!item) {
        root.innerHTML = '<section><h2>No cases match the current filters.</h2></section>';
        return;
      }
      const subject = item.subject || {};
      const attentionCompIndexes = new Set(item.comps.filter(comp => comp.needs_manual_attention).map(comp => comp.comp_index));
      const displayedComps = filters.attentionOnlyRows ? item.comps.filter(comp => comp.needs_manual_attention) : item.comps;
      const displayedAdjustments = filters.attentionOnlyRows
        ? item.adjustment_sanity.filter(comp => attentionCompIndexes.has(comp.comp_index))
        : item.adjustment_sanity;
      const visibleCount = visibleCases().length;
      const outcome = reviewerOutcome(item);
      const issues = reviewIssues(item);
      const repairView = shouldUseRepairView(item);
      const approvals = approvalItems(item);
      root.innerHTML = \`
        <div class="case-layout focused-review-layout">
          <div class="case-main">
            <div class="record-header">
              <div>
                <span class="eyebrow">Active case</span>
                <h2>\${escape(item.case_id)}</h2>
                <p>\${escape(item.recommendation.label)}</p>
                <div class="record-stats">
                  <span><strong>\${escape(item.comps.length)}</strong> comps</span>
                  <span><strong>\${escape(item.comps.filter(comp => comp.needs_manual_attention).length)}</strong> attention rows</span>
                  <span><strong>\${escape(approvals.length)}</strong> things to check</span>
                  <span><strong>\${escape(fmtMoney(item.reconciliation.final_opinion_of_value))}</strong> final value</span>
                </div>
              </div>
              <div class="record-pills">
                <span class="level-chip \${item.recommendation.level}">\${escape(item.recommendation.level)}</span>
                <span class="level-chip decision-chip">\${escape(item.decision_status)}</span>
                <span class="level-chip neutral-chip">Tier 1 \${escape(humanize(item.tier.tier1_status))}</span>
              </div>
            </div>
            \${plainEnglishSummary(item, approvals, issues, visibleCount)}
            \${decisionBox(item, approvals, issues)}
            <details class="evidence-drawer">
              <summary>Open evidence and extracted details</summary>
              <div class="evidence-drawer-body">
                <div class="case-command-bar">
                  <span class="case-index-label">Case \${escape(index + 1)} of \${escape(visibleCount)}</span>
                  <button onclick="move(-1)">Previous</button>
                  <button onclick="move(1)">Next</button>
                  <button onclick="jumpFlagged()">Jump flagged</button>
                  <span class="spacer"></span>
                  <button class="\${!filters.attentionOnlyRows ? 'active' : ''}" onclick="setAttentionOnlyRows(false)">All rows</button>
                  <button class="\${filters.attentionOnlyRows ? 'active' : ''}" onclick="setAttentionOnlyRows(true)">Attention rows</button>
                </div>
                \${repairView ? repairCaseBody(item, subject, issues) : caseEvidenceSections(item, subject, displayedComps, displayedAdjustments)}
              </div>
            </details>
            <div class="case-utility-details">
              <details class="rail-details">
                <summary>Training example JSON</summary>
                <pre>\${escape(JSON.stringify(item.training_example, null, 2))}</pre>
              </details>

              <details class="rail-details">
                <summary>Apply and export commands</summary>
                <h3>Apply decisions</h3>
                \${commandPanel(followupCommands.apply_review_decisions)}
                <h3>Export approved JSONL</h3>
                \${commandPanel(followupCommands.export_approved)}
              </details>
            </div>
          </div>
        </div>
      \`;
      updateApprovalConfirmState();
    }

    function fact(label, value) {
      return \`<div class="fact"><span>\${escape(label)}</span>\${escape(fmt(value))}</div>\`;
    }

    function badge(text) {
      const label = text === 'Conflict resolved by built-in' ? 'Built-in resolved' : text;
      const cls = text === 'Pass' ? 'pass' : (text === 'Missing' || text === 'Needs human check' ? 'bad' : 'warn');
      return \`<span class="badge \${cls}">\${escape(label)}</span>\`;
    }

    function selectCase(i) { index = i; activeView = 'review'; render(); }
    function move(delta) { const cases = visibleCases(); index = Math.max(0, Math.min(cases.length - 1, index + delta)); render(); }
    function jumpFlagged() {
      const cases = visibleCases();
      const next = cases.findIndex((item, i) => i > index && needsAttention(item));
      index = next >= 0 ? next : Math.max(0, cases.findIndex(item => needsAttention(item)));
      render();
    }

    function jumpToSection(id) {
      document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function setAttentionOnlyRows(value) {
      filters.attentionOnlyRows = value;
      renderCase();
    }

    function reviewerOutcome(item) {
      if (item.recommendation.level === 'red') {
        return { level: 'red', label: 'Do not approve yet', detail: 'Reject or send back for repair unless you can document an override.' };
      }
      if (item.recommendation.level === 'yellow') {
        return { level: 'yellow', label: 'Review before approval', detail: 'A human should resolve the attention items before approving.' };
      }
      return { level: 'green', label: 'Likely approvable', detail: 'Spot-check, then approve if the case is useful.' };
    }

    function reviewIssues(item) {
      const issues = [];
      const localFilled = item.comps.filter(comp => comp.needs_manual_attention).length;
      if (item.comps.length === 0) issues.push('No selected comparables were extracted.');
      if (item.reconciliation.final_opinion_of_value == null) issues.push('Final opinion of value is missing.');
      if (!item.reconciliation.narrative) issues.push('Reconciliation narrative is missing.');
      if (localFilled > 0) issues.push(\`\${localFilled} adjusted sale price row\${localFilled === 1 ? '' : 's'} require human attention.\`);
      if (item.missing_fields.length > 0) issues.push(\`Missing fields: \${humanizeList(item.missing_fields)}.\`);
      if (item.warnings.length > 0) issues.push(\`Warnings: \${humanizeList(item.warnings)}.\`);
      return issues;
    }

    function cockpitItem(label, value, detail, level) {
      return \`
        <div class="cockpit-item \${escape(level || 'neutral')}">
          <span>\${escape(label)}</span>
          <strong>\${escape(value)}</strong>
          <small>\${escape(detail)}</small>
        </div>
      \`;
    }

    function shouldUseRepairView(item) {
      return item.recommendation.level === 'red' && (
        item.comps.length === 0 ||
        item.reconciliation.final_opinion_of_value == null ||
        !item.reconciliation.narrative
      );
    }

    function repairCaseBody(item, subject, issues) {
      const missingEssentials = [
        item.comps.length === 0 ? 'Selected comparable data' : null,
        item.reconciliation.final_opinion_of_value == null ? 'Final opinion of value' : null,
        !item.reconciliation.narrative ? 'Reconciliation narrative' : null,
        subject.gla_sqft == null ? 'Subject GLA' : null,
        !subject.condition ? 'Subject condition' : null,
        !subject.quality ? 'Subject quality' : null
      ].filter(Boolean);
      return \`
        <section class="repair-panel">
          <div class="repair-copy">
            <span class="eyebrow">Repair triage</span>
            <h2>This case is not training-ready.</h2>
            <p>The extracted record is missing the evidence needed for a useful Tier 1 example. Mark it Needs Fix if you want parser/mapping repair, or Reject if this source should stay out of approved training data.</p>
          </div>
          <div class="repair-action">
            <strong>\${escape(item.recommendation.label)}</strong>
            <span>\${escape(issues[0] || 'Automatic checks found blocking issues.')}</span>
          </div>
        </section>

        <section class="repair-grid">
          \${repairList('Missing essentials', missingEssentials.length ? missingEssentials : ['No required essentials are missing.'])}
          \${repairList('Parser warnings', item.warnings.length ? item.warnings.map(humanize) : ['No parser warnings.'])}
          \${repairList('Tier limitations', [
            ...(item.tier.tier1_reasons || []).map(humanize),
            ...(item.tier.tier2_reasons || []).map(humanize),
            ...(item.tier.tier3_reasons || []).map(humanize)
          ].slice(0, 8))}
          <div class="repair-card">
            <span>Subject snapshot</span>
            <dl>
              <dt>Location</dt><dd>\${escape([subject.city, subject.state].filter(Boolean).join(', ') || 'Missing')}</dd>
              <dt>Property type</dt><dd>\${escape(fmt(subject.property_type))}</dd>
              <dt>GLA</dt><dd>\${escape(fmt(subject.gla_sqft))}</dd>
              <dt>Condition / quality</dt><dd>\${escape([subject.condition, subject.quality].filter(Boolean).join(' / ') || 'Missing')}</dd>
            </dl>
          </div>
        </section>

        <details class="repair-details">
          <summary>Show extracted details anyway</summary>
          <div class="repair-detail-grid">
            \${fact('Tier 1 status', humanize(item.tier.tier1_status))}
            \${fact('Warnings', humanizeList(item.warnings))}
            \${fact('Missing fields', humanizeList(item.missing_fields))}
            \${fact('Final opinion of value', fmtMoney(item.reconciliation.final_opinion_of_value))}
          </div>
        </details>
      \`;
    }

    function repairList(title, items) {
      return \`
        <div class="repair-card">
          <span>\${escape(title)}</span>
          <ul>\${(items.length ? items : ['None']).map(item => \`<li>\${escape(item)}</li>\`).join('')}</ul>
        </div>
      \`;
    }

    function reviewTasks(item) {
      const tasks = [];
      const localFilled = item.comps.filter(comp => comp.needs_manual_attention).length;
      if (localFilled > 0) tasks.push(\`Check \${localFilled} local-filled adjusted sale price row\${localFilled === 1 ? '' : 's'}.\`);
      if (item.missing_fields.length) tasks.push(\`Confirm missing fields are acceptable: \${humanizeList(item.missing_fields)}.\`);
      if (item.recommendation.level === 'red') tasks.push('Decide whether this should be rejected or sent back for repair.');
      if (item.warnings.length) tasks.push('Scan parser warnings before approving.');
      tasks.push('Verify selected comps, adjusted prices, final value, and narrative.');
      return tasks.slice(0, 5);
    }

    function appendNoteTemplate(text) {
      const notes = document.getElementById('notes');
      if (!notes) return;
      const existing = notes.value.trim();
      notes.value = existing ? \`\${existing}\\n\${text}\` : text;
      notes.focus();
    }

    function toggleApprovalConfirmation(input) {
      const caseId = input.dataset.caseId || '';
      const title = input.dataset.approvalTitle || '';
      if (!caseId || !title) return;
      const set = approvalSet(caseId);
      if (input.checked) set.add(title);
      else set.delete(title);
      document.querySelectorAll('.approval-confirm').forEach(other => {
        if (other.dataset.caseId === caseId && other.dataset.approvalTitle === title) {
          other.checked = input.checked;
        }
      });
      updateApprovalConfirmState();
    }

    function approvalConfirmationStatus(item = currentCase()) {
      if (!item) return { total: 0, confirmed: 0, missing: [] };
      const approvals = approvalItems(item);
      const missing = approvals.filter(approval => !isApprovalConfirmed(item.case_id, approval));
      return {
        total: approvals.length,
        confirmed: approvals.length - missing.length,
        missing: missing.map(approval => approval.title)
      };
    }

    function updateApprovalConfirmState() {
      const item = currentCase();
      if (!item) return;
      const status = approvalConfirmationStatus(item);
      document.querySelectorAll('[data-approval-progress]').forEach(node => {
        const answerText = \`\${status.confirmed} of \${status.total} things checked\`;
        node.textContent = status.missing.length ? answerText : \`\${answerText}. Ready to approve if notes are complete.\`;
        node.classList.toggle('ready', !status.missing.length);
      });
      document.querySelectorAll('[data-rail-confirmed]').forEach(node => {
        const title = node.dataset.railConfirmed || '';
        const confirmed = approvalSet(item.case_id).has(title);
        node.textContent = confirmed ? 'Yes' : 'Not answered';
        node.classList.toggle('yes', confirmed);
        node.classList.toggle('pending', !confirmed);
      });
      const approveBtn = document.getElementById('approveBtn');
      if (approveBtn) {
        const isOverride = approveBtn.classList.contains('override-approve');
        approveBtn.disabled = status.missing.length > 0;
        approveBtn.textContent = status.missing.length
          ? (isOverride ? 'Approve override locked' : 'Approve locked')
          : (isOverride ? 'Approve override - use anyway (A)' : 'Approve - use this (A)');
        approveBtn.title = status.missing.length
          ? \`Check every thing before approving: \${status.missing.join(', ')}\`
          : 'Every thing is checked.';
      }
      const saveMsg = document.getElementById('saveMsg');
      if (saveMsg && !status.missing.length && saveMsg.textContent.startsWith('Check every thing')) {
        saveMsg.textContent = '';
      }
    }

    async function copyCommand(button) {
      const text = decodeURIComponent(button.dataset.command || '');
      try {
        await navigator.clipboard.writeText(text);
        button.textContent = 'Copied';
        setTimeout(() => { button.textContent = 'Copy command'; }, 1200);
      } catch {
        const helper = document.createElement('textarea');
        helper.value = text;
        helper.style.position = 'fixed';
        helper.style.left = '-9999px';
        document.body.appendChild(helper);
        helper.select();
        document.execCommand('copy');
        document.body.removeChild(helper);
        button.textContent = 'Copied';
        setTimeout(() => { button.textContent = 'Copy command'; }, 1200);
      }
    }

    async function refreshWorkbench() {
      if (isStaticDemo) {
        applyStaticDecisions();
        return;
      }
      const res = await fetch('/api/workbench');
      workbench = await res.json();
    }

    async function refreshAndRender() {
      await refreshWorkbench();
      render();
    }

    async function saveDecision(status) {
      const item = currentCase();
      const notes = document.getElementById('notes').value.trim();
      if (status === 'approved') {
        const approvalStatus = approvalConfirmationStatus(item);
        if (approvalStatus.missing.length) {
          document.getElementById('saveMsg').textContent = \`Check every thing before approving. Missing: \${approvalStatus.missing.join(', ')}.\`;
          return;
        }
      }
      if (status === 'approved' && item.recommendation.level !== 'green' && !notes) {
        document.getElementById('saveMsg').textContent = 'Approving yellow cases or red overrides requires a note.';
        return;
      }
      if ((status === 'needs_revision' || status === 'rejected') && !notes) {
        document.getElementById('saveMsg').textContent = 'Notes are required for Needs Fix and Reject.';
        return;
      }
      const reviewer = document.getElementById('reviewer').value.trim() || defaultReviewer;
      localStorage.setItem('appraisalReviewer', reviewer);
      if (isStaticDemo) {
        const decisions = readStaticDecisions().filter(decision => decision.case_id !== item.case_id);
        decisions.push({
          case_id: item.case_id,
          status,
          reviewer,
          reviewed_at: new Date().toISOString(),
          notes
        });
        writeStaticDecisions(decisions.sort((a, b) => a.case_id.localeCompare(b.case_id)));
        applyStaticDecisions();
        document.getElementById('saveMsg').textContent = 'Saved in this browser demo.';
        move(1);
        return;
      }
      const res = await fetch('/api/decision', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({ case_id: item.case_id, status, reviewer, notes })
      });
      if (!res.ok) {
        document.getElementById('saveMsg').textContent = (await res.json()).error || 'Save failed.';
        return;
      }
      state = await res.json();
      await refreshWorkbench();
      document.getElementById('saveMsg').textContent = 'Saved.';
      move(1);
    }

    async function bulkApproveGreen() {
      if (!confirm('Only use this after you have spot-checked the green cases. Continue?')) return;
      const reviewer = document.getElementById('reviewer').value.trim() || defaultReviewer;
      if (isStaticDemo) {
        const existing = readStaticDecisions().filter(decision => {
          const item = state.cases.find(candidate => candidate.case_id === decision.case_id);
          return item?.recommendation.level !== 'green';
        });
        const approvedGreen = state.cases
          .filter(item => item.recommendation.level === 'green')
          .map(item => ({
            case_id: item.case_id,
            status: 'approved',
            reviewer,
            reviewed_at: new Date().toISOString(),
            notes: 'Bulk approved in static demo after spot-check.'
          }));
        writeStaticDecisions([...existing, ...approvedGreen].sort((a, b) => a.case_id.localeCompare(b.case_id)));
        applyStaticDecisions();
        render();
        return;
      }
      const res = await fetch('/api/bulk-approve-green', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({ reviewer, confirm: true })
      });
      state = await res.json();
      await refreshWorkbench();
      render();
    }

    document.querySelectorAll('.app-tab').forEach(button => {
      button.onclick = () => setView(button.dataset.view || 'overview');
    });
    document.getElementById('queueToggle').onclick = toggleQueue;
    document.getElementById('prevBtn').onclick = () => move(-1);
    document.getElementById('nextBtn').onclick = () => move(1);
    document.getElementById('flaggedBtn').onclick = jumpFlagged;
    document.getElementById('bulkBtn').onclick = bulkApproveGreen;
    document.getElementById('caseSearch').oninput = e => { filters.query = e.target.value; index = 0; render(); };
    document.querySelectorAll('.sort-option').forEach(button => {
      button.onclick = e => {
        e.stopPropagation();
        filters.sort = button.dataset.sort || 'priority';
        index = 0;
        render();
      };
    });
    document.querySelectorAll('.filter-chip').forEach(button => {
      button.onclick = () => { filters.mode = button.dataset.mode || 'all'; index = 0; render(); };
    });
    const savedReviewer = localStorage.getItem('appraisalReviewer');
    if (savedReviewer) document.getElementById('reviewer').value = savedReviewer;
    window.addEventListener('keydown', e => {
      if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
      const key = e.key.toLowerCase();
      if (activeView === 'review' && key === 'a') {
        const approveBtn = document.getElementById('approveBtn');
        if (approveBtn && !approveBtn.disabled) saveDecision('approved');
      }
      if (activeView === 'review' && key === 'f') saveDecision('needs_revision');
      if (activeView === 'review' && key === 'r') saveDecision('rejected');
      if (activeView === 'review' && key === 's') saveDecision('skipped');
      if (key === 'q') toggleQueue();
      if (key === 'n') move(1);
      if (key === 'p') move(-1);
      if (e.key === '/') { e.preventDefault(); document.getElementById('caseSearch').focus(); }
    });
    load();
  </script>
</body>
</html>`;
}

function buildFollowupCommands(options: ReviewUiOptions): {
  apply_review_decisions: string;
  export_approved: string;
} {
  return {
    apply_review_decisions: `npm run appraisal:apply-review-decisions -- \\
  --review-packets ${formatCliPath(options.reviewPackets)} \\
  --decisions ${formatCliPath(path.join(options.output, "review_decisions.csv"))} \\
  --output ./private/reviewed-appraisal-cases`,
    export_approved: `npm run appraisal:export-approved -- \\
  --reviewed ./private/reviewed-appraisal-cases \\
  --output ./private/approved-tier1-training-export \\
  --eval-ratio 0.2 \\
  --seed 42`
  };
}

function formatCliPath(value: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
}

function parseArgs(args: string[]): ReviewUiOptions {
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
  const reviewBatch = stringArg(values, "review-batch");
  const reviewPackets = stringArg(values, "review-packets");
  const conflictAudit = stringArg(values, "conflict-audit");
  const output = stringArg(values, "output");
  if (!reviewBatch) throw new Error("Missing required --review-batch folder");
  if (!reviewPackets) throw new Error("Missing required --review-packets folder");
  if (!conflictAudit) throw new Error("Missing required --conflict-audit folder");
  if (!output) throw new Error("Missing required --output folder");
  return {
    reviewBatch,
    reviewPackets,
    conflictAudit,
    output,
    port: numberArg(values, "port", 4317)
  };
}

function stringArg(values: Map<string, string | boolean>, key: string): string | null {
  const value = values.get(key);
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function numberArg(values: Map<string, string | boolean>, key: string, fallback: number): number {
  const value = values.get(key);
  if (typeof value !== "string") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  void main();
}
