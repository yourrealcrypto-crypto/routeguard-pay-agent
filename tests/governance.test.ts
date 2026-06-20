import { beforeEach, describe, expect, it } from "vitest";
import { governance, type GovernanceRole } from "../src/governance/service.js";
import {
  calculateRiskPolicyHash,
  getActiveRiskPolicy,
} from "../src/risk/policy.js";
import { explainRiskScore } from "../src/risk/engine.js";
import { getShipment } from "../src/store/fixtures.js";

const CEO: GovernanceRole = "Chief Executive Officer";
const CRO: GovernanceRole = "Chief Risk Officer";
const COMPLIANCE: GovernanceRole = "Compliance Officer";
const NOW = new Date("2026-06-20T12:00:00.000Z");

function input(overrides: Record<string, unknown> = {}) {
  return {
    basePolicyVersion: getActiveRiskPolicy().policyVersion,
    field: "modeWeights.road",
    proposedValue: 12,
    reason: "Increase demonstrated road corridor sensitivity.",
    proposerRole: CEO,
    ...overrides,
  } as Parameters<typeof governance.submit>[0];
}

function activate(field = "modeWeights.road", proposedValue = 12) {
  const proposal = governance.submit(input({ field, proposedValue }), NOW);
  governance.approve(proposal.proposalId, CRO, proposal.proposalHash, NOW);
  return governance.approve(
    proposal.proposalId,
    COMPLIANCE,
    proposal.proposalHash,
    NOW,
  );
}

describe("versioned risk policy", () => {
  beforeEach(() => governance.reset());

  it("preserves the current synthetic fixture scores after extraction", () => {
    const evaluatedAt = "2026-06-20T00:00:00.000Z";
    expect(explainRiskScore(getShipment("RG-1001")!, { evaluatedAt }).riskScore).toBe(86);
    expect(explainRiskScore(getShipment("RG-2002")!, { evaluatedAt }).riskScore).toBe(75);
    expect(explainRiskScore(getShipment("RG-3003")!, { evaluatedAt }).riskScore).toBe(35);
  });

  it("returns an active policy with a stable canonical hash", () => {
    const first = getActiveRiskPolicy();
    const { policyHash, ...source } = first;
    expect(policyHash).toBe(calculateRiskPolicyHash(source));
    governance.reset();
    expect(getActiveRiskPolicy().policyHash).toBe(policyHash);
  });

  it("rejects unknown and locked policy fields", () => {
    expect(() => governance.submit(input({ field: "network" }), NOW)).toThrow(
      /Unknown or locked policy field/,
    );
    expect(() => governance.submit(input({ field: "maxPerPurchaseTinybars" }), NOW)).toThrow(
      /Unknown or locked policy field/,
    );
  });

  it("rejects out-of-bounds values", () => {
    expect(() => governance.submit(input({ proposedValue: 26 }), NOW)).toThrow(
      /between 0 and 25/,
    );
  });

  it("rejects invalid risk-band boundaries", () => {
    expect(() =>
      governance.submit(
        input({ field: "riskBands.0.maximum", proposedValue: 60 }),
        NOW,
      ),
    ).toThrow(/ordered, non-overlapping/);
  });
});

describe("simulated multi-role governance", () => {
  beforeEach(() => governance.reset());

  it("prevents proposer self-approval", () => {
    const proposal = governance.submit(input(), NOW);
    expect(() =>
      governance.approve(proposal.proposalId, CEO, proposal.proposalHash, NOW),
    ).toThrow(/proposer cannot approve/i);
  });

  it("prevents duplicate approval by one role", () => {
    const proposal = governance.submit(input(), NOW);
    governance.approve(proposal.proposalId, CRO, proposal.proposalHash, NOW);
    expect(() =>
      governance.approve(proposal.proposalId, CRO, proposal.proposalHash, NOW),
    ).toThrow(/already approved/);
  });

  it("activates a new version after two distinct approvals", () => {
    const result = activate();
    expect(result.status).toBe("ACTIVATED");
    expect(getActiveRiskPolicy().policyVersion).toBe("1.0.1");
    expect(getActiveRiskPolicy().modeWeights.road).toBe(12);
  });

  it("rejects a proposal based on a stale policy version", () => {
    const stale = governance.submit(input({ field: "modeWeights.air", proposedValue: 7 }), NOW);
    activate();
    expect(() =>
      governance.approve(stale.proposalId, CRO, stale.proposalHash, NOW),
    ).toThrow(/outdated policy version/);
  });

  it("does not allow an expired proposal to activate", () => {
    const proposal = governance.submit(input(), NOW);
    const expiredAt = new Date(NOW.getTime() + 25 * 60 * 60 * 1000);
    expect(() =>
      governance.approve(proposal.proposalId, CRO, proposal.proposalHash, expiredAt),
    ).toThrow(/expired/);
  });

  it("gives a modified proposal a new hash and no inherited approvals", () => {
    const original = governance.submit(input(), NOW);
    governance.approve(original.proposalId, CRO, original.proposalHash, NOW);
    const modified = governance.submit(input({ proposedValue: 13 }), NOW);
    expect(modified.proposalHash).not.toBe(original.proposalHash);
    expect(modified.approvals).toHaveLength(0);
    expect(() =>
      governance.approve(modified.proposalId, COMPLIANCE, original.proposalHash, NOW),
    ).toThrow(/exact canonical proposal hash/);
  });

  it("preserves the previous policy version in history", () => {
    activate();
    const history = governance.history();
    expect(history.map((entry) => entry.policy.policyVersion)).toEqual([
      "1.0.1",
      "1.0.0",
    ]);
    expect(history[1]?.policy.status).toBe("SUPERSEDED");
    expect(history[0]?.previousVersion).toBe("1.0.0");
  });

  it("uses the proposed draft policy for fixture impact preview", () => {
    const preview = governance.preview(input(), NOW);
    const roadShipment = preview.find((row) => row.shipmentId === "RG-1001")!;
    expect(roadShipment.proposedScore).toBe(roadShipment.oldScore + 1);
    expect(roadShipment.scoreDifference).toBe(1);
  });
});
