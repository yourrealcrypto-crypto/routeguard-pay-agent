import { AbstractPolicy } from "@hashgraph/hedera-agent-kit";
import { config } from "../config/index.js";

/**
 * TransactionIntegrityPolicy — a real Hedera Agent Kit AbstractPolicy.
 *
 * This is the strongest demonstration of the bounty thesis: it runs INSIDE the
 * Agent Kit tool lifecycle (post-core-action, after the transfer is built but
 * BEFORE it is submitted) and throws — halting execution — if the constructed
 * transaction does not match the server-resolved intent exactly.
 *
 * Because AbstractPolicy.shouldBlock* methods are wired by the base class into
 * the hook lifecycle, returning true here makes the kit throw and the payment
 * never leaves the building. The LLM cannot route around it.
 */
export class TransactionIntegrityPolicy extends AbstractPolicy {
  name = "RouteGuard Transaction Integrity Policy";
  description =
    "Blocks submission unless the built transfer matches the server-resolved vendor, exact amount, and memo on testnet.";
  relevantTools = ["execute_route_risk_purchase"];

  protected shouldBlockPostCoreAction(
    params: { coreActionResult?: unknown },
    _method: string,
  ): boolean {
    const plan = (params?.coreActionResult as { executionPlan?: ExecutionPlan })
      ?.executionPlan;
    if (!plan) return true; // no plan → refuse to proceed

    // Validate the plan against the SAME server-resolved source of truth the
    // execute tool used to build it. When a live vendor account is configured we
    // require an exact match; with no env configured (zero-config demo) the
    // placeholder is the canonical value on both sides, so the gate still proves
    // the model could not have substituted a different account.
    const expectedVendor =
      config.HEDERA_VENDOR_ACCOUNT_ID ?? "0.0.VENDOR_PLACEHOLDER";

    const vendorTransfer = plan.intendedTransfers.find(
      (t) => t.amountTinybars > 0,
    );

    const checks: boolean[] = [
      plan.network === "testnet",
      plan.intendedTransfers.length === 2,
      plan.vendorAccountId === expectedVendor,
      vendorTransfer?.account === expectedVendor,
      vendorTransfer?.amountTinybars === config.CATALOG_PRICE_TINYBARS,
      plan.amountTinybars === config.CATALOG_PRICE_TINYBARS,
      typeof plan.memo === "string" && plan.memo.startsWith("RG:"),
      plan.modelProvidedTransfers === false,
      plan.usesScheduleOrAllowanceOrContract === false,
      plan.proposalHash === plan.transactionPlanHash,
    ];

    const allPass = checks.every(Boolean);
    // shouldBlock semantics: return TRUE to block.
    return !allPass;
  }
}

export interface ExecutionPlan {
  network: string;
  vendorAccountId: string;
  amountTinybars: number;
  memo: string;
  intendedTransfers: Array<{ account: string; amountTinybars: number }>;
  modelProvidedTransfers: boolean;
  usesScheduleOrAllowanceOrContract: boolean;
  proposalHash: string;
  transactionPlanHash: string;
}
