import type { Client } from "@hiero-ledger/sdk";
import { AgentMode } from "@hashgraph/hedera-agent-kit";
import {
  ProposeRouteRiskPurchaseTool,
  PROPOSE_TOOL,
} from "./propose-tool.js";
import {
  ExecuteRouteRiskPurchaseTool,
  EXECUTE_TOOL,
  type ExecuteResult,
} from "./execute-tool.js";
import { TransactionIntegrityPolicy } from "./transaction-integrity-policy.js";
import {
  ProposeLiveRouteRiskPurchaseTool,
  PROPOSE_LIVE_ROUTE_TOOL,
} from "./propose-live-route-tool.js";
import { RouteGuardObservabilityHook } from "./observability-hook.js";
import { store } from "../store/store.js";
import { getShipment, type ExecutionMode } from "../store/fixtures.js";
import {
  type PolicyProfile,
  type PolicyDecisionResult,
  type PurchaseProposal,
  type LiveRouteId,
} from "../domain/index.js";

/**
 * RouteGuardPlugin — registers exactly two BaseTool tools and nothing else.
 * The agent has NO token-creation, account-deletion, contract, NFT, or
 * arbitrary-transfer capability. Capability is constrained by construction.
 */
export const RouteGuardPlugin = {
  name: "routeguard",
  version: "1.0.0",
  description:
    "Policy-gated logistics procurement: propose + execute a Premium RouteRisk purchase under deterministic Hedera Agent Kit policies.",
  tools: [PROPOSE_TOOL, PROPOSE_LIVE_ROUTE_TOOL, EXECUTE_TOOL],
};

/**
 * The orchestrator builds the Agent Kit Context (mode + hooks/policies) and runs
 * each BaseTool's full 7-stage lifecycle via `execute`. The hooks and the
 * TransactionIntegrityPolicy fire automatically at their lifecycle stages.
 */
export class RouteGuardOrchestrator {
  private proposeTool = new ProposeRouteRiskPurchaseTool();
  private executeTool = new ExecuteRouteRiskPurchaseTool();
  private proposeLiveRouteTool = new ProposeLiveRouteRiskPurchaseTool();
  public hook = new RouteGuardObservabilityHook();
  private integrityPolicy = new TransactionIntegrityPolicy();

  constructor(private client: Client) {}

  private context() {
    return {
      mode: AgentMode.AUTONOMOUS,
      // Both a non-blocking hook and a blocking policy participate in the lifecycle.
      hooks: [this.hook, this.integrityPolicy],
    };
  }

  async propose(input: {
    shipmentId: string;
    rationale: string;
    expectedBenefit: string;
    policyProfile: PolicyProfile;
  }): Promise<{ proposal: PurchaseProposal; decision: PolicyDecisionResult }> {
    // BaseTool.execute returns the tool result; for a non-transactional tool
    // (shouldSecondaryAction → false) that is the coreAction result, which
    // carries the exact proposal this call created. We use that id directly
    // rather than re-querying the store by timestamp (two proposals for one
    // shipment can share a millisecond and make a sort ambiguous).
    const created = (await this.proposeTool.execute(this.client, this.context(), {
      shipmentId: input.shipmentId,
      requestedSku: "premium-route-risk-v1",
      rationale: input.rationale,
      expectedBenefit: input.expectedBenefit,
      policyProfile: input.policyProfile,
    })) as { proposal: PurchaseProposal; decisionId: string } | undefined;

    const proposalId = created?.proposal?.id;
    const proposal = proposalId ? store.proposals.get(proposalId) : undefined;
    if (!proposal || !proposalId)
      throw new Error("Propose tool did not return a proposal.");
    const decision = store.decisions.get(proposalId)!;
    return { proposal, decision };
  }

  async execute(
    proposalId: string,
    executionMode: ExecutionMode,
  ): Promise<ExecuteResult> {
    return (await this.executeTool.execute(this.client, this.context(), {
      proposalId,
      executionMode,
    })) as ExecuteResult;
  }

  async proposeLiveRoute(
    routeId: LiveRouteId,
  ): Promise<{ proposal: PurchaseProposal; decision: PolicyDecisionResult }> {
    const created = (await this.proposeLiveRouteTool.execute(
      this.client,
      this.context(),
      { routeId, policyProfile: "standard" },
    )) as { proposal: PurchaseProposal; decisionId: string } | undefined;
    const proposalId = created?.proposal?.id;
    const proposal = proposalId ? store.proposals.get(proposalId) : undefined;
    const decision = proposalId ? store.decisions.get(proposalId) : undefined;
    if (!proposal || !decision)
      throw new Error("Live-route propose tool did not return a proposal.");
    return { proposal, decision };
  }

  recordApproval(proposalId: string): void {
    const p = store.proposals.get(proposalId);
    if (p && p.status === "APPROVAL_REQUIRED") p.status = "HUMAN_APPROVED";
  }

  lifecycleEvents() {
    return this.hook.events;
  }
}

export { getShipment };
