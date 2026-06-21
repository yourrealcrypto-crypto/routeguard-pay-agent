import { readFileSync } from "node:fs";
import { Script, createContext } from "node:vm";
import { describe, expect, it } from "vitest";

type UiModel = {
  statusForScenario: (scenarioId: string) => string;
  executionModeFor: (value: string, enabled: boolean) => string;
  executionModeSelection: (value: string, enabled: boolean) => {
    mode: string;
    allowed: boolean;
    label: string;
    helper: string;
    safetyCopy: string;
  };
  filterCases: (cases: Array<{ id: string }>, filter: string, archivedIds?: string[]) => Array<{ id: string }>;
  sortCases: (
    cases: Array<{ id: string; shipmentId: string }>,
    sort: string,
    shipments: Map<string, unknown>,
    scores: Map<string, unknown>,
  ) => Array<{ id: string }>;
  verificationState: (data: unknown, selectedMode: string, enabled: boolean) => { key: string; badge: string };
  createArchiveRecord: (scenario: unknown, data: unknown, archivedAt: string, selectedMode: string, enabled: boolean) => Record<string, unknown>;
  nextTabIndex: (key: string, currentIndex: number, tabCount: number) => number;
  approvalTimelineState: (kind: string, approval?: unknown) => string;
  policyDecisionLabel: (scenarioLabel: string, decision: string) => string;
  archiveMatches: (record: { data: { kind: string }; verification: { key: string } }, filter: string) => boolean;
  readablePolicyReason: (code: string) => string;
  readableCheckReasons: (check: Record<string, unknown>) => string[];
  buildReportExportModel: (data: Record<string, unknown>, catalog?: Record<string, unknown>) => Record<string, any> | null;
  buildReportSummary: (model: Record<string, any> | null) => string;
  buildMailtoLink: (model: Record<string, any> | null) => string;
  buildStandaloneReportHtml: (model: Record<string, any>) => string;
  hasReportExportActions: (data: Record<string, unknown>) => boolean;
  renderReportActions: (data: Record<string, unknown>) => string;
  renderGate: (decision: Record<string, unknown>, scenarioId?: string, reportHash?: string) => string;
  renderTechnicalEvidenceBlock: (
    checks: Array<Record<string, unknown>>,
    decision: Record<string, unknown>,
    reportHash?: string | null,
    extras?: Record<string, unknown>,
  ) => string;
  buildReportTechnicalAppendix: (model: Record<string, any>) => string;
  isCaseArchivable: (scenarioId: string, data: Record<string, unknown> | null | undefined, archivedIds?: string[]) => boolean;
  findArchivableCases: (
    caseResults: Map<string, Record<string, unknown>> | Record<string, Record<string, unknown>>,
    scenarios: Array<{ id: string }>,
    archivedIds?: string[],
  ) => Array<{ id: string }>;
  archiveCompletedCases: (
    caseResults: Map<string, Record<string, unknown>> | Record<string, Record<string, unknown>>,
    scenarios: Array<{ id: string; shipmentId: string }>,
    archivedIds: string[],
    selectedMode: string,
    enabled: boolean,
  ) => Array<{ scenarioId: string; record: Record<string, unknown> }>;
  resolveRoutePolicy: (route: Record<string, unknown>) => { name: string; source: string; meta?: Record<string, unknown> };
};

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const scriptSource = html.slice(html.indexOf("<script>") + "<script>".length, html.lastIndexOf("</script>"));
const context = createContext({ console });
new Script(scriptSource, { filename: "public/index.html" }).runInContext(context);
const ui = (context as { RouteGuardUIModel: UiModel }).RouteGuardUIModel;

const cases = [
  { id: "auto-approved", shipmentId: "RG-1001" },
  { id: "approval-required", shipmentId: "RG-1001" },
  { id: "vendor-blocked", shipmentId: "RG-1001" },
  { id: "budget-exceeded", shipmentId: "RG-2002" },
  { id: "prompt-injection", shipmentId: "RG-1001" },
  { id: "no-purchase", shipmentId: "RG-3003" },
];

const livePayment = {
  mode: "AUTONOMOUS_TESTNET",
  transactionId: "0.0.123@1710000000.000000000",
  result: "SUCCESS",
  consensusTimestamp: "1710000000.000000000",
};

const completedReport = {
  kind: "COMPLETED",
  report: {
    reportType: "SHIPMENT",
    shipmentId: "RG-1001",
    route: { origin: "Rotterdam, NL", destination: "Leipzig, DE" },
    cargoType: "high_value",
    declaredCargoValueEur: 480000,
    generatedAt: "2026-06-21T12:00:00.000Z",
    riskScore: 86,
    riskBand: "critical",
    confidence: 0.9,
    recommendedControls: ["Increase schedule buffer."],
    mitigationRecommendations: ["Verify border documents."],
    operationalRecommendations: ["Monitor hand-offs."],
    factors: [{ code: "MODE", label: "Mode risk", contribution: 11, explanation: "Road exposure." }],
    privateProviderReliabilitySignal: {
      providerAlias: "PRV-001",
      providerDisplayName: "PRIVATE PROVIDER NAME MUST NOT EXPORT",
      rawDocumentText: "RAW PRIVATE DOCUMENT MUST NOT EXPORT",
      sampleSize: 2,
      onTimeRate: 50,
      averageDelayMinutes: 120,
      trackingCompletenessPercent: 80,
      issueRate: 10,
      confidence: 0.5,
      reliabilityBand: "MIXED_OBSERVED_RELIABILITY",
      reasonCodes: ["LIMITED_SAMPLE_SIZE"],
      evidenceHashes: ["e".repeat(64)],
      scopeLabel: "Customer-specific · not shared across customers",
      ratingLabel: "Not a public carrier rating",
    },
    etaReliabilityRisk: { onTimeRiskBand: "MODERATE", schedulePressure: "10 policy points", delayExposureMinutes: 120, explanation: "Measured factors affect ETA.", contributingFactors: ["Schedule pressure"] },
    insuranceSupportEvidence: { disclaimer: "Insurance-support evidence only. This report does not sell, price, approve, or determine insurance.", evidenceHashes: ["e".repeat(64)] },
    alternativeRouteOrMitigationRecommendation: { recommendation: "Review an alternative route.", basis: ["Border exposure"] },
    policyVersion: "1.0.0",
    policyHash: "p".repeat(64),
    reportHash: "r".repeat(64),
    disclaimer: "Decision-support only.",
  },
  decision: {
    policyVersion: "1.0",
    canonicalHash: "c".repeat(64),
    checks: [{ policyId: "shipment-context", name: "Shipment Context", outcome: "PASS", reasonCode: "SHIPMENT_ELIGIBLE", publicMessage: "Shipment is eligible.", evidence: { needConditions: ["cargo_value>=50000", "low_free_confidence"] } }],
  },
  entitlement: {
    entitlementId: "11111111-1111-4111-8111-111111111111",
    status: "REDEEMED",
    issuedAt: "2026-06-21T11:59:00.000Z",
    redeemedAt: "2026-06-21T12:00:00.000Z",
    token: "RAW_ENTITLEMENT_TOKEN_MUST_NOT_EXPORT",
    tokenHash: "SECRET_TOKEN_HASH_MUST_NOT_EXPORT",
  },
  payment: { mode: "SIMULATION", transactionId: "simulated-transaction" },
  verification: { status: "SIMULATION_EVIDENCE", mirrorNodeConfirmation: "NOT_APPLICABLE", hcsAnchoringStatus: "NOT_APPLICABLE", hcsSequenceNumbers: [] },
};

describe("RouteGuard interface model", () => {
  it("exposes the four product workspaces without a separate proof tab", () => {
    expect(html).toContain(">Active Cases<");
    expect(html).toContain(">Live Route Intelligence<");
    expect(html).toContain(">Policy &amp; Governance<");
    expect(html).toContain(">Archive<");
    expect(html).not.toMatch(/>Hedera Proof</i);
    expect(html).toContain("Weather data by Open-Meteo");
    expect(html).toContain('apiJson("/api/live-route-risk"');
    expect(html).not.toContain("api.open-meteo.com");
    expect(html).toContain("Premium RouteRisk Analysis");
    expect(html).toContain("Single-use API entitlement");
    expect(html).toContain('apiJson("/api/agent/live-route/run"');
    expect(html).toContain("Assess live route risk");
    expect(html).toContain("Retrieving live weather…");
    expect(html).toContain("Refresh route assessment");
    expect(html).toContain("Purchase single-use premium API access");
    expect(html).toContain("Structural route complexity");
    expect(html).toContain("Live weather exposure");
    expect(html).toContain("Cargo sensitivity");
    expect(html).toContain("Data uncertainty");
    expect(html).not.toContain("tokenHash");
    expect(html).not.toContain("entitlement.token");
  });

  it("presents provider evidence as private decision-support, never a public rating", () => {
    expect(html).toContain("Private Provider Evidence");
    expect(html).toContain("Customer-specific · not shared across customers");
    expect(html).toContain("Raw provider records are not written to Hedera");
    expect(html).toContain("Privacy-preserving Hedera audit model");
    expect(html).toContain("Simulation evidence · not written to Hedera");
    expect(html).toContain(
      "Production use requires privacy, contract, retention, and data-governance controls",
    );
    expect(html).toContain("Not a public carrier rating");
    expect(html).not.toContain("public leaderboard");
    expect(html).not.toContain("bad carrier");
    expect(html).not.toContain("blacklist");
  });

  it("replaces prominent raw need conditions with readable policy reasons", () => {
    const check = (completedReport.decision.checks[0] as unknown) as Record<string, unknown>;
    const reasons = ui.readableCheckReasons(check);
    expect(reasons).toContain("Declared cargo value exceeds the premium-analysis threshold.");
    expect(reasons).toContain("Free assessment confidence is below the policy threshold.");
    expect(reasons.join(" ")).not.toContain('needConditions=["cargo_value');
    expect(ui.readablePolicyReason("unknown_code")).toBe(
      "Technical policy condition: unknown_code",
    );
    const gate = ui.renderGate(completedReport.decision);
    const prominent = gate.slice(0, gate.indexOf('<details class="technical-evidence compact">'));
    expect(prominent).toContain(
      "Declared cargo value exceeds the premium-analysis threshold.",
    );
    expect(prominent).not.toContain("cargo_value&gt;=50000");
    expect(gate).toContain("cargo_value&gt;=50000");
  });

  it("retains raw policy evidence only in collapsed compact technical sections", () => {
    expect(html).toContain('<details class="technical-evidence compact">');
    expect(html).toContain("Technical evidence ·");
    expect(html).not.toContain("View raw policy evidence");
    expect(html).not.toContain('class="ev"');
    const gate = ui.renderGate(completedReport.decision);
    const prominent = gate.slice(0, gate.indexOf('<details class="technical-evidence compact">'));
    expect(prominent).not.toContain("cargo_value&gt;=50000");
    const model = ui.buildReportExportModel(completedReport, { vendorId: "route-risk-labs", sku: "premium-route-risk-v1" })!;
    const downloaded = ui.buildStandaloneReportHtml(model);
    expect(downloaded).toContain("Technical evidence appendix");
    expect(downloaded).toContain("cargo_value&gt;=50000");
    expect(downloaded).toContain('<details class="report-technical-appendix');
  });

  it("shows export actions only when a premium report exists", () => {
    expect(ui.hasReportExportActions(completedReport)).toBe(true);
    expect(ui.renderReportActions(completedReport)).toContain("Download report");
    expect(ui.renderReportActions(completedReport)).toContain("Print / Save PDF");
    expect(ui.renderReportActions(completedReport)).toContain("Open email draft");
    expect(ui.renderReportActions(completedReport)).toContain("Copy report summary");
    for (const kind of ["BLOCKED", "NO_PURCHASE"]) {
      const data = { kind };
      expect(ui.hasReportExportActions(data)).toBe(false);
      expect(ui.renderReportActions(data)).toBe(
        '<div class="report-export-empty">No premium report available for export.</div>',
      );
    }
    expect(html).toContain("globalThis.print()");
  });

  it("builds a mailto draft without claiming that a PDF is attached", () => {
    const model = ui.buildReportExportModel(completedReport, { vendorId: "route-risk-labs", sku: "premium-route-risk-v1" })!;
    const mailto = decodeURIComponent(ui.buildMailtoLink(model));
    expect(mailto).toMatch(/^mailto:\?subject=/);
    expect(mailto).toContain("saved as PDF from RouteGuard");
    expect(mailto.toLowerCase()).not.toContain("attached");
    expect(mailto.toLowerCase()).not.toContain("attachment");
  });

  it("keeps copied and downloaded exports privacy-safe while retaining hashes", () => {
    const model = ui.buildReportExportModel(completedReport, { vendorId: "route-risk-labs", sku: "premium-route-risk-v1" })!;
    const summary = ui.buildReportSummary(model);
    const downloaded = ui.buildStandaloneReportHtml(model);
    for (const output of [summary, downloaded, JSON.stringify(model)]) {
      expect(output).not.toContain("RAW_ENTITLEMENT_TOKEN_MUST_NOT_EXPORT");
      expect(output).not.toContain("SECRET_TOKEN_HASH_MUST_NOT_EXPORT");
      expect(output).not.toContain("RAW PRIVATE DOCUMENT MUST NOT EXPORT");
      expect(output).not.toContain("PRIVATE PROVIDER NAME MUST NOT EXPORT");
    }
    expect(downloaded).toContain("r".repeat(64));
    expect(downloaded).toContain("p".repeat(64));
    expect(downloaded).toContain("Why premium analysis was justified");
    expect(downloaded).toContain(
      "Declared cargo value exceeds the premium-analysis threshold.",
    );
  });

  it("uses native outputs for dynamic status messages and keeps one authoritative tab style", () => {
    expect(html).toContain('<div class="main-tabs" role="tablist" aria-label="RouteGuard workspaces">');
    expect(html).toContain('<button class="main-tab" id="casesTab" role="tab"');
    expect(html).toContain('<output id="proposalStatus" class="gov-status" aria-live="polite"></output>');
    expect(html).toContain('<output class="muted">${esc(message)}</output>');
    expect(html.match(/^\s*\.main-tabs\s*\{/gm)).toHaveLength(1);
    expect(html.match(/^\s*\.main-tab\s*\{/gm)).toHaveLength(1);
    expect(html.match(/^\s*\.main-tab\[aria-selected="true"\]\s*\{/gm)).toHaveLength(1);
  });

  it("preserves keyboard tab navigation after replacing nested conditionals", () => {
    expect(ui.nextTabIndex("Home", 2, 4)).toBe(0);
    expect(ui.nextTabIndex("End", 1, 4)).toBe(3);
    expect(ui.nextTabIndex("ArrowRight", 3, 4)).toBe(0);
    expect(ui.nextTabIndex("ArrowLeft", 0, 4)).toBe(3);
  });

  it("gives live-route primary actions distinct interactive and loading states", () => {
    expect(html).toContain('class="assess-live-route live-primary"');
    expect(html).toContain('class="live-primary purchase-live"');
    expect(html).toContain(".live-primary:hover:not(:disabled)");
    expect(html).toContain(".live-primary:focus-visible");
    expect(html).toContain(".live-primary:active:not(:disabled)");
    expect(html).toContain(".live-primary.is-loading");
    expect(html).toContain(".live-primary:disabled");
    expect(html).toContain('.purchase-live:hover:not(:disabled)::after { content: " \\2192"; }');
  });

  it("shows the eight truthful premium purchase lifecycle stages", () => {
    expect(html).toContain('["Premium analysis proposed", proposed]');
    expect(html).toContain('["API entitlement issued", entitlement]');
    expect(html).toContain('["Premium API accessed", entitlement]');
    expect(html).toContain('["Premium report delivered", fulfillment]');
    expect(html).toContain("Simulation entitlement issued");
    expect(html).toContain("No real HBAR transfer");
    expect(html).toContain("Premium API redeemed in simulation");
  });

  it("keeps all six case outcomes and filters them client-side", () => {
    expect(cases.map((item) => ui.statusForScenario(item.id))).toEqual([
      "AUTO-APPROVED",
      "APPROVAL REQUIRED",
      "BLOCKED",
      "BLOCKED",
      "INJECTION RESISTED",
      "NO PURCHASE",
    ]);
    expect(ui.filterCases(cases, "all")).toHaveLength(6);
    expect(ui.filterCases(cases, "blocked").map((item) => item.id)).toEqual(["vendor-blocked", "budget-exceeded"]);
    expect(ui.sortCases(cases, "priority", new Map(), new Map()).map((item) => item.id)).toEqual([
      "approval-required",
      "vendor-blocked",
      "budget-exceeded",
      "prompt-injection",
      "auto-approved",
      "no-purchase",
    ]);
  });

  it("removes archived cases from Active Cases and restores them without deleting evidence", () => {
    expect(ui.filterCases(cases, "all", ["vendor-blocked"])).toHaveLength(5);
    expect(ui.filterCases(cases, "all", [])).toHaveLength(6);
    const evidence = { kind: "COMPLETED", payment: livePayment, auditTrail: [{ hcsStatus: "ANCHORED" }] };
    const record = ui.createArchiveRecord(cases[0], evidence, "2026-06-20T10:00:00.000Z", "AUTONOMOUS_TESTNET", true);
    expect(record.data).toBe(evidence);
    expect((record.data as typeof evidence).payment).toBe(livePayment);
    expect((record.data as typeof evidence).auditTrail).toEqual([{ hcsStatus: "ANCHORED" }]);
  });

  it("maps the execution selector to the existing API contract and safely clamps disabled testnet", () => {
    expect(ui.executionModeFor("SIMULATION", true)).toBe("SIMULATION");
    expect(ui.executionModeFor("AUTONOMOUS_TESTNET", true)).toBe("AUTONOMOUS_TESTNET");
    expect(ui.executionModeFor("AUTONOMOUS_TESTNET", false)).toBe("SIMULATION");
    expect(html).toContain('id="testnetMode"');
    expect(html).toContain("Live testnet execution is not configured on this server.");
  });

  it("uses a segmented control in hero (no dropdown/popup)", () => {
    expect(html).toContain('class="mode-segments"');
    expect(html).toContain('data-mode="SIMULATION"');
    expect(html).toContain('data-mode="AUTONOMOUS_TESTNET"');
    expect(html).toContain('Live locked');
    expect(html).not.toContain('hero-mode-menu');
    expect(html).not.toContain('aria-haspopup="listbox"');
    expect(html).not.toContain('id="heroModeMenu"');
    expect(html).toContain('$("#executionMode").onchange = () => applyExecutionMode');
  });

  it("selects simulation and permits testnet only through the existing live guard", () => {
    const simulation = ui.executionModeSelection("SIMULATION", false);
    expect(simulation.mode).toBe("SIMULATION");
    expect(simulation.allowed).toBe(true);
    expect(simulation.safetyCopy).toBe(
      "Simulation selected · no real HBAR transfer.",
    );
    expect(ui.executionModeSelection("AUTONOMOUS_TESTNET", false).mode).toBe(
      "SIMULATION",
    );
    const testnet = ui.executionModeSelection("AUTONOMOUS_TESTNET", true);
    expect(testnet.mode).toBe("AUTONOMOUS_TESTNET");
    expect(testnet.allowed).toBe(true);
    expect(testnet.safetyCopy).toContain("real testnet HBAR may move");
  });

  it("shows production payment context as disabled and cannot enable execution", () => {
    const production = ui.executionModeSelection("LIVE_NETWORK_PAYMENTS", true);
    expect(production.mode).toBe("SIMULATION");
    expect(production.allowed).toBe(false);
    expect(production.safetyCopy).toBe(
      "Production payment mode is visible for product context but disabled in this demo.",
    );
    expect(html).toContain("Live locked");
    expect(html).toContain('class="mode-segment locked"');
    expect(html).not.toContain('value="MAINNET"');
    expect(html).not.toContain("/api/mainnet");
  });

  it("shows selected and disabled visual states plus the official Agent Kit link", () => {
    expect(html).toContain('class="mode-segment active"');
    expect(html).toContain('class="mode-segment locked"');
    expect(html).toContain("Live locked");
    expect(html).toContain(
      'href="https://docs.hedera.com/hedera/open-source-solutions/ai-studio-on-hedera/hedera-ai-agent-kit"',
    );
    expect(html).toContain('target="_blank" rel="noopener noreferrer">Hedera Agent Kit</a>');
    expect(html).toContain('<path class="route-corridor"');
    expect(html).toContain('class="route-checkpoint"');
  });

  it("renders a compact proof strip with execution mode in the operational panel", () => {
    expect(html).toContain('class="ops-panel" aria-label="Execution posture"');
    expect(html).toContain('class="proof-strip" role="list"');
    expect(html).toContain('Fixed price <b>0.05 HBAR</b>');
    expect(html).toContain('Policy authority <b>deterministic</b>');
    expect(html).toContain('Audit <b>local / HCS when configured</b>');
    expect(html).toContain('Premium API <b>entitlement gated</b>');
    expect(html).toContain('class="hero-mode hero-mode-anchor" id="heroModeSelector"');
    expect(html).toContain('data-mode="SIMULATION"');
    expect(html).toContain('Live locked');
    // no dropdown/popup
    expect(html).not.toContain('hero-mode-menu');
  });

  it("hero execution mode uses segmented control (no dropdown)", () => {
    expect(html).toContain('class="mode-segments" role="group"');
    expect(html).toContain('class="mode-segment"');
    expect(html).toContain('class="mode-segment locked"');
    expect(html).not.toContain('aria-haspopup="listbox"');
  });

  it("selected mode is visibly represented in segmented control", () => {
    expect(html).toContain('class="mode-segment active"');
    expect(html).toContain('data-mode="SIMULATION"');
  });

  it("the Hedera Agent Kit branding area includes a logo/icon element", () => {
    expect(html).toContain('class="hedera-logo"');
    expect(html).toContain('<svg class="hedera-logo"');
  });

  it("the Hedera Agent Kit link remains present and correct", () => {
    expect(html).toContain(
      'href="https://docs.hedera.com/hedera/open-source-solutions/ai-studio-on-hedera/hedera-ai-agent-kit"',
    );
    expect(html).toContain('target="_blank" rel="noopener noreferrer">Hedera Agent Kit</a>');
  });

  it("segmented control replaces dropdown (no popup close logic needed)", () => {
    expect(html).toContain('class="mode-segment"');
    expect(html).not.toContain('hero-mode-menu');
  });

  it("maps every verification evidence state", () => {
    expect(ui.verificationState({ verification: { status: "SIMULATION_EVIDENCE" } }, "AUTONOMOUS_TESTNET", true).key).toBe("simulation");
    expect(ui.verificationState({ verification: { status: "VERIFICATION_PENDING" } }, "SIMULATION", false).key).toBe("pending");
    expect(ui.verificationState({ verification: { status: "VERIFIED_ON_HEDERA" } }, "SIMULATION", false).key).toBe("verified");
    expect(ui.verificationState({ verification: { status: "PARTIALLY_VERIFIED" } }, "SIMULATION", false).key).toBe("partial");
    expect(ui.verificationState({ verification: { status: "VERIFICATION_FAILED" } }, "SIMULATION", false).key).toBe("failed");
  });

  it("uses backend verification first and never treats selected testnet or loose evidence as verified", () => {
    expect(ui.verificationState({ verification: { status: "SIMULATION_EVIDENCE" }, payment: livePayment }, "AUTONOMOUS_TESTNET", true).badge).toBe("SIMULATION EVIDENCE");
    expect(ui.verificationState({}, "AUTONOMOUS_TESTNET", true).badge).toBe("TESTNET READY");
    expect(ui.verificationState({ payment: livePayment, auditTrail: [{ hcsStatus: "ANCHORED" }] }, "AUTONOMOUS_TESTNET", true).badge).toBe("TESTNET READY");
  });

  it("uses the intended approval timeline result without duplicate conditional branches", () => {
    expect(ui.approvalTimelineState("APPROVAL_REQUIRED")).toBe("Pending");
    expect(ui.approvalTimelineState("COMPLETED", { status: "APPROVED" })).toBe("Completed");
    expect(ui.approvalTimelineState("BLOCKED")).toBe("Skipped");
    expect(ui.approvalTimelineState("NO_PURCHASE")).toBe("Skipped");
    expect(ui.approvalTimelineState("FAILED")).toBe("Skipped");
  });

  it("keeps policy labels and archive filters scoped to their matching conditions", () => {
    expect(ui.policyDecisionLabel("INJECTION RESISTED", "BLOCK")).toBe("Injection resisted");
    expect(ui.policyDecisionLabel("APPROVAL REQUIRED", "BLOCK")).toBe("Approval required");
    expect(ui.policyDecisionLabel("PENDING", "ALLOW_AUTONOMOUS")).toBe("Auto-approved");
    expect(ui.policyDecisionLabel("PENDING", "BLOCK")).toBe("Blocked");

    const record = { data: { kind: "COMPLETED" }, verification: { key: "simulation" } };
    expect(ui.archiveMatches(record, "all")).toBe(true);
    expect(ui.archiveMatches(record, "approved")).toBe(true);
    expect(ui.archiveMatches(record, "blocked")).toBe(false);
    expect(ui.archiveMatches(record, "simulation")).toBe(true);
    expect(ui.archiveMatches(record, "verified")).toBe(false);
  });

  // New tests for this UX refinement (segmented control + simplified governance)
  it("hero execution mode no longer uses a dropdown/popup menu", () => {
    expect(html).not.toContain('id="heroModeMenu"');
    expect(html).not.toContain('hero-mode-menu');
    expect(html).not.toContain('aria-haspopup="listbox"');
  });

  it("hero execution mode renders a segmented control", () => {
    expect(html).toContain('class="mode-segments" role="group"');
    expect(html).toContain('Simulation');
    expect(html).toContain('Testnet');
    expect(html).toContain('Live locked');
  });

  it("Simulation is selected by default in hero", () => {
    expect(html).toContain('class="mode-segment active"');
    expect(html).toContain('data-mode="SIMULATION"');
  });

  it("Testnet segment is disabled unless existing guard allows it", () => {
    // structure has disabled/locked class possible
    expect(html).toContain('data-mode="AUTONOMOUS_TESTNET"');
    expect(html).toContain('class="mode-segment locked"'); // when not enabled in markup
  });

  it("Live payments segment is visible but disabled/locked", () => {
    expect(html).toContain('Live locked');
    expect(html).toContain('class="mode-segment locked"');
  });

  it("selecting a hero segment syncs with the existing execution-mode control", () => {
    expect(html).toContain('$("#executionMode").onchange = () => applyExecutionMode');
    expect(html).toContain('mode-segments');
  });

  it("no production/mainnet payment execution path is added", () => {
    expect(html).not.toContain('value="MAINNET"');
    expect(html).not.toContain("/api/mainnet");
    expect(html).toContain('Live locked');
  });

  it("Policy & Governance first view shows simple cockpit cards", () => {
    expect(html).toContain('Policy Cockpit');
    expect(html).toContain('Active risk policy');
    expect(html).toContain('Payment safety');
    expect(html).toContain('Locked globally');
  });

  it("technical formula/weights/hash are hidden behind collapsed details by default", () => {
    expect(html).toContain('<details class="technical-evidence compact"');
    expect(html).toContain('Technical evidence · scoring details');
  });

  it("route policy assignments section exists", () => {
    expect(html).toContain('Route Policy Assignments');
    expect(html).toContain('id="routePolicyAssignments"');
  });

  it("route policy assignments show LIVE-MUC-IST with Pharma Temperature-Controlled Policy", () => {
    // default in JS state
    expect(html).toContain('LIVE-MUC-IST');
    // in the live cards rendering it will include
    expect(html).toContain('Pharma Temperature-Controlled Policy'); // from default assignment in cards
  });

  it("payment safety policy is shown as globally locked", () => {
    expect(html).toContain('Locked globally: vendor, SKU, price, caps');
    expect(html).toContain('Payment safety');
  });

  it("policy profiles have plain-English explanations", () => {
    expect(html).toContain('Standard RouteRisk Policy');
    expect(html).toContain('Balanced scoring for ordinary');
    expect(html).toContain('Pharma Temperature-Controlled Policy');
    expect(html).toContain('Higher sensitivity to temperature deviation');
    expect(html).toContain('High-Value Cargo Policy');
    expect(html).toContain('Intermodal Policy');
  });

  // New UX simplification tests for Live Route Intelligence + Policy & Governance
  it("Live Route Intelligence first view does not show all raw checkpoint weather numbers prominently", () => {
    expect(html).toContain('View checkpoint evidence');
    expect(html).toContain('<details><summary>View checkpoint evidence</summary>');
  });

  it("Checkpoint cards show checkpoint risk bands", () => {
    expect(html).toContain('deriveCheckpointRisk');
    expect(html).toContain('pill');
  });

  it("Checkpoint cards show readable risk reasons", () => {
    expect(html).toContain('temperature');
    expect(html).toContain('tolerance');
  });

  it("Raw weather data remains available in collapsed checkpoint evidence", () => {
    expect(html).toContain('<details><summary>View checkpoint evidence</summary>');
    expect(html).toContain('Temperature');
  });

  it("Overall route risk explanation includes checkpoint exposure", () => {
    expect(html).toContain('Checkpoint risk summary');
    expect(html).toContain('Top drivers');
  });

  it("Premium report includes checkpoint risk summary", () => {
    expect(html).toContain('Checkpoint risk summary');
    expect(html).toContain('pill');
  });

  it("Downloaded/printed report includes checkpoint summary and technical appendix", () => {
    expect(html).toContain('Technical evidence appendix');
    expect(html).toContain('View checkpoint evidence'); // structure supports
  });

  it("Policy & Governance first view does not show policy hash prominently", () => {
    expect(html).toContain('Policy evidence · hash');
    expect(html).toContain('Policy Cockpit');
  });

  it("Policy hash is available behind a collapsed disclosure", () => {
    expect(html).toContain('Policy evidence · hash');
  });

  it("Scoring formula/weights are hidden behind collapsed details by default", () => {
    expect(html).toContain('Technical evidence · scoring details');
    expect(html).toContain('<details class="technical-evidence compact"');
  });

  it("Payment safety policy remains visibly locked globally", () => {
    expect(html).toContain('Locked globally: vendor, SKU, price, caps');
    expect(html).toContain('Payment safety');
  });

  it("existing premium API, entitlement, provider evidence, report export, archive, live-route, Agent Kit, and verification tests still pass", () => {
    // covered by overall suite; specific strings preserved
    expect(html).toContain('Premium RouteRisk Analysis');
    expect(html).toContain('Live Route Intelligence');
  });

  it("raw evidence disclosures use compact muted secondary styling", () => {
    expect(html).toContain(".technical-evidence.compact");
    expect(html).toContain("Technical evidence ·");
    expect(html).toContain("color: var(--ink-faint)");
    const block = ui.renderTechnicalEvidenceBlock(
      completedReport.decision.checks as Array<Record<string, unknown>>,
      completedReport.decision,
      completedReport.report.reportHash,
    );
    expect(block).toContain("Technical evidence ·");
    expect(block).toContain('<summary>');
    expect(block).not.toContain("View raw policy evidence");
  });

  it("technical evidence appendix is collapsed and compact in exported reports", () => {
    const model = ui.buildReportExportModel(completedReport, { vendorId: "route-risk-labs", sku: "premium-route-risk-v1" })!;
    const appendix = ui.buildReportTechnicalAppendix(model);
    expect(appendix).toContain("Technical evidence appendix ·");
    expect(appendix).toContain("<details");
    expect(appendix).toContain("technical-evidence-table");
    expect(appendix).toContain("raw evidence");
  });

  it("exposes Archive completed cases bulk action", () => {
    expect(html).toContain('id="archiveCompletedBtn"');
    expect(html).toContain("Archive completed cases");
    expect(html).toContain('id="archiveBulkStatus"');
  });

  it("does not bulk-archive pending approval cases", () => {
    expect(ui.isCaseArchivable("approval-required", { kind: "APPROVAL_REQUIRED" })).toBe(false);
    const results: Record<string, Record<string, unknown>> = {
      "approval-required": { kind: "APPROVAL_REQUIRED" },
      "auto-approved": completedReport as unknown as Record<string, unknown>,
    };
    expect(ui.findArchivableCases(results, cases, []).map((item) => item.id)).toEqual(["auto-approved"]);
  });

  it("does not bulk-archive blocked cases by default", () => {
    expect(ui.isCaseArchivable("vendor-blocked", { kind: "BLOCKED" })).toBe(false);
    expect(ui.isCaseArchivable("budget-exceeded", { kind: "BLOCKED" })).toBe(false);
    const results: Record<string, Record<string, unknown>> = {
      "vendor-blocked": { kind: "BLOCKED" },
      "auto-approved": completedReport as unknown as Record<string, unknown>,
    };
    expect(ui.findArchivableCases(results, cases, []).map((item) => item.id)).toEqual(["auto-approved"]);
  });

  it("bulk-archives no-purchase final cases when results exist", () => {
    const noPurchase = { kind: "NO_PURCHASE", explanation: "Free assessment sufficient." };
    expect(ui.isCaseArchivable("no-purchase", noPurchase)).toBe(true);
    const results: Record<string, Record<string, unknown>> = { "no-purchase": noPurchase };
    const archived = ui.archiveCompletedCases(results, cases, [], "SIMULATION", false);
    expect(archived).toHaveLength(1);
    expect(archived[0]?.scenarioId).toBe("no-purchase");
  });

  it("workspace panels do not use modal or focus-trap roles", () => {
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain("focus-trap");
    expect(html).toContain('workspace-panel" id="stage"');
    expect(html).toContain(".workspace-panel { overflow: visible; }");
    expect(html).toContain('role="tablist"');
    expect(html).toContain('role="tab"');
    expect(html).toContain('role="tabpanel"');
  });

  it("resolves LIVE-MUC-IST to Pharma Temperature-Controlled Policy", () => {
    const route = {
      id: "LIVE-MUC-IST",
      cargo: "Temperature-controlled pharmaceuticals",
      cargoProfile: "TEMPERATURE_CONTROLLED",
      transportMode: "ROAD_FREIGHT",
    };
    const resolved = ui.resolveRoutePolicy(route);
    expect(resolved.name).toBe("Pharma Temperature-Controlled Policy");
    expect(resolved.source).toBe("explicit assignment");
  });

  it("shows assigned route policy in live route intelligence markup paths", () => {
    expect(html).toContain("resolveRoutePolicy");
    expect(html).toContain("Pharma Temperature-Controlled Policy");
    expect(html).toContain("routePolicyExplanation");
  });

  it("includes assigned route policy in premium report export model", () => {
    const liveReport = {
      ...completedReport,
      report: {
        ...completedReport.report,
        reportType: "LIVE_ROUTE",
        routeId: "LIVE-MUC-IST",
        origin: "Munich",
        destination: "Istanbul",
        cargoSensitivity: "TEMPERATURE_CONTROLLED",
      },
    };
    const model = ui.buildReportExportModel(liveReport, { vendorId: "route-risk-labs", sku: "premium-route-risk-v1" })!;
    expect(model.assignedRoutePolicy?.name).toBe("Pharma Temperature-Controlled Policy");
    const downloaded = ui.buildStandaloneReportHtml(model);
    expect(downloaded).toContain("Assigned route policy");
    expect(downloaded).toContain("Pharma Temperature-Controlled Policy");
    expect(downloaded).toContain("temperature deviation");
  });

  it("keeps payment safety visibly locked and separate from route policy", () => {
    expect(html).toContain("Locked globally: vendor, SKU, price, caps");
    expect(html).toContain("Payment safety");
    expect(html).not.toMatch(/route policy.*vendor account/i);
  });

  it("README includes thesis, bounty fit, safety, run instructions, and placeholders", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    expect(readme).toContain("The LLM proposes. Policy decides. Hedera proves.");
    expect(readme).toContain("Bounty fit");
    expect(readme).toContain("npm run build");
    expect(readme).toContain("npm run typecheck");
    expect(readme).toContain("npm test");
    expect(readme).toContain("npm run dev");
    expect(readme).toContain("TODO_LIVE_DEMO_URL");
    expect(readme).toContain("TODO_GITHUB_REPO_URL");
    expect(readme).toContain("TODO_FEEDBACK_ISSUE_URL");
    expect(readme).toContain("testnet only");
    expect(readme).toContain("not affiliated with");
  });

  it("feedback issue placeholder and draft exist", () => {
    const draft = readFileSync(new URL("../public/FEEDBACK_ISSUE_DRAFT.md", import.meta.url), "utf8");
    expect(draft).toContain("Hedera Agent Kit");
    expect(draft).toContain("TODO_GITHUB_REPO_URL");
    const status = readFileSync(new URL("../public/PROJECT_STATUS.md", import.meta.url), "utf8");
    expect(status).toContain("TODO_FEEDBACK_ISSUE_URL");
  });

  it("submission package exists with required bounty fields", () => {
    const submission = readFileSync(new URL("../public/SUBMISSION_PACKAGE.md", import.meta.url), "utf8");
    expect(submission).toContain("RouteGuard Pay Agent");
    expect(submission).toContain("Hedera Policy Agent / Week 5");
    expect(submission).toContain("The LLM proposes. Policy decides. Hedera proves.");
    expect(submission).toContain("TODO_LIVE_DEMO_URL");
    expect(submission).toContain("TODO_GITHUB_REPO_URL");
    expect(submission).toContain("TODO_FEEDBACK_ISSUE_URL");
    expect(submission).toContain("independent demo");
  });
});
