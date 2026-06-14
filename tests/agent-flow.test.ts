import { describe, it, expect, beforeEach } from "vitest";
import { AgentService } from "../src/server/agent-service.js";
import { store } from "../src/store/store.js";

/**
 * End-to-end behavior through the real BaseTool lifecycle (simulation mode,
 * heuristic intent). Proves the policy → payment → unlock → audit path and the
 * idempotency / replay / budget invariants the spec requires.
 */

function svc() {
  return new AgentService({} as never);
}

describe("agent flow — scenarios", () => {
  beforeEach(() => store.reset());

  it("auto-approved scenario completes with payment + report + audit", async () => {
    const r = await svc().run({
      shipmentId: "RG-1001",
      scenarioId: "auto-approved",
      executionMode: "SIMULATION",
    });
    expect(r.kind).toBe("COMPLETED");
    if (r.kind === "COMPLETED") {
      expect(r.payment.amountTinybars).toBe(5_000_000);
      expect(r.report.reportHash).toMatch(/^[0-9a-f]{64}$/);
      expect(r.payment.memo.startsWith("RG:")).toBe(true);
      expect(r.auditTrail.length).toBeGreaterThanOrEqual(2);
      // lifecycle hook observed both core stages
      expect(r.lifecycle.some((e) => e.stage === "post_core")).toBe(true);
    }
  });

  it("vendor-blocked scenario blocks with no purchase", async () => {
    const r = await svc().run({
      shipmentId: "RG-1001",
      scenarioId: "vendor-blocked",
      executionMode: "SIMULATION",
    });
    expect(r.kind).toBe("BLOCKED");
    expect(store.purchases.size).toBe(0);
  });

  it("no-purchase scenario declines to spend", async () => {
    const r = await svc().run({
      shipmentId: "RG-3003",
      scenarioId: "no-purchase",
      executionMode: "SIMULATION",
    });
    expect(r.kind).toBe("NO_PURCHASE");
    expect(store.purchases.size).toBe(0);
  });

  it("prompt-injection note does not change the payment target or amount", async () => {
    const r = await svc().run({
      shipmentId: "RG-1001",
      scenarioId: "prompt-injection",
      executionMode: "SIMULATION",
    });
    expect(r.kind).toBe("COMPLETED");
    if (r.kind === "COMPLETED") {
      expect(r.payment.amountTinybars).toBe(5_000_000); // not 100 HBAR
      expect(r.payment.vendorAccountId).not.toBe("0.0.999999");
    }
  });
});

describe("approval flow", () => {
  beforeEach(() => store.reset());

  it("strict scenario requires approval then completes", async () => {
    const s = svc();
    const r = await s.run({
      shipmentId: "RG-1001",
      scenarioId: "approval-required",
      executionMode: "SIMULATION",
    });
    expect(r.kind).toBe("APPROVAL_REQUIRED");
    if (r.kind === "APPROVAL_REQUIRED") {
      // cannot have paid yet
      expect(store.purchases.get(r.proposalId)?.payment).toBeUndefined();
      const after = await s.approveAndExecute(r.proposalId, "SIMULATION");
      expect(after.kind).toBe("COMPLETED");
    }
  });
});

describe("idempotency + single-use redemption", () => {
  beforeEach(() => store.reset());

  it("re-executing a completed proposal does not create a second payment", async () => {
    const s = svc();
    const r = await s.run({
      shipmentId: "RG-1001",
      scenarioId: "auto-approved",
      executionMode: "SIMULATION",
    });
    expect(r.kind).toBe("COMPLETED");
    if (r.kind !== "COMPLETED") return;

    const firstTx = r.payment.transactionId;
    const again = await s.orchestrator.execute(r.proposalId, "SIMULATION");
    expect(again.payment?.transactionId).toBe(firstTx);
    // exactly one redemption recorded for that tx
    expect(store.redemptions.get(firstTx)).toBe(r.proposalId);
  });

  it("a single shipment cannot be purchased twice", async () => {
    store.reset();
    const s = svc();
    const first = await s.run({
      shipmentId: "RG-1001",
      scenarioId: "auto-approved",
      executionMode: "SIMULATION",
    });
    expect(first.kind).toBe("COMPLETED");
    expect(store.alreadyPurchasedForShipment("RG-1001")).toBe(true);
    // second independent proposal for the same shipment must be blocked by context policy
    const r2 = await s.run({
      shipmentId: "RG-1001",
      scenarioId: "auto-approved",
      executionMode: "SIMULATION",
    });
    expect(r2.kind).toBe("BLOCKED");
    if (r2.kind === "BLOCKED") {
      expect(
        r2.decision.checks.find((c) => c.policyId === "shipment-context")
          ?.outcome,
      ).toBe("BLOCK");
    }
  });
});

describe("budget reservation", () => {
  beforeEach(() => store.reset());

  it("reserves then commits budget on success", async () => {
    const r = await svc().run({
      shipmentId: "RG-1001",
      scenarioId: "auto-approved",
      executionMode: "SIMULATION",
    });
    if (r.kind === "COMPLETED") {
      const res = store.reservations.get(r.proposalId);
      expect(res?.state).toBe("COMMITTED");
      expect(store.spentTinybarsToday()).toBe(5_000_000);
    }
  });
});
