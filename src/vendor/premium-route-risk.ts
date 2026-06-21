import { randomBytes, randomUUID } from "node:crypto";
import { config } from "../config/index.js";
import {
  PremiumEntitlementRecordSchema,
  RGError,
  RouteGuardError,
  sha256,
  type PremiumEntitlementRecord,
  type PremiumEntitlementView,
  type PremiumReport,
  type PurchaseProposal,
} from "../domain/index.js";
import { generatePremiumReport } from "../risk/engine.js";
import { generateLiveRoutePremiumReport } from "../risk/live-premium.js";
import {
  DEMO_TENANT_ID,
  providerEvidenceService,
} from "../provider-evidence/service.js";
import { getShipment } from "../store/fixtures.js";
import {
  store,
  type PurchaseRecord,
  type PurchaseTargetSnapshot,
} from "../store/store.js";

export const ENTITLEMENT_TTL_MS = 15 * 60 * 1_000;

export interface IssuedEntitlement {
  token: string;
  entitlement: PremiumEntitlementView;
}

export interface RedeemedPremiumAccess {
  entitlement: PremiumEntitlementView;
  report: PremiumReport;
}

export class PremiumRouteRiskVendorService {
  issueForCompletedPurchase(
    purchase: PurchaseRecord,
    now = new Date(),
  ): IssuedEntitlement {
    if (purchase.entitlementId)
      throw new RouteGuardError(
        RGError.ENTITLEMENT_REPLAYED,
        "This purchase already has a premium entitlement.",
      );
    const proposal = store.proposals.get(purchase.proposalId);
    const target = purchase.target ?? store.purchaseTargets.get(purchase.proposalId);
    this.assertPurchaseCompleted(purchase, proposal, target);

    const token = randomBytes(32).toString("base64url");
    const tokenHash = sha256(token);
    const entitlementId = randomUUID();
    const issuedAt = now.toISOString();
    const record = PremiumEntitlementRecordSchema.parse({
      entitlementId,
      tokenHash,
      bindingHash: bindingHash(proposal!, purchase, target!),
      proposalId: proposal!.id,
      targetType: target!.type,
      shipmentId: target!.type === "SHIPMENT" ? target!.id : null,
      liveRouteId: target!.type === "LIVE_ROUTE" ? target!.id : null,
      vendorId: config.vendor.vendorId,
      vendorAccountId: purchase.vendorAccountId,
      sku: proposal!.requestedSku,
      amountTinybars: purchase.amountTinybars,
      executionMode: purchase.executionMode,
      paymentReference: purchase.payment!.transactionId,
      issuedAt,
      expiresAt: new Date(now.getTime() + ENTITLEMENT_TTL_MS).toISOString(),
      redeemedAt: null,
      status: "ISSUED",
    });
    if (!store.registerEntitlement(record))
      throw new RouteGuardError(
        RGError.ENTITLEMENT_MISMATCH,
        "A unique premium entitlement could not be issued.",
      );
    purchase.entitlementId = entitlementId;
    purchase.state = "API_UNLOCKED";
    return { token, entitlement: entitlementView(record) };
  }

  redeem(tokenInput: unknown, now = new Date()): RedeemedPremiumAccess {
    if (typeof tokenInput !== "string" || tokenInput.length < 32)
      throw new RouteGuardError(
        RGError.ENTITLEMENT_REQUIRED,
        "A valid opaque entitlement token is required.",
      );
    const record = store.entitlementForTokenHash(sha256(tokenInput));
    if (!record)
      throw new RouteGuardError(
        RGError.ENTITLEMENT_NOT_FOUND,
        "The premium entitlement was not found.",
      );
  if (record.status !== "ISSUED") {
  throw new RouteGuardError(
    RGError.ENTITLEMENT_REPLAYED,
    "The premium entitlement has already been redeemed or consumed.",
  );
}

if (Date.parse(record.expiresAt) <= now.getTime()) {
  record.status = "EXPIRED";
  throw new RouteGuardError(
    RGError.ENTITLEMENT_EXPIRED,
    "The premium entitlement has expired.",
  );
}

    const proposal = store.proposals.get(record.proposalId);
    const purchase = store.purchases.get(record.proposalId);
    const target = store.purchaseTargets.get(record.proposalId) ?? purchase?.target;
    this.assertPurchaseCompleted(purchase, proposal, target);
    if (
      !proposal ||
      !purchase ||
      !target ||
      record.vendorId !== config.vendor.vendorId ||
      record.vendorAccountId !== purchase.vendorAccountId ||
      record.sku !== config.vendor.sku ||
      record.sku !== proposal.requestedSku ||
      record.amountTinybars !== purchase.amountTinybars ||
      record.executionMode !== purchase.executionMode ||
      record.paymentReference !== purchase.payment?.transactionId ||
      record.bindingHash !== bindingHash(proposal, purchase, target)
    )
      throw new RouteGuardError(
        RGError.ENTITLEMENT_MISMATCH,
        "The premium entitlement no longer matches its authorized purchase.",
      );

    // This synchronous state transition is the atomic single-use claim. Any
    // concurrent request observes REDEEMING and is rejected as a replay.
    record.status = "REDEEMING";
    try {
      const report = reportFor(target, purchase.payment!.transactionId);
      purchase.report = report;
      purchase.state = "COMPLETED";
      record.status = "REDEEMED";
      record.redeemedAt = now.toISOString();
      store.redeem(purchase.payment!.transactionId, purchase.proposalId);
      return { entitlement: entitlementView(record), report };
    } catch (error) {
      record.status = "FAILED";
      throw error instanceof RouteGuardError
        ? error
        : new RouteGuardError(
            RGError.VENDOR_API_FAILED,
            "Premium report generation failed after entitlement validation.",
            true,
          );
    }
  }

  view(entitlementId: string | undefined): PremiumEntitlementView | undefined {
    if (!entitlementId) return undefined;
    const record = store.entitlements.get(entitlementId);
    return record ? entitlementView(record) : undefined;
  }

  private assertPurchaseCompleted(
    purchase: PurchaseRecord | undefined,
    proposal: PurchaseProposal | undefined,
    target: PurchaseTargetSnapshot | undefined,
  ): void {
    const stateAllowsAccess =
      purchase?.state === "PAYMENT_CONFIRMED" ||
      purchase?.state === "API_UNLOCKED" ||
      purchase?.state === "COMPLETED";
    const validPayment =
      purchase?.payment?.result === "SUCCESS" &&
      purchase.payment.mode === purchase.executionMode;
    const testnetConfirmed =
      purchase?.executionMode !== "AUTONOMOUS_TESTNET" ||
      (purchase.mirrorNodeConfirmation === "CONFIRMED" &&
        Boolean(purchase.payment?.consensusTimestamp));
    if (!purchase || !proposal || !target || !stateAllowsAccess || !validPayment || !testnetConfirmed)
      throw new RouteGuardError(
        RGError.PURCHASE_NOT_COMPLETED,
        "A completed, authorized payment is required before premium API access.",
      );
  }
}

function bindingHash(
  proposal: PurchaseProposal,
  purchase: PurchaseRecord,
  target: PurchaseTargetSnapshot,
): string {
  return sha256({
    proposalId: proposal.id,
    shipmentId: proposal.shipmentId,
    liveRouteId: proposal.liveRouteId ?? null,
    targetType: target.type,
    targetId: target.id,
    requestedSku: proposal.requestedSku,
    rationale: proposal.rationale,
    expectedBenefit: proposal.expectedBenefit,
    policyProfile: proposal.policyProfile,
    proposalCreatedAt: proposal.createdAt,
    vendorId: config.vendor.vendorId,
    vendorAccountId: purchase.vendorAccountId,
    amountTinybars: purchase.amountTinybars,
    executionMode: purchase.executionMode,
    paymentReference: purchase.payment?.transactionId ?? null,
    policyHash: store.decisions.get(proposal.id)?.canonicalHash ?? null,
  });
}

function reportFor(
  target: PurchaseTargetSnapshot,
  paymentTransactionId: string,
): PremiumReport {
  if (target.type === "LIVE_ROUTE")
    return generateLiveRoutePremiumReport(
      target.freeAssessment,
      paymentTransactionId,
      {
        providerReliabilitySignal: providerEvidenceService.signalForTarget(
          DEMO_TENANT_ID,
          {
            reference: target.id,
            lane: `${target.freeAssessment.route.origin} → ${target.freeAssessment.route.destination}`,
            transportMode: "road",
          },
        ),
      },
    );
  const shipment = getShipment(target.id);
  if (!shipment)
    throw new RouteGuardError(
      RGError.ENTITLEMENT_MISMATCH,
      "The entitled shipment is no longer available.",
    );
  return generatePremiumReport(shipment, paymentTransactionId, {
    evaluatedAt: target.freeAssessment.evaluatedAt,
    providerReliabilitySignal: providerEvidenceService.signalForTarget(
      DEMO_TENANT_ID,
      {
        reference: shipment.id,
        lane: `${shipment.origin.city} → ${shipment.destination.city}`,
        transportMode: shipment.mode,
      },
    ),
  });
}

function entitlementView(
  record: PremiumEntitlementRecord,
): PremiumEntitlementView {
  const { tokenHash: _tokenHash, bindingHash: _bindingHash, ...view } = record;
  return structuredClone(view);
}

export const premiumRouteRiskVendor = new PremiumRouteRiskVendorService();
