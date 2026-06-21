import { readFileSync } from "node:fs";
import { Script, createContext } from "node:vm";
import { describe, expect, it } from "vitest";

type UiModel = {
  statusForScenario: (scenarioId: string) => string;
  executionModeFor: (value: string, enabled: boolean) => string;
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
});
