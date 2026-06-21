import { randomUUID } from "node:crypto";
import { BaseTool } from "@hashgraph/hedera-agent-kit";
import type { Client } from "@hiero-ledger/sdk";
import { z } from "zod";
import { config } from "../config/index.js";
import {
  LiveRouteId,
  RGError,
  RouteGuardError,
  type PolicyProfile,
  type PurchaseProposal,
  type ServiceCatalogItem,
} from "../domain/index.js";
import { assessLiveRouteRisk } from "../live-routes/service.js";
import {
  configForProfile,
  evaluateLiveRoutePolicies,
  type LiveRoutePolicyContext,
} from "../policy/engine.js";
import { store } from "../store/store.js";

const ProposeLiveRouteParams = z.object({
  routeId: LiveRouteId,
  policyProfile: z
    .enum(["standard", "strict", "budget_exhausted", "blocked_vendor"])
    .default("standard"),
});
type ProposeLiveRouteParamsT = z.infer<typeof ProposeLiveRouteParams>;

interface ProposeLiveRouteNormalised extends ProposeLiveRouteParamsT {
  catalogItem: ServiceCatalogItem;
}

function serverCatalogItem(): ServiceCatalogItem {
  return {
    vendorId: config.vendor.vendorId,
    vendorAccountId:
      config.HEDERA_VENDOR_ACCOUNT_ID ?? "0.0.VENDOR_PLACEHOLDER",
    serviceCategory: config.vendor.serviceCategory,
    sku: config.vendor.sku,
    version: config.vendor.version,
    priceTinybars: config.CATALOG_PRICE_TINYBARS,
    currency: "HBAR",
    network: "testnet",
    active: true,
  };
}

export const PROPOSE_LIVE_ROUTE_TOOL =
  "propose_live_route_risk_purchase";

export class ProposeLiveRouteRiskPurchaseTool extends BaseTool<
  ProposeLiveRouteParamsT,
  ProposeLiveRouteNormalised
> {
  method = PROPOSE_LIVE_ROUTE_TOOL;
  name = "Propose Live RouteRisk Purchase";
  description = `Propose the allowlisted Premium RouteRisk API for a known live freight route. The route definition, weather evidence, vendor, account, SKU, amount, network, and approval outcome are resolved and validated by the server.`;
  parameters = ProposeLiveRouteParams;

  async normalizeParams(
    params: ProposeLiveRouteParamsT,
    _context: unknown,
    _client: Client,
  ): Promise<ProposeLiveRouteNormalised> {
    return { ...params, catalogItem: serverCatalogItem() };
  }

  async coreAction(
    normalised: ProposeLiveRouteNormalised,
    _context: unknown,
    _client: Client,
  ): Promise<{ proposal: PurchaseProposal; decisionId: string }> {
    const assessment = await assessLiveRouteRisk(normalised.routeId);
    const amountTinybars = normalised.catalogItem.priceTinybars;
    const profile = normalised.policyProfile as PolicyProfile;
    const context: LiveRoutePolicyContext = {
      assessment,
      catalogItem: normalised.catalogItem,
      proposedVendorAccountId: normalised.catalogItem.vendorAccountId,
      profile,
      amountTinybars,
      budget: { spentTinybars: store.spentTinybarsToday() },
      humanApproved: false,
      atExecution: false,
      alreadyPurchasedForShipment: store.alreadyPurchasedForShipment(
        assessment.route.id,
      ),
      existingMemo: null,
      candidateMemo: "RG:pending",
    };
    const decision = evaluateLiveRoutePolicies(
      context,
      configForProfile(profile),
    );
    const proposal: PurchaseProposal = {
      id: randomUUID(),
      shipmentId: assessment.route.id,
      liveRouteId: assessment.route.id,
      requestedSku: "premium-route-risk-v1",
      rationale:
        "Deterministic live-route evidence recommends deeper checkpoint and cargo analysis.",
      expectedBenefit:
        "Checkpoint-specific mitigation and operational recommendations.",
      status:
        decision.decision === "BLOCK"
          ? "BLOCKED"
          : decision.decision === "REQUIRE_APPROVAL"
            ? "APPROVAL_REQUIRED"
            : "AUTO_APPROVED",
      policyProfile: profile,
      createdAt: new Date().toISOString(),
    };
    store.proposals.set(proposal.id, proposal);
    store.decisions.set(proposal.id, decision);
    store.purchaseTargets.set(proposal.id, {
      type: "LIVE_ROUTE",
      id: assessment.route.id,
      freeAssessment: assessment,
    });
    return { proposal, decisionId: proposal.id };
  }

  async shouldSecondaryAction(): Promise<boolean> {
    return false;
  }

  async secondaryAction(): Promise<void> {
    // Proposal-only tool. Payment remains in the existing execute tool.
  }

  async handleError(error: unknown): Promise<never> {
    if (error instanceof RouteGuardError) throw error;
    throw new RouteGuardError(
      RGError.MODEL_OUTPUT_INVALID,
      `Live-route proposal failed: ${String(error)}`,
    );
  }
}
