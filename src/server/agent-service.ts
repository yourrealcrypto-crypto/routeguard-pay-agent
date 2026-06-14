import type { Client } from "@hiero-ledger/sdk";
import { RouteGuardOrchestrator } from "../agent/plugin.js";
import { generatePurchaseIntent } from "../agent/llm.js";
import { getShipment, getScenario, type ExecutionMode } from "../store/fixtures.js";
import { store } from "../store/store.js";
import { generateBasicReport } from "../risk/engine.js";
import { anchorAuditEvent } from "../hedera/hcs.js";
import {
  type PolicyDecisionResult,
  type BasicReport,
  type PaymentProof,
  type PremiumReport,
  type AuditAnchor,
  RouteGuardError,
} from "../domain/index.js";

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
      lifecycle: ReturnType<RouteGuardOrchestrator["lifecycleEvents"]>;
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
      lifecycle: ReturnType<RouteGuardOrchestrator["lifecycleEvents"]>;
    }
  | {
      kind: "FAILED";
      shipmentId: string;
      proposalId?: string;
      errorCode: string;
      message: string;
    };

export class AgentService {
  private orch: RouteGuardOrchestrator;
  constructor(client: Client) {
    this.orch = new RouteGuardOrchestrator(client);
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

  /** Called after a human taps Approve. Re-evaluates policy inside the execute tool. */
  async approveAndExecute(
    proposalId: string,
    executionMode: ExecutionMode,
  ): Promise<AgentRunResult> {
    const proposal = store.proposals.get(proposalId);
    if (!proposal)
      return {
        kind: "FAILED",
        proposalId,
        shipmentId: "unknown",
        errorCode: "RG_MODEL_OUTPUT_INVALID",
        message: "Unknown proposal.",
      };
    this.orch.recordApproval(proposalId);
    await anchorAuditEvent("HUMAN_APPROVED", {
      proposalId,
      policyHash: store.decisions.get(proposalId)?.canonicalHash ?? "unknown",
      mode: executionMode,
    });
    const basic = generateBasicReport(getShipment(proposal.shipmentId)!);
    return this.executeApproved(
      proposal.shipmentId,
      proposalId,
      basic,
      proposal.rationale,
      store.decisions.get(proposalId)!,
      executionMode,
    );
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
      if (!result.payment || !result.report)
        return {
          kind: "FAILED",
          shipmentId,
          proposalId,
          errorCode: "RG_VENDOR_API_FAILED",
          message: "Payment or report missing after execution.",
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
        lifecycle: this.orch.lifecycleEvents(),
      };
    } catch (err) {
      return failure(shipmentId, proposalId, err);
    }
  }
}

function failure(
  shipmentId: string,
  proposalId: string | undefined,
  err: unknown,
): AgentRunResult {
  if (err instanceof RouteGuardError)
    return {
      kind: "FAILED",
      shipmentId,
      proposalId,
      errorCode: err.code,
      message: err.publicMessage,
    };
  return {
    kind: "FAILED",
    shipmentId,
    proposalId,
    errorCode: "RG_HEDERA_SUBMISSION_FAILED",
    message: String(err),
  };
}
