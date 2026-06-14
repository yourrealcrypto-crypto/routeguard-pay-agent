import { z } from "zod";
import { BaseTool } from "@hashgraph/hedera-agent-kit";
import type { Client } from "@hiero-ledger/sdk";
import { randomUUID } from "node:crypto";
import { config } from "../config/index.js";
import { getShipment } from "../store/fixtures.js";
import { store } from "../store/store.js";
import {
  configForProfile,
  evaluatePolicies,
  type PolicyContext,
} from "../policy/engine.js";
import {
  type ServiceCatalogItem,
  type PurchaseProposal,
  type PolicyProfile,
  RouteGuardError,
  RGError,
} from "../domain/index.js";

/**
 * propose_route_risk_purchase — a non-transaction BaseTool.
 *
 * The model may call this with a shipment id, the single allowed SKU, and a
 * rationale. It may NOT supply a price, vendor account, network, or approval.
 * The tool loads trusted server data, evaluates all policies, persists the
 * proposal + decision, and returns a structured result.
 */

const ProposeParams = z.object({
  shipmentId: z.string(),
  requestedSku: z.literal("premium-route-risk-v1"),
  rationale: z.string().min(20).max(800),
  expectedBenefit: z.string().min(10).max(500),
  policyProfile: z
    .enum(["standard", "strict", "budget_exhausted", "blocked_vendor"])
    .default("standard"),
});
type ProposeParamsT = z.infer<typeof ProposeParams>;

interface ProposeNormalised extends ProposeParamsT {
  catalogItem: ServiceCatalogItem;
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

export const PROPOSE_TOOL = "propose_route_risk_purchase";

export class ProposeRouteRiskPurchaseTool extends BaseTool<
  ProposeParamsT,
  ProposeNormalised
> {
  method = PROPOSE_TOOL;
  name = "Propose RouteRisk Purchase";
  description = `Propose buying the allowlisted Premium RouteRisk report for a shipment.
Parameters:
- shipmentId (string, required): the shipment to assess (e.g. RG-1001).
- requestedSku (string, required): must be exactly "premium-route-risk-v1".
- rationale (string, required): factual reason a premium report helps this shipment.
- expectedBenefit (string, required): what the buyer gains operationally.
Never provide price, vendor account, network, or approval — those are server-controlled.
This tool does NOT pay. It returns a policy decision (ALLOW_AUTONOMOUS, REQUIRE_APPROVAL, or BLOCK).`;
  parameters = ProposeParams;

  async normalizeParams(
    params: ProposeParamsT,
    _context: unknown,
    _client: Client,
  ): Promise<ProposeNormalised> {
    const shipment = getShipment(params.shipmentId);
    if (!shipment)
      throw new RouteGuardError(
        RGError.POLICY_SHIPMENT_INELIGIBLE,
        `Unknown shipment ${params.shipmentId}.`,
      );
    return {
      ...params,
      rationale: params.rationale.trim(),
      expectedBenefit: params.expectedBenefit.trim(),
      catalogItem: serverCatalogItem(),
    };
  }

  async coreAction(
    n: ProposeNormalised,
    _context: unknown,
    _client: Client,
  ): Promise<{ proposal: PurchaseProposal; decisionId: string }> {
    const shipment = getShipment(n.shipmentId)!;
    const cfg = configForProfile(n.policyProfile as PolicyProfile);
    const amountTinybars = n.catalogItem.priceTinybars;
    const candidateMemo = `RG:pending`;

    const ctx: PolicyContext = {
      shipment,
      catalogItem: n.catalogItem,
      proposedVendorAccountId: n.catalogItem.vendorAccountId,
      profile: n.policyProfile as PolicyProfile,
      amountTinybars,
      budget: { spentTinybars: store.spentTinybarsToday() },
      humanApproved: false,
      atExecution: false,
      alreadyPurchasedForShipment: store.alreadyPurchasedForShipment(
        shipment.id,
      ),
      existingMemo: null,
      candidateMemo,
    };

    const decision = evaluatePolicies(ctx, cfg);

    const proposal: PurchaseProposal = {
      id: randomUUID(),
      shipmentId: shipment.id,
      requestedSku: "premium-route-risk-v1",
      rationale: n.rationale,
      expectedBenefit: n.expectedBenefit,
      status:
        decision.decision === "BLOCK"
          ? "BLOCKED"
          : decision.decision === "REQUIRE_APPROVAL"
            ? "APPROVAL_REQUIRED"
            : "AUTO_APPROVED",
      policyProfile: n.policyProfile as PolicyProfile,
      createdAt: new Date().toISOString(),
    };

    store.proposals.set(proposal.id, proposal);
    store.decisions.set(proposal.id, decision);

    return { proposal, decisionId: proposal.id };
  }

  // This tool never signs or submits anything.
  async shouldSecondaryAction(): Promise<boolean> {
    return false;
  }

  async secondaryAction(): Promise<void> {
    /* no-op: proposal is non-transactional */
  }

  async handleError(error: unknown): Promise<never> {
    if (error instanceof RouteGuardError) throw error;
    throw new RouteGuardError(
      RGError.MODEL_OUTPUT_INVALID,
      `Proposal failed: ${String(error)}`,
    );
  }
}
