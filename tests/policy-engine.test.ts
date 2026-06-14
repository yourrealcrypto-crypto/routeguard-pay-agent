import { describe, it, expect, beforeEach } from "vitest";
import {
  evaluatePolicies,
  configForProfile,
  aggregate,
  type PolicyContext,
} from "../src/policy/engine.js";
import { getShipment } from "../src/store/fixtures.js";
import { store } from "../src/store/store.js";
import { config } from "../src/config/index.js";
import type { ServiceCatalogItem, PolicyCheck } from "../src/domain/index.js";

const VENDOR = config.HEDERA_VENDOR_ACCOUNT_ID ?? "0.0.VENDOR_PLACEHOLDER";

function catalog(): ServiceCatalogItem {
  return {
    vendorId: "route-risk-labs",
    vendorAccountId: VENDOR,
    serviceCategory: "logistics.route-risk",
    sku: "premium-route-risk-v1",
    version: "1.0",
    priceTinybars: config.CATALOG_PRICE_TINYBARS,
    currency: "HBAR",
    network: "testnet",
    active: true,
  };
}

function baseCtx(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    shipment: getShipment("RG-1001")!,
    catalogItem: catalog(),
    proposedVendorAccountId: VENDOR,
    profile: "standard",
    amountTinybars: config.CATALOG_PRICE_TINYBARS,
    budget: { spentTinybars: 0 },
    humanApproved: false,
    atExecution: false,
    alreadyPurchasedForShipment: false,
    existingMemo: null,
    candidateMemo: "RG:pending",
    ...overrides,
  };
}

describe("policy engine — aggregation precedence", () => {
  it("BLOCK beats everything", () => {
    const checks: PolicyCheck[] = [
      { policyId: "a", name: "A", outcome: "PASS", reasonCode: "x", publicMessage: "", evidence: {} },
      { policyId: "b", name: "B", outcome: "REQUIRE_APPROVAL", reasonCode: "x", publicMessage: "", evidence: {} },
      { policyId: "c", name: "C", outcome: "BLOCK", reasonCode: "x", publicMessage: "", evidence: {} },
    ];
    expect(aggregate(checks)).toBe("BLOCK");
  });
  it("REQUIRE_APPROVAL beats ALLOW", () => {
    const checks: PolicyCheck[] = [
      { policyId: "a", name: "A", outcome: "PASS", reasonCode: "x", publicMessage: "", evidence: {} },
      { policyId: "b", name: "B", outcome: "REQUIRE_APPROVAL", reasonCode: "x", publicMessage: "", evidence: {} },
    ];
    expect(aggregate(checks)).toBe("REQUIRE_APPROVAL");
  });
  it("all PASS → ALLOW_AUTONOMOUS", () => {
    const checks: PolicyCheck[] = [
      { policyId: "a", name: "A", outcome: "PASS", reasonCode: "x", publicMessage: "", evidence: {} },
    ];
    expect(aggregate(checks)).toBe("ALLOW_AUTONOMOUS");
  });
});

describe("policy engine — standard profile", () => {
  beforeEach(() => store.reset());

  it("auto-approves an eligible high-value shipment", () => {
    const r = evaluatePolicies(baseCtx(), configForProfile("standard"));
    expect(r.decision).toBe("ALLOW_AUTONOMOUS");
    expect(r.canonicalHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces a stable canonical hash for identical inputs", () => {
    const a = evaluatePolicies(baseCtx(), configForProfile("standard"));
    const b = evaluatePolicies(baseCtx(), configForProfile("standard"));
    expect(a.canonicalHash).toBe(b.canonicalHash);
  });
});

describe("policy engine — vendor allowlist", () => {
  it("blocks when proposed vendor account is off-allowlist", () => {
    const r = evaluatePolicies(
      baseCtx({ proposedVendorAccountId: "0.0.999999" }),
      configForProfile("standard"),
    );
    expect(r.decision).toBe("BLOCK");
    const vendor = r.checks.find((c) => c.policyId === "allowed-vendor");
    expect(vendor?.outcome).toBe("BLOCK");
    expect(vendor?.reasonCode).toBe("VENDOR_ACCOUNT_MISMATCH");
  });

  it("blocked_vendor profile substitutes a bad account and blocks", () => {
    const r = evaluatePolicies(
      baseCtx({ profile: "blocked_vendor" }),
      configForProfile("blocked_vendor"),
    );
    expect(r.decision).toBe("BLOCK");
  });
});

describe("policy engine — shipment context (deterministic need)", () => {
  it("blocks a low-value, high-confidence, no-signal shipment", () => {
    const r = evaluatePolicies(
      baseCtx({ shipment: getShipment("RG-3003")! }),
      configForProfile("standard"),
    );
    const ship = r.checks.find((c) => c.policyId === "shipment-context");
    expect(ship?.outcome).toBe("BLOCK");
    expect(ship?.reasonCode).toBe("SHIPMENT_INELIGIBLE");
  });

  it("passes a temperature-controlled shipment", () => {
    const r = evaluatePolicies(
      baseCtx({ shipment: getShipment("RG-2002")! }),
      configForProfile("standard"),
    );
    const ship = r.checks.find((c) => c.policyId === "shipment-context");
    expect(ship?.outcome).toBe("PASS");
  });
});

describe("policy engine — per-purchase cap (hard block)", () => {
  it("blocks above the cap and cannot be overridden by approval", () => {
    const cfg = configForProfile("standard");
    const r = evaluatePolicies(
      baseCtx({
        amountTinybars: cfg.maxPerPurchaseTinybars + 1,
        humanApproved: true,
        atExecution: true,
      }),
      cfg,
    );
    expect(r.decision).toBe("BLOCK");
    expect(
      r.checks.find((c) => c.policyId === "per-purchase-cap")?.outcome,
    ).toBe("BLOCK");
  });
});

describe("policy engine — approval threshold (strict)", () => {
  it("requires approval when amount exceeds the strict threshold", () => {
    const r = evaluatePolicies(baseCtx(), configForProfile("strict"));
    expect(r.decision).toBe("REQUIRE_APPROVAL");
  });

  it("blocks at execution if approval required but not granted", () => {
    const r = evaluatePolicies(
      baseCtx({ atExecution: true, humanApproved: false }),
      configForProfile("strict"),
    );
    expect(r.decision).toBe("BLOCK");
    expect(r.checks.find((c) => c.policyId === "approval")?.reasonCode).toBe(
      "APPROVAL_REQUIRED",
    );
  });

  it("passes at execution once approval is granted", () => {
    const r = evaluatePolicies(
      baseCtx({ atExecution: true, humanApproved: true }),
      configForProfile("strict"),
    );
    expect(r.decision).toBe("ALLOW_AUTONOMOUS");
  });
});

describe("policy engine — daily budget", () => {
  it("blocks when projected spend exceeds the daily budget", () => {
    const cfg = configForProfile("standard");
    const r = evaluatePolicies(
      baseCtx({ budget: { spentTinybars: cfg.dailyBudgetTinybars } }),
      cfg,
    );
    expect(r.decision).toBe("BLOCK");
    expect(r.checks.find((c) => c.policyId === "daily-budget")?.outcome).toBe(
      "BLOCK",
    );
  });

  it("budget_exhausted profile blocks", () => {
    const r = evaluatePolicies(
      baseCtx({ profile: "budget_exhausted" }),
      configForProfile("budget_exhausted"),
    );
    expect(r.decision).toBe("BLOCK");
  });
});

describe("policy engine — replay protection", () => {
  it("blocks when the candidate memo already exists", () => {
    const r = evaluatePolicies(
      baseCtx({ existingMemo: "RG:abc12345", candidateMemo: "RG:abc12345" }),
      configForProfile("standard"),
    );
    expect(r.checks.find((c) => c.policyId === "replay-protection")?.outcome).toBe(
      "BLOCK",
    );
  });
});
