import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { config } from "../src/config/index.js";
import {
  RGError,
  RouteGuardError,
  sha256,
  type PaymentProof,
  type PolicyDecisionResult,
  type PurchaseProposal,
} from "../src/domain/index.js";
import { generateBasicReport } from "../src/risk/engine.js";
import { getShipment } from "../src/store/fixtures.js";
import { store, type PurchaseRecord } from "../src/store/store.js";
import { buildVerificationResult } from "../src/verification/result.js";
import {
  ENTITLEMENT_TTL_MS,
  PremiumRouteRiskVendorService,
} from "../src/vendor/premium-route-risk.js";
import {
  DEMO_TENANT_ID,
  providerEvidenceService,
} from "../src/provider-evidence/service.js";

function seedCompletedPurchase(
  mode: "SIMULATION" | "AUTONOMOUS_TESTNET" = "SIMULATION",
  proposalId = randomUUID(),
) {
  const shipment = getShipment("RG-1001")!;
  const basic = generateBasicReport(shipment, {
    evaluatedAt: "2026-06-21T12:00:00.000Z",
  });
  const proposal: PurchaseProposal = {
    id: proposalId,
    shipmentId: shipment.id,
    liveRouteId: null,
    requestedSku: "premium-route-risk-v1",
    rationale: "Premium analysis is justified by deterministic shipment evidence.",
    expectedBenefit: "Complete factor attribution and operational controls.",
    status: "PAYMENT_CONFIRMED",
    policyProfile: "standard",
    createdAt: "2026-06-21T12:00:00.000Z",
  };
  const decision: PolicyDecisionResult = {
    decision: "ALLOW_AUTONOMOUS",
    checks: [],
    policyVersion: "1.0",
    canonicalHash: sha256({ proposalId, decision: "ALLOW_AUTONOMOUS" }),
    evaluatedAt: "2026-06-21T12:00:00.000Z",
  };
  const payment: PaymentProof = {
    network: "testnet",
    mode,
    transactionId:
      mode === "SIMULATION"
        ? `0.0.0@${proposalId.slice(0, 8)}.000000001`
        : `0.0.123@${proposalId.slice(0, 8)}.000000001`,
    payerAccountId: mode === "SIMULATION" ? "0.0.SIMULATED" : "0.0.123",
    vendorAccountId:
      config.HEDERA_VENDOR_ACCOUNT_ID ?? "0.0.VENDOR_PLACEHOLDER",
    amountTinybars: config.CATALOG_PRICE_TINYBARS,
    memo: `RG:${proposalId.slice(0, 8)}`,
    consensusTimestamp:
      mode === "SIMULATION" ? "1710000000.000000001" : "1710000000.000000002",
    result: "SUCCESS",
    explorerUrl:
      mode === "SIMULATION"
        ? "simulation://no-on-chain-transaction"
        : "https://hashscan.io/testnet/transaction/example",
  };
  const target = {
    type: "SHIPMENT" as const,
    id: shipment.id,
    freeAssessment: basic,
  };
  const record: PurchaseRecord = {
    proposalId,
    shipmentId: shipment.id,
    vendorAccountId: payment.vendorAccountId,
    amountTinybars: payment.amountTinybars,
    memo: payment.memo,
    transactionId: payment.transactionId,
    executionMode: mode,
    state: "PAYMENT_CONFIRMED",
    errorCode: null,
    payment,
    mirrorNodeConfirmation:
      mode === "SIMULATION" ? "NOT_APPLICABLE" : "CONFIRMED",
    mirrorFailureReason: null,
    auditTrail: [],
    target,
    verification: buildVerificationResult({
      executionMode: mode,
      payment,
      mirrorNodeConfirmation:
        mode === "SIMULATION" ? "NOT_APPLICABLE" : "CONFIRMED",
      auditTrail: [],
      hcsConfigured: false,
      decision,
    }),
  };
  store.proposals.set(proposalId, proposal);
  store.decisions.set(proposalId, decision);
  store.purchaseTargets.set(proposalId, target);
  store.purchases.set(proposalId, record);
  return { proposal, record, basic };
}

function expectCode(fn: () => unknown, code: string) {
  try {
    fn();
    throw new Error(`Expected ${code}.`);
  } catch (error) {
    expect(error).toBeInstanceOf(RouteGuardError);
    expect((error as RouteGuardError).code).toBe(code);
  }
}

describe("Premium RouteRisk vendor entitlement", () => {
  beforeEach(() => store.reset());

  it("issues and atomically redeems one simulation entitlement", () => {
    const vendor = new PremiumRouteRiskVendorService();
    const { record } = seedCompletedPurchase();
    const issued = vendor.issueForCompletedPurchase(
      record,
      new Date("2026-06-21T12:00:00.000Z"),
    );
    expect(issued.entitlement.executionMode).toBe("SIMULATION");
    expect(issued.entitlement.status).toBe("ISSUED");
    expect(issued.token).toHaveLength(43);
    expect(JSON.stringify(issued.entitlement)).not.toContain(issued.token);
    expect(store.entitlements.get(issued.entitlement.entitlementId)?.tokenHash).toBe(
      sha256(issued.token),
    );
    expectCode(
      () => vendor.issueForCompletedPurchase(record),
      RGError.ENTITLEMENT_REPLAYED,
    );

    const redeemed = vendor.redeem(
      issued.token,
      new Date("2026-06-21T12:01:00.000Z"),
    );
    expect(redeemed.entitlement.status).toBe("REDEEMED");
    expect(redeemed.report.reportType).toBe("SHIPMENT");
    expectCode(() => vendor.redeem(issued.token), RGError.ENTITLEMENT_REPLAYED);
  });

  it("issues testnet entitlement only for a confirmed real payment", () => {
    const vendor = new PremiumRouteRiskVendorService();
    const { record } = seedCompletedPurchase("AUTONOMOUS_TESTNET");
    const issued = vendor.issueForCompletedPurchase(record);
    expect(issued.entitlement.executionMode).toBe("AUTONOMOUS_TESTNET");
    expect(issued.entitlement.paymentReference).toBe(
      record.payment?.transactionId,
    );
    expect(store.entitlements.size).toBe(1);

    store.reset();
    const unconfirmed = seedCompletedPurchase("AUTONOMOUS_TESTNET").record;
    unconfirmed.mirrorNodeConfirmation = "PENDING";
    expectCode(
      () => vendor.issueForCompletedPurchase(unconfirmed),
      RGError.PURCHASE_NOT_COMPLETED,
    );
  });

  it("rejects missing, unknown, expired, and replayed tokens", () => {
    const vendor = new PremiumRouteRiskVendorService();
    expectCode(() => vendor.redeem(undefined), RGError.ENTITLEMENT_REQUIRED);
    expectCode(
      () => vendor.redeem("x".repeat(43)),
      RGError.ENTITLEMENT_NOT_FOUND,
    );
    const { record } = seedCompletedPurchase();
    const issued = vendor.issueForCompletedPurchase(
      record,
      new Date("2026-06-21T12:00:00.000Z"),
    );
    expect(
      Date.parse(issued.entitlement.expiresAt) -
        Date.parse(issued.entitlement.issuedAt),
    ).toBe(ENTITLEMENT_TTL_MS);
    expectCode(
      () =>
        vendor.redeem(
          issued.token,
          new Date("2026-06-21T12:16:00.000Z"),
        ),
      RGError.ENTITLEMENT_EXPIRED,
    );
  });

  it("binds entitlement to proposal, SKU, vendor, and exact amount", () => {
    const vendor = new PremiumRouteRiskVendorService();
    const first = seedCompletedPurchase();
    const issued = vendor.issueForCompletedPurchase(first.record);
    const second = seedCompletedPurchase();
    store.entitlements.get(issued.entitlement.entitlementId)!.proposalId =
      second.proposal.id;
    expectCode(() => vendor.redeem(issued.token), RGError.ENTITLEMENT_MISMATCH);

    store.reset();
    const modifiedProposal = seedCompletedPurchase();
    const modifiedToken = vendor.issueForCompletedPurchase(
      modifiedProposal.record,
    ).token;
    modifiedProposal.proposal.rationale += " modified";
    expectCode(
      () => vendor.redeem(modifiedToken),
      RGError.ENTITLEMENT_MISMATCH,
    );

    store.reset();
    const skuCase = seedCompletedPurchase();
    const skuToken = vendor.issueForCompletedPurchase(skuCase.record).token;
    (skuCase.proposal as { requestedSku: string }).requestedSku = "other-sku";
    expectCode(() => vendor.redeem(skuToken), RGError.ENTITLEMENT_MISMATCH);

    store.reset();
    const amountCase = seedCompletedPurchase();
    const amountToken = vendor.issueForCompletedPurchase(amountCase.record).token;
    amountCase.record.amountTinybars += 1;
    expectCode(() => vendor.redeem(amountToken), RGError.ENTITLEMENT_MISMATCH);

    store.reset();
    const vendorCase = seedCompletedPurchase();
    const vendorToken = vendor.issueForCompletedPurchase(vendorCase.record).token;
    vendorCase.record.vendorAccountId = "0.0.NOT_THE_VENDOR";
    expectCode(() => vendor.redeem(vendorToken), RGError.ENTITLEMENT_MISMATCH);
  });

  it("requires a completed authorized purchase", () => {
    const vendor = new PremiumRouteRiskVendorService();
    const { record } = seedCompletedPurchase();
    record.state = "BLOCKED";
    expectCode(
      () => vendor.issueForCompletedPurchase(record),
      RGError.PURCHASE_NOT_COMPLETED,
    );

    store.reset();
    const revoked = seedCompletedPurchase();
    const token = vendor.issueForCompletedPurchase(revoked.record).token;
    revoked.record.state = "FAILED";
    expectCode(
      () => vendor.redeem(token),
      RGError.PURCHASE_NOT_COMPLETED,
    );
  });

  it("delivers materially richer canonical report content", () => {
    const vendor = new PremiumRouteRiskVendorService();
    providerEvidenceService.create(
      DEMO_TENANT_ID,
      {
        providerAlias: "PRV-001",
        providerDisplayName: "Private Provider Name",
        lane: "Rotterdam → Leipzig",
        transportMode: "road",
        shipmentReference: "RG-1001",
        delayMinutes: 90,
        deliveredOnTime: false,
        trackingCompletenessPercent: 88,
        cancellationOrIssue: false,
        temperatureExcursion: false,
        documentIssue: false,
        damageClaim: false,
        documentSummary: "A private delivery note records a measured delay.",
        confidence: 0.9,
      },
      new Date("2026-06-21T11:00:00.000Z"),
    );
    const { record, basic } = seedCompletedPurchase();
    const issued = vendor.issueForCompletedPurchase(record);
    const report = vendor.redeem(issued.token).report;
    expect(report.reportType).toBe("SHIPMENT");
    if (report.reportType !== "SHIPMENT") return;
    expect(Object.keys(report).length).toBeGreaterThan(Object.keys(basic).length);
    expect(report.route.origin).toContain("Rotterdam");
    expect(report.factors.length).toBeGreaterThan(basic.visibleFactors.length);
    expect(report.mitigationRecommendations.length).toBeGreaterThan(0);
    expect(report.operationalRecommendations.length).toBeGreaterThan(0);
    expect(report.privateProviderReliabilitySignal?.providerAlias).toBe("PRV-001");
    expect(report.etaReliabilityRisk.onTimeRiskBand).toMatch(/LOW|MODERATE|HIGH/);
    expect(report.insuranceSupportEvidence.disclaimer).toContain(
      "does not sell, price, approve, or determine insurance",
    );
    expect(report.alternativeRouteOrMitigationRecommendation.recommendation).toBeTruthy();
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("Private Provider Name");
    expect(serialized).not.toContain("bad carrier");
    expect(serialized).not.toContain("insurance approval");
    const { reportHash, ...canonicalContent } = report;
    expect(reportHash).toBe(sha256(canonicalContent));
  });
});
