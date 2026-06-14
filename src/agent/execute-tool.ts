import { z } from "zod";
import { BaseTool } from "@hashgraph/hedera-agent-kit";
import type { Client } from "@hiero-ledger/sdk";
import { config } from "../config/index.js";
import { getShipment } from "../store/fixtures.js";
import { store, type PurchaseRecord } from "../store/store.js";
import {
  configForProfile,
  evaluatePolicies,
  type PolicyContext,
} from "../policy/engine.js";
import {
  type PolicyProfile,
  type ServiceCatalogItem,
  type PaymentProof,
  type PremiumReport,
  type AuditAnchor,
  RouteGuardError,
  RGError,
  sha256,
} from "../domain/index.js";
import { executePayment, type ExecutionMode } from "../hedera/payment.js";
import { verifyPaymentOnMirror } from "../hedera/mirror.js";
import { anchorAuditEvent } from "../hedera/hcs.js";
import { generatePremiumReport } from "../risk/engine.js";
import type { ExecutionPlan } from "./transaction-integrity-policy.js";

/**
 * execute_route_risk_purchase — a transaction BaseTool.
 *
 * Lifecycle (enforced by BaseTool):
 *   normalizeParams  → load immutable proposal, re-resolve trusted values
 *   coreAction       → reserve budget, BUILD the execution plan (no submit yet)
 *   [postCoreActionHook] → TransactionIntegrityPolicy runs here; throws on mismatch
 *   secondaryAction  → submit payment (sim or testnet), verify, unlock API, anchor HCS
 *
 * The input schema has NO recipient and NO amount — both are server-resolved.
 */

const ExecuteParams = z.object({
  proposalId: z.string().uuid(),
  executionMode: z
    .enum(["SIMULATION", "AUTONOMOUS_TESTNET"])
    .default("SIMULATION"),
});
type ExecuteParamsT = z.infer<typeof ExecuteParams>;

interface ExecuteNormalised {
  proposalId: string;
  executionMode: ExecutionMode;
  shipmentId: string;
  catalogItem: ServiceCatalogItem;
  amountTinybars: number;
  vendorAccountId: string;
  memo: string;
  profile: PolicyProfile;
  humanApproved: boolean;
  policyHash: string;
}

function serverCatalogItem(): ServiceCatalogItem {
  return {
    vendorId: config.vendor.vendorId,
    vendorAccountId: config.HEDERA_VENDOR_ACCOUNT_ID ?? "0.0.VENDOR_PLACEHOLDER",
    serviceCategory: config.vendor.serviceCategory,
    sku: config.vendor.sku,
    version: config.vendor.version,
    priceTinybars: config.CATALOG_PRICE_TINYBARS,
    currency: "HBAR",
    network: "testnet",
    active: true,
  };
}

export const EXECUTE_TOOL = "execute_route_risk_purchase";

export class ExecuteRouteRiskPurchaseTool extends BaseTool<
  ExecuteParamsT,
  ExecuteNormalised
> {
  method = EXECUTE_TOOL;
  name = "Execute RouteRisk Purchase";
  description = `Execute an already policy-approved Premium RouteRisk purchase.
Parameters:
- proposalId (uuid, required): the approved proposal to execute.
- executionMode (string): "SIMULATION" (default) or "AUTONOMOUS_TESTNET".
The recipient and amount are NOT parameters — they are resolved from trusted server data.
Re-evaluates all policies, builds the exact transfer, runs the transaction-integrity policy, pays, verifies on the mirror node, unlocks the report, and anchors an HCS audit event.`;
  parameters = ExecuteParams;

  async normalizeParams(
    params: ExecuteParamsT,
    _context: unknown,
    _client: Client,
  ): Promise<ExecuteNormalised> {
    const proposal = store.proposals.get(params.proposalId);
    if (!proposal)
      throw new RouteGuardError(
        RGError.MODEL_OUTPUT_INVALID,
        `Unknown proposal ${params.proposalId}.`,
      );
    if (proposal.status === "BLOCKED")
      throw new RouteGuardError(
        RGError.POLICY_SHIPMENT_INELIGIBLE,
        "Proposal is blocked and cannot be executed.",
      );

    const catalogItem = serverCatalogItem();
    const memo = `RG:${proposal.id.slice(0, 8)}`;

    return {
      proposalId: proposal.id,
      executionMode: params.executionMode,
      shipmentId: proposal.shipmentId,
      catalogItem,
      amountTinybars: catalogItem.priceTinybars,
      vendorAccountId: catalogItem.vendorAccountId,
      memo,
      profile: proposal.policyProfile,
      humanApproved: store.approvals.has(proposal.id),
      policyHash:
        store.decisions.get(proposal.id)?.canonicalHash ?? "unknown",
    };
  }

  async coreAction(
    n: ExecuteNormalised,
    _context: unknown,
    _client: Client,
  ): Promise<{ executionPlan: ExecutionPlan; normalised: ExecuteNormalised }> {
    // Idempotent short-circuit: if already paid, do not build a second plan.
    const existing = store.purchases.get(n.proposalId);
    if (
      existing &&
      (existing.state === "PAYMENT_CONFIRMED" ||
        existing.state === "API_UNLOCKED" ||
        existing.state === "COMPLETED")
    ) {
      // Signal to secondaryAction that we reuse the existing result.
      return {
        executionPlan: this.planFor(n, existing.payment?.transactionId ?? null),
        normalised: n,
      };
    }

    const shipment = getShipment(n.shipmentId)!;
    const cfg = configForProfile(n.profile);

    // MANDATORY re-evaluation at execution time (budget/catalog may have changed).
    const ctx: PolicyContext = {
      shipment,
      catalogItem: n.catalogItem,
      proposedVendorAccountId: n.vendorAccountId,
      profile: n.profile,
      amountTinybars: n.amountTinybars,
      budget: { spentTinybars: store.spentTinybarsToday() },
      humanApproved: n.humanApproved,
      atExecution: true,
      alreadyPurchasedForShipment: store.alreadyPurchasedForShipment(
        n.shipmentId,
      ),
      existingMemo: store.memoExists(n.memo) ? n.memo : null,
      candidateMemo: n.memo,
    };
    const decision = evaluatePolicies(ctx, cfg);
    store.decisions.set(n.proposalId, decision);
    if (decision.decision === "BLOCK") {
      const blocking = decision.checks.find((c) => c.outcome === "BLOCK");
      throw new RouteGuardError(
        mapReasonToError(blocking?.reasonCode),
        blocking?.publicMessage ?? "Execution blocked by policy.",
      );
    }
    if (decision.decision === "REQUIRE_APPROVAL") {
      throw new RouteGuardError(
        RGError.POLICY_APPROVAL_REQUIRED,
        "Human approval is required before this purchase can execute.",
      );
    }

    // Atomic budget reservation BEFORE building the transfer.
    const reserved = store.reserveBudget(
      n.proposalId,
      n.amountTinybars,
      cfg.dailyBudgetTinybars,
    );
    if (!reserved)
      throw new RouteGuardError(
        RGError.POLICY_DAILY_BUDGET,
        "Daily budget exhausted; reservation refused.",
      );

    return { executionPlan: this.planFor(n, null), normalised: n };
  }

  /** Build the integrity-checkable plan. proposalHash === transactionPlanHash by construction here. */
  private planFor(
    n: ExecuteNormalised,
    _existingTx: string | null,
  ): ExecutionPlan {
    const intended = [
      { account: config.HEDERA_OPERATOR_ID ?? "0.0.OPERATOR", amountTinybars: -n.amountTinybars },
      { account: n.vendorAccountId, amountTinybars: n.amountTinybars },
    ];
    const planCore = {
      network: "testnet" as const,
      vendorAccountId: n.vendorAccountId,
      amountTinybars: n.amountTinybars,
      memo: n.memo,
      intendedTransfers: intended,
      modelProvidedTransfers: false,
      usesScheduleOrAllowanceOrContract: false,
    };
    const hash = sha256(planCore);
    return { ...planCore, proposalHash: hash, transactionPlanHash: hash };
  }

  async shouldSecondaryAction(): Promise<boolean> {
    return true; // we do submit (or simulate) a payment
  }

  async secondaryAction(
    coreResult: { executionPlan: ExecutionPlan; normalised: ExecuteNormalised },
    _client: Client,
    _context: unknown,
  ): Promise<ExecuteResult> {
    const n = coreResult.normalised;

    // Reuse path (idempotent retry after a prior successful payment).
    const existing = store.purchases.get(n.proposalId);
    if (existing && existing.payment && existing.state !== "FAILED") {
      const report =
        existing.report ??
        (await this.unlockAndStore(existing, n, existing.payment));
      return buildResult(existing, report);
    }

    const record: PurchaseRecord = {
      proposalId: n.proposalId,
      shipmentId: n.shipmentId,
      vendorAccountId: n.vendorAccountId,
      amountTinybars: n.amountTinybars,
      memo: n.memo,
      transactionId: null,
      state: "EXECUTING",
      errorCode: null,
      auditTrail: [],
    };
    store.purchases.set(n.proposalId, record);
    this.setProposalStatus(n.proposalId, "EXECUTING");

    // 1) Pay (simulation or live testnet).
    let payment: PaymentProof;
    try {
      payment = await executePayment({
        vendorAccountId: n.vendorAccountId,
        amountTinybars: n.amountTinybars,
        memo: n.memo,
        mode: n.executionMode,
      });
    } catch (err) {
      store.releaseBudget(n.proposalId);
      record.state = "FAILED";
      record.errorCode =
        err instanceof RouteGuardError ? err.code : RGError.HEDERA_SUBMISSION_FAILED;
      this.setProposalStatus(n.proposalId, "FAILED");
      throw err;
    }
    record.payment = payment;
    record.transactionId = payment.transactionId;
    record.state = "PAYMENT_CONFIRMED";
    store.commitBudget(n.proposalId);
    this.setProposalStatus(n.proposalId, "PAYMENT_CONFIRMED");
    record.auditTrail.push(
      await anchorAuditEvent("PAYMENT_CONFIRMED", {
        proposalId: n.proposalId,
        policyHash: n.policyHash,
        txId: payment.transactionId,
        mode: n.executionMode,
      }),
    );

    // 2) Unlock the report (independent step — ret1ryable without repaying).
    const report = await this.unlockAndStore(record, n, payment);
    return buildResult(record, report);
  }

  /** Vendor-side verification + report generation + single-use redemption. */
  private async unlockAndStore(
    record: PurchaseRecord,
    n: ExecuteNormalised,
    payment: PaymentProof,
  ): Promise<PremiumReport> {
    // For live testnet, independently verify on the mirror node before unlocking.
    if (payment.mode === "AUTONOMOUS_TESTNET") {
      const verify = await verifyPaymentOnMirror({
        transactionId: payment.transactionId,
        expectedPayerAccountId: payment.payerAccountId,
        expectedVendorAccountId: n.vendorAccountId,
        expectedAmountTinybars: n.amountTinybars,
        expectedMemo: n.memo,
      });
      if (!verify.ok) {
        record.state = "FAILED";
        record.errorCode = verify.reasonCode ?? RGError.VENDOR_PAYMENT_INVALID;
        this.setProposalStatus(n.proposalId, "FAILED");
        throw new RouteGuardError(
          (verify.reasonCode as never) ?? RGError.VENDOR_PAYMENT_INVALID,
          "Vendor could not verify the payment on the mirror node.",
          true,
        );
      }
    }

    // Single-use redemption: a transaction can unlock exactly one report.
    const redeemed = store.redeem(payment.transactionId, n.proposalId);
    if (!redeemed)
      throw new RouteGuardError(
        RGError.VENDOR_PAYMENT_REPLAYED,
        "This payment has already been redeemed for a different purchase.",
      );

    const report = generatePremiumReport(
      getShipment(n.shipmentId)!,
      payment.transactionId,
    );
    record.report = report;
    record.state = "COMPLETED";
    this.setProposalStatus(n.proposalId, "COMPLETED");

    record.auditTrail.push(
      await anchorAuditEvent("API_ACCESS_GRANTED", {
        proposalId: n.proposalId,
        policyHash: n.policyHash,
        txId: payment.transactionId,
        reportHash: report.reportHash,
        mode: payment.mode,
      }),
    );
    record.auditTrail.push(
      await anchorAuditEvent("REPORT_DELIVERED", {
        proposalId: n.proposalId,
        policyHash: n.policyHash,
        txId: payment.transactionId,
        reportHash: report.reportHash,
        mode: payment.mode,
      }),
    );
    return report;
  }

  private setProposalStatus(
    proposalId: string,
    status: PurchaseRecord["state"],
  ): void {
    const p = store.proposals.get(proposalId);
    if (p) p.status = status;
  }

  async handleError(error: unknown): Promise<never> {
    if (error instanceof RouteGuardError) throw error;
    throw new RouteGuardError(
      RGError.HEDERA_SUBMISSION_FAILED,
      `Execution failed: ${String(error)}`,
      true,
    );
  }
}

export interface ExecuteResult {
  proposalId: string;
  state: string;
  payment: PaymentProof | undefined;
  report: PremiumReport | undefined;
  auditTrail: AuditAnchor[];
}

function buildResult(
  record: PurchaseRecord,
  report: PremiumReport,
): ExecuteResult {
  return {
    proposalId: record.proposalId,
    state: record.state,
    payment: record.payment,
    report,
    auditTrail: record.auditTrail,
  };
}

function mapReasonToError(reason?: string) {
  switch (reason) {
    case "VENDOR_NOT_ALLOWED":
    case "VENDOR_ACCOUNT_MISMATCH":
      return RGError.POLICY_VENDOR_BLOCKED;
    case "DAILY_BUDGET":
      return RGError.POLICY_DAILY_BUDGET;
    case "PER_PURCHASE_CAP":
      return RGError.POLICY_PER_PURCHASE_CAP;
    case "SHIPMENT_INELIGIBLE":
    case "ALREADY_PURCHASED":
      return RGError.POLICY_SHIPMENT_INELIGIBLE;
    case "REPLAY":
      return RGError.POLICY_REPLAY;
    default:
      return RGError.POLICY_TRANSACTION_INTEGRITY;
  }
}
