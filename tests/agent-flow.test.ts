import { describe, it, expect, beforeEach } from "vitest";
import {
  AgentService,
  type ApprovalSecurityOptions,
} from "../src/server/agent-service.js";
import { store } from "../src/store/store.js";

/**
 * End-to-end behavior through the real BaseTool lifecycle (simulation mode,
 * heuristic intent). Proves the policy → payment → unlock → audit path and the
 * idempotency / replay / budget invariants the spec requires.
 */

function svc(
  approvalSecurity: ApprovalSecurityOptions = {
    authEnabled: false,
    approverEmails: [],
  },
) {
  return new AgentService({} as never, approvalSecurity);
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
      expect(r.verification.status).toBe("SIMULATION_EVIDENCE");
      expect(r.verification.transactionSubmitted).toBe(false);
      expect(r.verification.mirrorNodeConfirmation).toBe("NOT_APPLICABLE");
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

  it("simulation approval works and is marked as an unauthenticated demo", async () => {
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
      if (after.kind === "COMPLETED") {
        expect(after.approval?.mode).toBe("SIMULATED_DEMO");
        expect(after.approval?.status).toBe("USED");
        expect(after.approval?.approverLabel).toContain("unauthenticated");
        expect(after.approval?.approvedAt).toBeTruthy();
      }
    }
  });

  it("rejects live-testnet approval when approver authentication is not configured", async () => {
    const s = svc({ authEnabled: false, approverEmails: [] });
    const r = await s.run({
      shipmentId: "RG-1001",
      scenarioId: "approval-required",
      executionMode: "SIMULATION",
    });
    expect(r.kind).toBe("APPROVAL_REQUIRED");
    if (r.kind !== "APPROVAL_REQUIRED") return;

    const after = await s.approveAndExecute(
      r.proposalId,
      "AUTONOMOUS_TESTNET",
    );
    expect(after.kind).toBe("FAILED");
    if (after.kind === "FAILED") {
      expect(after.errorCode).toBe("RG_APPROVER_AUTH_REQUIRED");
    }
    expect(store.approvals.has(r.proposalId)).toBe(false);
  });

  it("does not approve an unknown proposal", async () => {
    const after = await svc().approveAndExecute(
      "00000000-0000-4000-8000-000000000000",
      "SIMULATION",
    );
    expect(after.kind).toBe("FAILED");
    if (after.kind === "FAILED") {
      expect(after.errorCode).toBe("RG_APPROVAL_INVALID");
    }
  });

  it("refuses approval when immutable proposal details were modified", async () => {
    const s = svc();
    const r = await s.run({
      shipmentId: "RG-1001",
      scenarioId: "approval-required",
      executionMode: "SIMULATION",
    });
    expect(r.kind).toBe("APPROVAL_REQUIRED");
    if (r.kind !== "APPROVAL_REQUIRED") return;
    const proposal = store.proposals.get(r.proposalId)!;
    proposal.rationale = proposal.rationale + " modified";

    const after = await s.approveAndExecute(r.proposalId, "SIMULATION");
    expect(after.kind).toBe("FAILED");
    if (after.kind === "FAILED") {
      expect(after.errorCode).toBe("RG_APPROVAL_BINDING_MISMATCH");
    }
  });

  it("does not approve an expired proposal", async () => {
    const s = svc();
    const r = await s.run({
      shipmentId: "RG-1001",
      scenarioId: "approval-required",
      executionMode: "SIMULATION",
    });
    expect(r.kind).toBe("APPROVAL_REQUIRED");
    if (r.kind !== "APPROVAL_REQUIRED") return;
    store.approvalBindings.get(r.proposalId)!.expiresAt = new Date(0).toISOString();

    const after = await s.approveAndExecute(r.proposalId, "SIMULATION");
    expect(after.kind).toBe("FAILED");
    if (after.kind === "FAILED") {
      expect(after.errorCode).toBe("RG_APPROVAL_EXPIRED");
    }
  });

  it("does not replay an approval after it has been used", async () => {
    const s = svc();
    const r = await s.run({
      shipmentId: "RG-1001",
      scenarioId: "approval-required",
      executionMode: "SIMULATION",
    });
    expect(r.kind).toBe("APPROVAL_REQUIRED");
    if (r.kind !== "APPROVAL_REQUIRED") return;

    const first = await s.approveAndExecute(r.proposalId, "SIMULATION");
    expect(first.kind).toBe("COMPLETED");
    const firstTransaction =
      first.kind === "COMPLETED" ? first.payment.transactionId : null;
    const replay = await s.approveAndExecute(r.proposalId, "SIMULATION");
    expect(replay.kind).toBe("FAILED");
    if (replay.kind === "FAILED") {
      expect(replay.errorCode).toBe("RG_APPROVAL_REPLAYED");
    }
    expect(store.purchases.get(r.proposalId)?.transactionId).toBe(
      firstTransaction,
    );
  });

  it("records a simulation rejection without authorizing payment", async () => {
    const s = svc();
    const r = await s.run({
      shipmentId: "RG-1001",
      scenarioId: "approval-required",
      executionMode: "SIMULATION",
    });
    expect(r.kind).toBe("APPROVAL_REQUIRED");
    if (r.kind !== "APPROVAL_REQUIRED") return;

    const after = await s.rejectProposal(r.proposalId, "SIMULATION");
    expect(after.kind).toBe("REJECTED");
    if (after.kind === "REJECTED") {
      expect(after.approval.mode).toBe("SIMULATED_DEMO");
      expect(after.approval.status).toBe("REJECTED");
    }
    expect(store.purchases.has(r.proposalId)).toBe(false);
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
