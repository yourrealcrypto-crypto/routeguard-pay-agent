import {
  type PurchaseProposal,
  type PolicyDecisionResult,
  type PaymentProof,
  type PremiumReport,
  type AuditAnchor,
  type ApprovalRecord,
  type ProposalStatus,
  type MirrorNodeConfirmation,
  type SubmittedTransactionEvidence,
  type VerificationResult,
  type BasicReport,
  type LiveRouteRiskResult,
  type PremiumEntitlementRecord,
  type ProviderEvidenceRecord,
} from "../domain/index.js";

/**
 * A small in-memory store. The spec calls for PostgreSQL in production; for a
 * one-week bounty demo we keep an equivalent shape in memory with the SAME
 * invariants enforced (one purchase per proposal, single redemption per tx,
 * atomic-by-single-thread budget reservation). Swapping to Postgres later means
 * implementing this same interface — nothing else changes.
 */

export interface PurchaseRecord {
  proposalId: string;
  shipmentId: string;
  vendorAccountId: string;
  amountTinybars: number;
  memo: string;
  transactionId: string | null;
  executionMode: "SIMULATION" | "AUTONOMOUS_TESTNET";
  state: ProposalStatus;
  errorCode: string | null;
  payment?: PaymentProof;
  submittedTransaction?: SubmittedTransactionEvidence;
  mirrorNodeConfirmation: MirrorNodeConfirmation;
  mirrorFailureReason: string | null;
  report?: PremiumReport;
  auditTrail: AuditAnchor[];
  verification: VerificationResult;
  target?: PurchaseTargetSnapshot;
  entitlementId?: string;
}

export type PurchaseTargetSnapshot =
  | { type: "SHIPMENT"; id: string; freeAssessment: BasicReport }
  | { type: "LIVE_ROUTE"; id: string; freeAssessment: LiveRouteRiskResult };

export interface BudgetReservation {
  proposalId: string;
  budgetDate: string;
  amountTinybars: number;
  state: "RESERVED" | "COMMITTED" | "RELEASED";
}

export interface ApprovalBinding {
  proposalId: string;
  shipmentId: string;
  vendorId: string;
  vendorAccountId: string;
  sku: string;
  amountTinybars: number;
  policyHash: string;
  proposalHash: string;
  createdAt: string;
  expiresAt: string;
}

class Store {
  proposals = new Map<string, PurchaseProposal>();
  decisions = new Map<string, PolicyDecisionResult>();
  purchases = new Map<string, PurchaseRecord>();
  reservations = new Map<string, BudgetReservation>();
  /** transactionId → proposalId, makes a payment single-use at the vendor. */
  redemptions = new Map<string, string>();
  approvalBindings = new Map<string, ApprovalBinding>();
  approvals = new Map<string, ApprovalRecord>();
  purchaseTargets = new Map<string, PurchaseTargetSnapshot>();
  entitlements = new Map<string, PremiumEntitlementRecord>();
  entitlementTokens = new Map<string, string>();
  /** Private tenant evidence. Public APIs return redacted views only. */
  providerEvidence = new Map<string, ProviderEvidenceRecord>();

  private utcDate(): string {
    return new Date().toISOString().slice(0, 10);
  }

  /** Sum of RESERVED + COMMITTED tinybars for today. */
  spentTinybarsToday(): number {
    const today = this.utcDate();
    let sum = 0;
    for (const r of this.reservations.values()) {
      if (r.budgetDate === today && r.state !== "RELEASED")
        sum += r.amountTinybars;
    }
    return sum;
  }

  alreadyPurchasedForShipment(shipmentId: string): boolean {
    for (const p of this.purchases.values()) {
      if (
        p.shipmentId === shipmentId &&
        (p.state === "COMPLETED" ||
          p.state === "API_UNLOCKED" ||
          p.state === "PAYMENT_CONFIRMED")
      )
        return true;
    }
    return false;
  }

  memoExists(memo: string): string | null {
    for (const p of this.purchases.values()) {
      if (p.memo === memo) return p.proposalId;
    }
    return null;
  }

  /** Single-threaded "atomic" reservation. Returns false if it would overflow. */
  reserveBudget(
    proposalId: string,
    amountTinybars: number,
    dailyBudgetTinybars: number,
  ): boolean {
    const existing = this.reservations.get(proposalId);
    if (existing && existing.state !== "RELEASED") return true; // idempotent
    if (this.spentTinybarsToday() + amountTinybars > dailyBudgetTinybars)
      return false;
    this.reservations.set(proposalId, {
      proposalId,
      budgetDate: this.utcDate(),
      amountTinybars,
      state: "RESERVED",
    });
    return true;
  }

  commitBudget(proposalId: string): void {
    const r = this.reservations.get(proposalId);
    if (r) r.state = "COMMITTED";
  }
  releaseBudget(proposalId: string): void {
    const r = this.reservations.get(proposalId);
    if (r) r.state = "RELEASED";
  }

  redeem(transactionId: string, proposalId: string): boolean {
    if (this.redemptions.has(transactionId)) {
      return this.redemptions.get(transactionId) === proposalId; // same buyer ok (idempotent), other → false
    }
    this.redemptions.set(transactionId, proposalId);
    return true;
  }

  registerEntitlement(record: PremiumEntitlementRecord): boolean {
    if (
      this.entitlements.has(record.entitlementId) ||
      this.entitlementTokens.has(record.tokenHash)
    )
      return false;
    this.entitlements.set(record.entitlementId, record);
    this.entitlementTokens.set(record.tokenHash, record.entitlementId);
    return true;
  }

  entitlementForTokenHash(tokenHash: string): PremiumEntitlementRecord | undefined {
    const entitlementId = this.entitlementTokens.get(tokenHash);
    return entitlementId ? this.entitlements.get(entitlementId) : undefined;
  }

  recordApproval(record: ApprovalRecord): boolean {
    if (this.approvals.has(record.proposalId)) return false;
    this.approvals.set(record.proposalId, record);
    return true;
  }

  beginApprovalUse(proposalId: string): boolean {
    const approval = this.approvals.get(proposalId);
    if (!approval || approval.status !== "APPROVED") return false;
    approval.status = "IN_USE";
    return true;
  }

  finishApprovalUse(proposalId: string): void {
    const approval = this.approvals.get(proposalId);
    if (!approval || approval.status !== "IN_USE") return;
    approval.status = "USED";
    approval.usedAt = new Date().toISOString();
  }

  isApprovalAuthorizedForExecution(proposalId: string): boolean {
    return this.approvals.get(proposalId)?.status === "IN_USE";
  }

  reset(): void {
    this.proposals.clear();
    this.decisions.clear();
    this.purchases.clear();
    this.reservations.clear();
    this.redemptions.clear();
    this.approvalBindings.clear();
    this.approvals.clear();
    this.purchaseTargets.clear();
    this.entitlements.clear();
    this.entitlementTokens.clear();
    this.providerEvidence.clear();
  }
}

export const store = new Store();
