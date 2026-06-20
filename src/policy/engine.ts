import {
  type PolicyCheck,
  type PolicyDecision,
  type PolicyDecisionResult,
  type PolicyProfile,
  type Shipment,
  type ServiceCatalogItem,
  sha256,
} from "../domain/index.js";
import { config } from "../config/index.js";
import { getActiveRiskPolicy } from "../risk/policy.js";

/**
 * The policy engine is pure, deterministic TypeScript. It runs with no LLM, no
 * network, and no UI. The LLM can propose; only this code decides. Every check
 * returns machine-readable evidence and a stable reason code.
 */

export interface PolicyConfig {
  policyVersion: "1.0";
  network: "testnet";
  allowedVendorIds: string[];
  allowedVendorAccountIds: string[];
  allowedServiceCategories: string[];
  allowedSkus: string[];
  maxPerPurchaseTinybars: number;
  autoApproveAtOrBelowTinybars: number;
  dailyBudgetTinybars: number;
  maxPurchasesPerShipment: number;
  liveExecutionEnabled: boolean;
}

export interface BudgetView {
  /** Tinybars already committed + reserved for the current UTC day. */
  spentTinybars: number;
}

export interface PolicyContext {
  shipment: Shipment;
  catalogItem: ServiceCatalogItem;
  /** The vendor account actually present in the proposal context (may be spoofed in demos). */
  proposedVendorAccountId: string;
  profile: PolicyProfile;
  amountTinybars: number;
  budget: BudgetView;
  /** Whether a human has approved THIS proposal already (checked at execute time). */
  humanApproved: boolean;
  /** True when we are at the execution step (approval gate must be satisfied). */
  atExecution: boolean;
  /** Existing purchase/redemption state for replay protection. */
  alreadyPurchasedForShipment: boolean;
  existingMemo: string | null;
  candidateMemo: string;
}

const VENDOR_ACCOUNT =
  config.HEDERA_VENDOR_ACCOUNT_ID ?? "0.0.VENDOR_PLACEHOLDER";

/** Base standard profile derived from validated config. */
export function baseConfig(): PolicyConfig {
  return {
    policyVersion: "1.0",
    network: "testnet",
    allowedVendorIds: [config.vendor.vendorId],
    allowedVendorAccountIds: [VENDOR_ACCOUNT],
    allowedServiceCategories: [config.vendor.serviceCategory],
    allowedSkus: [config.vendor.sku],
    maxPerPurchaseTinybars: config.MAX_PER_PURCHASE_TINYBARS,
    autoApproveAtOrBelowTinybars: config.AUTO_APPROVE_AT_OR_BELOW_TINYBARS,
    dailyBudgetTinybars: config.DAILY_BUDGET_TINYBARS,
    maxPurchasesPerShipment: 1,
    liveExecutionEnabled: config.liveHederaConfigured,
  };
}

/** Profiles tweak the base config to drive the sandbox scenarios deterministically. */
export function configForProfile(profile: PolicyProfile): PolicyConfig {
  const c = baseConfig();
  switch (profile) {
    case "strict":
      // Auto-approve threshold below the 0.05 HBAR catalog price → approval required.
      return { ...c, autoApproveAtOrBelowTinybars: 2_000_000 };
    case "budget_exhausted":
    case "blocked_vendor":
    case "standard":
    default:
      return c;
  }
}

function pass(
  policyId: string,
  name: string,
  reasonCode: string,
  publicMessage: string,
  evidence: Record<string, unknown> = {},
): PolicyCheck {
  return {
    policyId,
    name,
    outcome: "PASS",
    reasonCode,
    publicMessage,
    evidence,
  };
}
function block(
  policyId: string,
  name: string,
  reasonCode: string,
  publicMessage: string,
  evidence: Record<string, unknown> = {},
): PolicyCheck {
  return {
    policyId,
    name,
    outcome: "BLOCK",
    reasonCode,
    publicMessage,
    evidence,
  };
}
function requireApproval(
  policyId: string,
  name: string,
  reasonCode: string,
  publicMessage: string,
  evidence: Record<string, unknown> = {},
): PolicyCheck {
  return {
    policyId,
    name,
    outcome: "REQUIRE_APPROVAL",
    reasonCode,
    publicMessage,
    evidence,
  };
}

/* --------------------------- individual policies -------------------------- */

function allowedVendorPolicy(
  ctx: PolicyContext,
  cfg: PolicyConfig,
): PolicyCheck {
  const id = "allowed-vendor";
  const name = "Allowed Vendor";
  if (!cfg.allowedVendorIds.includes(ctx.catalogItem.vendorId)) {
    return block(id, name, "VENDOR_NOT_ALLOWED", "Vendor is not on the allowlist.", {
      vendorId: ctx.catalogItem.vendorId,
    });
  }
  if (
    ctx.proposedVendorAccountId !== ctx.catalogItem.vendorAccountId ||
    !cfg.allowedVendorAccountIds.includes(ctx.proposedVendorAccountId)
  ) {
    return block(
      id,
      name,
      "VENDOR_ACCOUNT_MISMATCH",
      "Proposed vendor account does not match the allowlisted catalog account.",
      {
        proposed: ctx.proposedVendorAccountId,
        expected: ctx.catalogItem.vendorAccountId,
      },
    );
  }
  return pass(id, name, "VENDOR_ALLOWED", "Vendor and account are allowlisted.", {
    vendorAccountId: ctx.proposedVendorAccountId,
  });
}

function serviceCatalogPolicy(
  ctx: PolicyContext,
  cfg: PolicyConfig,
): PolicyCheck {
  const id = "service-catalog";
  const name = "Service Catalog";
  const c = ctx.catalogItem;
  if (!c.active)
    return block(id, name, "SERVICE_INACTIVE", "Service SKU is inactive.", {
      sku: c.sku,
    });
  if (!cfg.allowedSkus.includes(c.sku))
    return block(id, name, "SKU_NOT_ALLOWED", "SKU is not allowed.", {
      sku: c.sku,
    });
  if (!cfg.allowedServiceCategories.includes(c.serviceCategory))
    return block(
      id,
      name,
      "CATEGORY_NOT_ALLOWED",
      "Service category is not allowed.",
      { category: c.serviceCategory },
    );
  if (c.network !== "testnet")
    return block(id, name, "WRONG_NETWORK", "Catalog network is not testnet.", {
      network: c.network,
    });
  if (c.currency !== "HBAR")
    return block(id, name, "WRONG_CURRENCY", "Catalog currency is not HBAR.", {
      currency: c.currency,
    });
  return pass(
    id,
    name,
    "SERVICE_OK",
    "Service, category, network, and currency are valid.",
    { sku: c.sku, priceTinybars: c.priceTinybars },
  );
}

function shipmentContextPolicy(ctx: PolicyContext): PolicyCheck {
  const id = "shipment-context";
  const name = "Shipment Context";
  const s = ctx.shipment;
  if (ctx.alreadyPurchasedForShipment)
    return block(
      id,
      name,
      "ALREADY_PURCHASED",
      "A premium report already exists for this shipment.",
      { shipmentId: s.id },
    );

  // Deterministic NEED conditions. The LLM rationale alone is never sufficient.
  const reasons: string[] = [];
  if (s.cargoValueEur >= 50_000) reasons.push("cargo_value>=50000");
  if (
    s.freeAssessmentConfidence <
    getActiveRiskPolicy().confidence.minimumUsableConfidence
  )
    reasons.push("low_free_confidence");
  if (s.riskSignals.length > 0) reasons.push("risk_signals_present");
  if (
    s.cargoType === "temperature_controlled" ||
    s.cargoType === "fragile" ||
    s.cargoType === "high_value"
  )
    reasons.push(`sensitive_cargo:${s.cargoType}`);

  if (reasons.length === 0)
    return block(
      id,
      name,
      "SHIPMENT_INELIGIBLE",
      "No deterministic need condition is met; a premium report is not warranted.",
      { shipmentId: s.id },
    );

  return pass(
    id,
    name,
    "SHIPMENT_ELIGIBLE",
    "Shipment meets at least one premium-need condition.",
    { needConditions: reasons },
  );
}

function perPurchaseCapPolicy(
  ctx: PolicyContext,
  cfg: PolicyConfig,
): PolicyCheck {
  const id = "per-purchase-cap";
  const name = "Per-Purchase Cap";
  if (ctx.amountTinybars > cfg.maxPerPurchaseTinybars)
    return block(
      id,
      name,
      "PER_PURCHASE_CAP",
      "Amount exceeds the per-purchase cap. Approval cannot override a hard cap.",
      {
        amountTinybars: ctx.amountTinybars,
        capTinybars: cfg.maxPerPurchaseTinybars,
      },
    );
  return pass(
    id,
    name,
    "WITHIN_CAP",
    "Amount is within the per-purchase cap.",
    {
      amountTinybars: ctx.amountTinybars,
      capTinybars: cfg.maxPerPurchaseTinybars,
    },
  );
}

function approvalPolicy(ctx: PolicyContext, cfg: PolicyConfig): PolicyCheck {
  const id = "approval";
  const name = "Approval Threshold";
  const needsApproval =
    ctx.amountTinybars > cfg.autoApproveAtOrBelowTinybars;
  if (!needsApproval)
    return pass(
      id,
      name,
      "AUTO_APPROVE",
      "Amount is at or below the auto-approval threshold.",
      { thresholdTinybars: cfg.autoApproveAtOrBelowTinybars },
    );
  // Needs approval.
  if (ctx.atExecution && !ctx.humanApproved)
    return block(
      id,
      name,
      "APPROVAL_REQUIRED",
      "Human approval is required before execution and has not been recorded.",
      { thresholdTinybars: cfg.autoApproveAtOrBelowTinybars },
    );
  if (ctx.humanApproved)
    return pass(
      id,
      name,
      "HUMAN_APPROVED",
      "Human approval recorded for this proposal.",
      {},
    );
  return requireApproval(
    id,
    name,
    "APPROVAL_REQUIRED",
    "Amount exceeds the auto-approval threshold; human approval required.",
    { thresholdTinybars: cfg.autoApproveAtOrBelowTinybars },
  );
}

function dailyBudgetPolicy(ctx: PolicyContext, cfg: PolicyConfig): PolicyCheck {
  const id = "daily-budget";
  const name = "Daily Budget";
  const projected = ctx.budget.spentTinybars + ctx.amountTinybars;
  if (projected > cfg.dailyBudgetTinybars)
    return block(
      id,
      name,
      "DAILY_BUDGET",
      "Daily budget would be exceeded by this purchase.",
      {
        spentTinybars: ctx.budget.spentTinybars,
        amountTinybars: ctx.amountTinybars,
        dailyBudgetTinybars: cfg.dailyBudgetTinybars,
      },
    );
  return pass(id, name, "BUDGET_OK", "Within the daily budget.", {
    spentTinybars: ctx.budget.spentTinybars,
    dailyBudgetTinybars: cfg.dailyBudgetTinybars,
  });
}

function replayProtectionPolicy(ctx: PolicyContext): PolicyCheck {
  const id = "replay-protection";
  const name = "Replay Protection";
  if (ctx.existingMemo && ctx.existingMemo === ctx.candidateMemo)
    return block(
      id,
      name,
      "REPLAY",
      "A purchase with this memo already exists; returning the existing result.",
      { memo: ctx.candidateMemo },
    );
  return pass(id, name, "NO_REPLAY", "No duplicate purchase detected.", {
    memo: ctx.candidateMemo,
  });
}

/* ----------------------------- aggregation -------------------------------- */

export function aggregate(checks: PolicyCheck[]): PolicyDecision {
  if (checks.some((c) => c.outcome === "BLOCK")) return "BLOCK";
  if (checks.some((c) => c.outcome === "REQUIRE_APPROVAL"))
    return "REQUIRE_APPROVAL";
  return "ALLOW_AUTONOMOUS";
}

/**
 * Evaluate all proposal-time policies (everything except the on-transaction
 * integrity check, which runs inside the execute tool's post-core-action stage).
 */
export function evaluatePolicies(
  ctx: PolicyContext,
  cfg: PolicyConfig,
): PolicyDecisionResult {
  const effectiveCtx = applyProfileOverrides(ctx);
  const checks: PolicyCheck[] = [
    allowedVendorPolicy(effectiveCtx, cfg),
    serviceCatalogPolicy(effectiveCtx, cfg),
    shipmentContextPolicy(effectiveCtx),
    perPurchaseCapPolicy(effectiveCtx, cfg),
    approvalPolicy(effectiveCtx, cfg),
    dailyBudgetPolicy(effectiveCtx, cfg),
    replayProtectionPolicy(effectiveCtx),
  ];
  const decision = aggregate(checks);
  const evaluatedAt = new Date().toISOString();
  const canonicalHash = sha256({
    decision,
    checks: checks.map((c) => ({
      policyId: c.policyId,
      outcome: c.outcome,
      reasonCode: c.reasonCode,
    })),
    policyVersion: "1.0",
  });
  return {
    decision,
    checks,
    policyVersion: "1.0",
    canonicalHash,
    evaluatedAt,
  };
}

/**
 * Sandbox profiles that change the *world* (not the rules) are applied here so
 * the policy functions themselves stay honest.
 *  - blocked_vendor: substitute a non-allowlisted vendor account into context.
 *  - budget_exhausted: report the daily budget as already fully spent.
 */
function applyProfileOverrides(ctx: PolicyContext): PolicyContext {
  if (ctx.profile === "blocked_vendor") {
    return { ...ctx, proposedVendorAccountId: "0.0.000000" };
  }
  if (ctx.profile === "budget_exhausted") {
    return {
      ...ctx,
      budget: { spentTinybars: config.DAILY_BUDGET_TINYBARS },
    };
  }
  return ctx;
}
