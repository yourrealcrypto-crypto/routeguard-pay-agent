import type { Client } from "@hiero-ledger/sdk";
import { RouteGuardOrchestrator } from "../agent/plugin.js";
import { generatePurchaseIntent } from "../agent/llm.js";
import { getShipment, getScenario, type ExecutionMode } from "../store/fixtures.js";
import { store } from "../store/store.js";
import type { ApprovalBinding } from "../store/store.js";
import { generateBasicReport } from "../risk/engine.js";
import { anchorAuditEvent } from "../hedera/hcs.js";
import { config } from "../config/index.js";
import {
  type PolicyDecisionResult,
  type BasicReport,
  type PaymentProof,
  type PremiumReport,
  type AuditAnchor,
  type ApprovalMode,
  type ApprovalRecord,
  type PurchaseProposal,
  type VerificationResult,
  type PremiumEntitlementView,
  RouteGuardError,
  RGError,
  sha256,
} from "../domain/index.js";
import { buildVerificationResult } from "../verification/result.js";
import { assessLiveRouteRisk } from "../live-routes/service.js";
import type { LiveRouteId, LiveRouteRiskResult } from "../domain/index.js";

/**
 * Orchestration algorithm (deterministic app code owns state; the LLM only
 * produces bounded intent):
 *   load shipment → free assessment → bounded model intent
 *   NO_PURCHASE        → return free assessment + explanation
 *   PROPOSE_PURCHASE   → propose tool → policy decision
 *     BLOCK            → return blocked
 *     REQUIRE_APPROVAL → return approval card
 *     ALLOW_AUTONOMOUS → execute tool → report + proofs
 */

export type AgentRunResult =
  | {
      kind: "NO_PURCHASE";
      shipmentId: string;
      basic: BasicReport;
      explanation: string;
      intentSource: "llm" | "heuristic";
    }
  | {
      kind: "BLOCKED";
      shipmentId: string;
      proposalId: string;
      basic: BasicReport;
      rationale: string;
      decision: PolicyDecisionResult;
      lifecycle: ReturnType<RouteGuardOrchestrator["lifecycleEvents"]>;
      auditTrail: AuditAnchor[];
    }
  | {
      kind: "APPROVAL_REQUIRED";
      shipmentId: string;
      proposalId: string;
      basic: BasicReport;
      rationale: string;
      expectedBenefit: string;
      decision: PolicyDecisionResult;
      executionMode: ExecutionMode;
      approvalRequest: ApprovalRequestView;
      lifecycle: ReturnType<RouteGuardOrchestrator["lifecycleEvents"]>;
    }
  | {
      kind: "REJECTED";
      shipmentId: string;
      proposalId: string;
      rationale: string;
      decision: PolicyDecisionResult;
      approval: ApprovalRecord;
    }
  | {
      kind: "COMPLETED";
      shipmentId: string;
      proposalId: string;
      basic: BasicReport;
      rationale: string;
      decision: PolicyDecisionResult;
      payment: PaymentProof;
      report: PremiumReport;
      auditTrail: AuditAnchor[];
      verification: VerificationResult;
      entitlement: PremiumEntitlementView;
      lifecycle: ReturnType<RouteGuardOrchestrator["lifecycleEvents"]>;
      approval?: ApprovalRecord;
    }
  | {
      kind: "FAILED";
      shipmentId: string;
      proposalId?: string;
      errorCode: string;
      message: string;
      verification?: VerificationResult;
    };

export type LiveRouteRunResult =
  | {
      kind: "NO_PURCHASE";
      routeId: LiveRouteId;
      freeAssessment: LiveRouteRiskResult;
      explanation: string;
    }
  | {
      kind: "BLOCKED";
      routeId: LiveRouteId;
      proposalId: string;
      freeAssessment: LiveRouteRiskResult;
      rationale: string;
      decision: PolicyDecisionResult;
      auditTrail: AuditAnchor[];
    }
  | {
      kind: "APPROVAL_REQUIRED";
      routeId: LiveRouteId;
      proposalId: string;
      freeAssessment: LiveRouteRiskResult;
      rationale: string;
      expectedBenefit: string;
      decision: PolicyDecisionResult;
      approvalRequest: ApprovalRequestView;
    }
  | {
      kind: "COMPLETED";
      routeId: LiveRouteId;
      proposalId: string;
      freeAssessment: LiveRouteRiskResult;
      rationale: string;
      decision: PolicyDecisionResult;
      payment: PaymentProof;
      report: PremiumReport;
      entitlement: PremiumEntitlementView;
      auditTrail: AuditAnchor[];
      verification: VerificationResult;
      lifecycle: ReturnType<RouteGuardOrchestrator["lifecycleEvents"]>;
      approval?: ApprovalRecord;
    }
  | {
      kind: "FAILED";
      routeId: LiveRouteId;
      proposalId?: string;
      errorCode: string;
      message: string;
      verification?: VerificationResult;
    };

export interface ApprovalRequestView {
  shipmentId: string;
  vendorId: string;
  vendorAccountId: string;
  sku: string;
  amountTinybars: number;
  proposalId: string;
  proposalHash: string;
  policyHash: string;
  reason: string;
  createdAt: string;
  expiresAt: string;
  validity: "VALID";
  mode: ApprovalMode;
}

export interface VerifiedApproverContext {
  authenticationVerified?: boolean;
  authenticatedApproverEmail?: string;
}

export interface ApprovalSecurityOptions {
  authEnabled: boolean;
  approverEmails: string[];
}

const APPROVAL_VALIDITY_MS = 15 * 60 * 1000;

export class AgentService {
  private orch: RouteGuardOrchestrator;
  private approvalSecurity: ApprovalSecurityOptions;

  constructor(
    client: Client,
    approvalSecurity: ApprovalSecurityOptions = {
      authEnabled: config.approvalAuthConfigured,
      approverEmails: config.APPROVER_EMAILS,
    },
  ) {
    this.orch = new RouteGuardOrchestrator(client);
    this.approvalSecurity = approvalSecurity;
  }

  get orchestrator(): RouteGuardOrchestrator {
    return this.orch;
  }

  async run(input: {
    shipmentId: string;
    scenarioId: string;
    executionMode: ExecutionMode;
  }): Promise<AgentRunResult> {
    const shipment = getShipment(input.shipmentId);
    const scenario = getScenario(input.scenarioId);
    if (!shipment || !scenario)
      return {
        kind: "FAILED",
        shipmentId: input.shipmentId,
        errorCode: "RG_MODEL_OUTPUT_INVALID",
        message: "Unknown shipment or scenario.",
      };

    // Inject the red-team note for the prompt-injection scenario only.
    const effectiveShipment = scenario.injectionNote
      ? { ...shipment, notes: scenario.injectionNote }
      : shipment;

    const basic = generateBasicReport(effectiveShipment);
    const { output: intent, source } =
      await generatePurchaseIntent(effectiveShipment);

    if (intent.action === "NO_PURCHASE") {
      return {
        kind: "NO_PURCHASE",
        shipmentId: shipment.id,
        basic,
        explanation: intent.explanation,
        intentSource: source,
      };
    }

    // PROPOSE via the BaseTool lifecycle.
    let proposalId: string;
    let decision: PolicyDecisionResult;
    try {
      const proposed = await this.orch.propose({
        shipmentId: shipment.id,
        rationale: intent.rationale,
        expectedBenefit: intent.expectedBenefit,
        policyProfile: scenario.policyProfile,
      });
      proposalId = proposed.proposal.id;
      decision = proposed.decision;
      store.approvalBindings.set(
        proposalId,
        createApprovalBinding(proposed.proposal, decision),
      );
      store.purchaseTargets.set(proposalId, {
        type: "SHIPMENT",
        id: shipment.id,
        freeAssessment: basic,
      });
    } catch (err) {
      return failure(shipment.id, undefined, err);
    }

    // Audit the proposal + its policy outcome (works in sim via local hash).
    await anchorAuditEvent("PURCHASE_PROPOSED", {
      proposalId,
      policyHash: decision.canonicalHash,
      mode: input.executionMode,
    });

    if (decision.decision === "BLOCK") {
      await anchorAuditEvent("POLICY_BLOCKED", {
        proposalId,
        policyHash: decision.canonicalHash,
        mode: input.executionMode,
      });
      return {
        kind: "BLOCKED",
        shipmentId: shipment.id,
        proposalId,
        basic,
        rationale: intent.rationale,
        decision,
        lifecycle: this.orch.lifecycleEvents(),
        auditTrail: [],
      };
    }

    if (decision.decision === "REQUIRE_APPROVAL") {
      await anchorAuditEvent("POLICY_APPROVAL_REQUIRED", {
        proposalId,
        policyHash: decision.canonicalHash,
        mode: input.executionMode,
      });
      return {
        kind: "APPROVAL_REQUIRED",
        shipmentId: shipment.id,
        proposalId,
        basic,
        rationale: intent.rationale,
        expectedBenefit: intent.expectedBenefit,
        decision,
        executionMode: input.executionMode,
        approvalRequest: approvalRequestView(
          store.approvalBindings.get(proposalId)!,
          decision,
          input.executionMode,
        ),
        lifecycle: this.orch.lifecycleEvents(),
      };
    }

    // ALLOW_AUTONOMOUS → execute.
    await anchorAuditEvent("POLICY_AUTO_APPROVED", {
      proposalId,
      policyHash: decision.canonicalHash,
      mode: input.executionMode,
    });
    return this.executeApproved(
      shipment.id,
      proposalId,
      basic,
      intent.rationale,
      decision,
      input.executionMode,
    );
  }

  async runLiveRoute(input: {
    routeId: LiveRouteId;
    executionMode: ExecutionMode;
  }): Promise<LiveRouteRunResult> {
    const freeAssessment = await assessLiveRouteRisk(input.routeId);
    if (!freeAssessment.premiumReportRecommended)
      return {
        kind: "NO_PURCHASE",
        routeId: input.routeId,
        freeAssessment,
        explanation:
          "The deterministic free assessment is sufficient; premium API access was not proposed.",
      };

    const proposed = await this.orch.proposeLiveRoute(input.routeId);
    const proposalId = proposed.proposal.id;
    const decision = proposed.decision;
    store.approvalBindings.set(
      proposalId,
      createApprovalBinding(proposed.proposal, decision),
    );
    await anchorAuditEvent("PURCHASE_PROPOSED", {
      proposalId,
      policyHash: decision.canonicalHash,
      mode: input.executionMode,
    });
    if (decision.decision === "BLOCK") {
      await anchorAuditEvent("POLICY_BLOCKED", {
        proposalId,
        policyHash: decision.canonicalHash,
        mode: input.executionMode,
      });
      return {
        kind: "BLOCKED",
        routeId: input.routeId,
        proposalId,
        freeAssessment,
        rationale: proposed.proposal.rationale,
        decision,
        auditTrail: [],
      };
    }
    if (decision.decision === "REQUIRE_APPROVAL") {
      await anchorAuditEvent("POLICY_APPROVAL_REQUIRED", {
        proposalId,
        policyHash: decision.canonicalHash,
        mode: input.executionMode,
      });
      return {
        kind: "APPROVAL_REQUIRED",
        routeId: input.routeId,
        proposalId,
        freeAssessment,
        rationale: proposed.proposal.rationale,
        expectedBenefit: proposed.proposal.expectedBenefit,
        decision,
        approvalRequest: approvalRequestView(
          store.approvalBindings.get(proposalId)!,
          decision,
          input.executionMode,
        ),
      };
    }
    await anchorAuditEvent("POLICY_AUTO_APPROVED", {
      proposalId,
      policyHash: decision.canonicalHash,
      mode: input.executionMode,
    });
    return this.executeLiveApproved(
      input.routeId,
      proposalId,
      freeAssessment,
      proposed.proposal.rationale,
      decision,
      input.executionMode,
    );
  }

  /** Called after a human taps Approve. Re-evaluates policy inside the execute tool. */
  async approveAndExecute(
    proposalId: string,
    executionMode: ExecutionMode,
    approverContext: VerifiedApproverContext = {},
  ): Promise<AgentRunResult | LiveRouteRunResult> {
    const proposal = store.proposals.get(proposalId);
    let approvalUseStarted = false;
    try {
      const { decision, binding } = this.validateApprovalProposal(proposalId);
      const identity = this.resolveApprover(executionMode, approverContext);
      const approvedAt = new Date().toISOString();
      const approval: ApprovalRecord = {
        proposalId,
        proposalHash: binding.proposalHash,
        policyHash: binding.policyHash,
        mode: identity.mode,
        status: "APPROVED",
        approverLabel: identity.approverLabel,
        approvedAt,
        rejectedAt: null,
        usedAt: null,
      };
      if (!store.recordApproval(approval) || !store.beginApprovalUse(proposalId)) {
        throw new RouteGuardError(
          RGError.APPROVAL_REPLAYED,
          "This proposal approval has already been recorded or used.",
        );
      }
      approvalUseStarted = true;

      this.orch.recordApproval(proposalId);
      await anchorAuditEvent("HUMAN_APPROVED", {
        proposalId,
        policyHash: binding.policyHash,
        mode: executionMode,
      });
      if (proposal!.liveRouteId) {
        const target = store.purchaseTargets.get(proposalId);
        if (!target || target.type !== "LIVE_ROUTE")
          throw new RouteGuardError(
            RGError.APPROVAL_BINDING_MISMATCH,
            "The live-route assessment bound to this approval is unavailable.",
          );
        const result = await this.executeLiveApproved(
          proposal!.liveRouteId,
          proposalId,
          target.freeAssessment,
          proposal!.rationale,
          decision,
          executionMode,
        );
        store.finishApprovalUse(proposalId);
        approvalUseStarted = false;
        return result.kind === "COMPLETED"
          ? { ...result, approval: store.approvals.get(proposalId) }
          : result;
      }
      const basic = generateBasicReport(getShipment(proposal!.shipmentId)!);
      const result = await this.executeApproved(
        proposal!.shipmentId,
        proposalId,
        basic,
        proposal!.rationale,
        decision,
        executionMode,
      );
      store.finishApprovalUse(proposalId);
      approvalUseStarted = false;
      if (result.kind === "COMPLETED") {
        return { ...result, approval: store.approvals.get(proposalId) };
      }
      return result;
    } catch (err) {
      if (approvalUseStarted) store.finishApprovalUse(proposalId);
      return failure(proposal?.shipmentId ?? "unknown", proposalId, err);
    }
  }

  async rejectProposal(
    proposalId: string,
    executionMode: ExecutionMode,
    approverContext: VerifiedApproverContext = {},
  ): Promise<AgentRunResult> {
    const proposal = store.proposals.get(proposalId);
    try {
      const { decision, binding } = this.validateApprovalProposal(proposalId);
      const identity = this.resolveApprover(executionMode, approverContext);
      const rejectedAt = new Date().toISOString();
      const approval: ApprovalRecord = {
        proposalId,
        proposalHash: binding.proposalHash,
        policyHash: binding.policyHash,
        mode: identity.mode,
        status: "REJECTED",
        approverLabel: identity.approverLabel,
        approvedAt: null,
        rejectedAt,
        usedAt: null,
      };
      if (!store.recordApproval(approval)) {
        throw new RouteGuardError(
          RGError.APPROVAL_REPLAYED,
          "This proposal already has an approval decision.",
        );
      }
      proposal!.status = "REJECTED";
      await anchorAuditEvent("HUMAN_REJECTED", {
        proposalId,
        policyHash: binding.policyHash,
        mode: executionMode,
      });
      return {
        kind: "REJECTED",
        shipmentId: proposal!.shipmentId,
        proposalId,
        rationale: proposal!.rationale,
        decision,
        approval,
      };
    } catch (err) {
      return failure(proposal?.shipmentId ?? "unknown", proposalId, err);
    }
  }

  private validateApprovalProposal(proposalId: string): {
    proposal: PurchaseProposal;
    decision: PolicyDecisionResult;
    binding: ApprovalBinding;
  } {
    const proposal = store.proposals.get(proposalId);
    const decision = store.decisions.get(proposalId);
    const binding = store.approvalBindings.get(proposalId);
    if (!proposal || !decision || !binding) {
      throw new RouteGuardError(
        RGError.APPROVAL_INVALID,
        "Unknown or incomplete approval proposal.",
      );
    }
    if (store.approvals.has(proposalId)) {
      throw new RouteGuardError(
        RGError.APPROVAL_REPLAYED,
        "This proposal already has an approval decision.",
      );
    }
    if (
      proposal.status !== "APPROVAL_REQUIRED" ||
      decision.decision !== "REQUIRE_APPROVAL"
    ) {
      throw new RouteGuardError(
        proposal.status === "REJECTED"
          ? RGError.APPROVAL_REJECTED
          : RGError.APPROVAL_INVALID,
        "This proposal is not awaiting approval.",
      );
    }
    if (Date.parse(binding.expiresAt) <= Date.now()) {
      throw new RouteGuardError(
        RGError.APPROVAL_EXPIRED,
        "This approval request has expired.",
      );
    }
    const currentHash = proposalApprovalHash(proposal, decision);
    if (
      currentHash !== binding.proposalHash ||
      decision.canonicalHash !== binding.policyHash
    ) {
      throw new RouteGuardError(
        RGError.APPROVAL_BINDING_MISMATCH,
        "Proposal details changed after policy evaluation; approval refused.",
      );
    }
    return { proposal, decision, binding };
  }

  private resolveApprover(
    executionMode: ExecutionMode,
    context: VerifiedApproverContext,
  ): { mode: ApprovalMode; approverLabel: string } {
    if (executionMode === "SIMULATION") {
      return {
        mode: "SIMULATED_DEMO",
        approverLabel: "Demo operator · unauthenticated",
      };
    }
    const email = context.authenticatedApproverEmail?.trim().toLowerCase();
    if (
      !this.approvalSecurity.authEnabled ||
      !context.authenticationVerified ||
      !email ||
      !this.approvalSecurity.approverEmails.includes(email)
    ) {
      throw new RouteGuardError(
        RGError.APPROVER_AUTH_REQUIRED,
        "Authenticated, allowlisted approver identity is required for live testnet approval.",
      );
    }
    return { mode: "AUTHENTICATED_LIVE_TESTNET", approverLabel: email };
  }

  private async executeApproved(
    shipmentId: string,
    proposalId: string,
    basic: BasicReport,
    rationale: string,
    decision: PolicyDecisionResult,
    executionMode: ExecutionMode,
  ): Promise<AgentRunResult> {
    try {
      const result = await this.orch.execute(proposalId, executionMode);
      if (!result.payment || !result.report || !result.entitlement)
        return {
          kind: "FAILED",
          shipmentId,
          proposalId,
          errorCode: "RG_VENDOR_API_FAILED",
          message: "Payment or report missing after execution.",
          verification: result.verification,
        };
      return {
        kind: "COMPLETED",
        shipmentId,
        proposalId,
        basic,
        rationale,
        decision: store.decisions.get(proposalId) ?? decision,
        payment: result.payment,
        report: result.report,
        auditTrail: result.auditTrail,
        verification: result.verification,
        entitlement: result.entitlement,
        lifecycle: this.orch.lifecycleEvents(),
      };
    } catch (err) {
      return failure(shipmentId, proposalId, err);
    }
  }

  private async executeLiveApproved(
    routeId: LiveRouteId,
    proposalId: string,
    freeAssessment: LiveRouteRiskResult,
    rationale: string,
    decision: PolicyDecisionResult,
    executionMode: ExecutionMode,
  ): Promise<LiveRouteRunResult> {
    try {
      const result = await this.orch.execute(proposalId, executionMode);
      if (!result.payment || !result.report || !result.entitlement)
        return {
          kind: "FAILED",
          routeId,
          proposalId,
          errorCode: RGError.VENDOR_API_FAILED,
          message: "Payment, entitlement, or report missing after execution.",
          verification: result.verification,
        };
      return {
        kind: "COMPLETED",
        routeId,
        proposalId,
        freeAssessment,
        rationale,
        decision: store.decisions.get(proposalId) ?? decision,
        payment: result.payment,
        report: result.report,
        entitlement: result.entitlement,
        auditTrail: result.auditTrail,
        verification: result.verification,
        lifecycle: this.orch.lifecycleEvents(),
      };
    } catch (error) {
      if (error instanceof RouteGuardError)
        return {
          kind: "FAILED",
          routeId,
          proposalId,
          errorCode: error.code,
          message: error.publicMessage,
          verification: verificationAfterFailure(
            proposalId,
            error.code,
            error.publicMessage,
          ),
        };
      return {
        kind: "FAILED",
        routeId,
        proposalId,
        errorCode: RGError.HEDERA_SUBMISSION_FAILED,
        message: String(error),
      };
    }
  }
}

function proposalApprovalHash(
  proposal: PurchaseProposal,
  decision: PolicyDecisionResult,
): string {
  return sha256({
    proposalId: proposal.id,
    shipmentId: proposal.shipmentId,
    liveRouteId: proposal.liveRouteId ?? null,
    requestedSku: proposal.requestedSku,
    rationale: proposal.rationale,
    expectedBenefit: proposal.expectedBenefit,
    policyProfile: proposal.policyProfile,
    createdAt: proposal.createdAt,
    vendorId: config.vendor.vendorId,
    vendorAccountId:
      config.HEDERA_VENDOR_ACCOUNT_ID ?? "0.0.VENDOR_PLACEHOLDER",
    amountTinybars: config.CATALOG_PRICE_TINYBARS,
    policyHash: decision.canonicalHash,
  });
}

function createApprovalBinding(
  proposal: PurchaseProposal,
  decision: PolicyDecisionResult,
): ApprovalBinding {
  return {
    proposalId: proposal.id,
    shipmentId: proposal.shipmentId,
    vendorId: config.vendor.vendorId,
    vendorAccountId:
      config.HEDERA_VENDOR_ACCOUNT_ID ?? "0.0.VENDOR_PLACEHOLDER",
    sku: config.vendor.sku,
    amountTinybars: config.CATALOG_PRICE_TINYBARS,
    policyHash: decision.canonicalHash,
    proposalHash: proposalApprovalHash(proposal, decision),
    createdAt: proposal.createdAt,
    expiresAt: new Date(
      Date.parse(proposal.createdAt) + APPROVAL_VALIDITY_MS,
    ).toISOString(),
  };
}

function approvalRequestView(
  binding: ApprovalBinding,
  decision: PolicyDecisionResult,
  executionMode: ExecutionMode,
): ApprovalRequestView {
  return {
    ...binding,
    reason:
      decision.checks.find((check) => check.outcome === "REQUIRE_APPROVAL")
        ?.publicMessage ?? "Policy requires human approval.",
    validity: "VALID",
    mode:
      executionMode === "SIMULATION"
        ? "SIMULATED_DEMO"
        : "AUTHENTICATED_LIVE_TESTNET",
  };
}

function failure(
  shipmentId: string,
  proposalId: string | undefined,
  err: unknown,
): AgentRunResult {
  if (err instanceof RouteGuardError) {
    const verification = verificationAfterFailure(
      proposalId,
      err.code,
      err.publicMessage,
    );
    return {
      kind: "FAILED",
      shipmentId,
      proposalId,
      errorCode: err.code,
      message: err.publicMessage,
      ...(verification ? { verification } : {}),
    };
  }
  const message = String(err);
  const verification = verificationAfterFailure(
    proposalId,
    RGError.HEDERA_SUBMISSION_FAILED,
    message,
  );
  return {
    kind: "FAILED",
    shipmentId,
    proposalId,
    errorCode: "RG_HEDERA_SUBMISSION_FAILED",
    message,
    ...(verification ? { verification } : {}),
  };
}

function verificationAfterFailure(
  proposalId: string | undefined,
  failureCode: string,
  failureReason: string,
): VerificationResult | undefined {
  if (!proposalId) return undefined;
  const record = store.purchases.get(proposalId);
  if (!record) return undefined;
  const verification = buildVerificationResult({
    executionMode: record.executionMode,
    payment: record.payment,
    submittedTransaction: record.submittedTransaction,
    vendorAccountId: record.vendorAccountId,
    amountTinybars: record.amountTinybars,
    memo: record.memo,
    mirrorNodeConfirmation: record.mirrorNodeConfirmation,
    auditTrail: record.auditTrail,
    hcsConfigured: config.hcsConfigured,
    configuredHcsTopicId: config.HCS_AUDIT_TOPIC_ID ?? null,
    report: record.report,
    decision: store.decisions.get(proposalId),
    failureCode,
    failureReason,
  });
  record.verification = verification;
  return verification;
}
