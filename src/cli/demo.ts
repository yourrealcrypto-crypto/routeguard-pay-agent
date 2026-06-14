import { AgentService } from "../server/agent-service.js";
import { SCENARIOS } from "../store/fixtures.js";
import { tinybarsToHbarDisplay } from "../domain/index.js";
import { store } from "../store/store.js";

/**
 * Headless end-to-end demo. Runs with zero configuration (simulation mode,
 * heuristic LLM) so anyone can `npm run demo` immediately after install and see
 * every policy path execute. This is the fastest proof the vertical slice works.
 */

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

function outcomeColor(kind: string): string {
  if (kind === "COMPLETED") return C.green(kind);
  if (kind === "BLOCKED" || kind === "FAILED") return C.red(kind);
  if (kind === "APPROVAL_REQUIRED") return C.yellow(kind);
  return C.cyan(kind);
}

async function main() {
  console.log(C.bold("\n  RouteGuard Pay Agent — scenario demo"));
  console.log(C.dim("  The LLM proposes. Policy decides. Hedera proves.\n"));
  console.log(C.dim("  Mode: SIMULATION · LLM: heuristic fallback\n"));

  const svc = new AgentService({} as never);

  for (const scenario of SCENARIOS) {
    store.reset();
    const result = await svc.run({
      shipmentId: scenario.shipmentId,
      scenarioId: scenario.id,
      executionMode: "SIMULATION",
    });

    console.log(`  ${C.bold(scenario.label)} ${C.dim(`(${scenario.shipmentId})`)}`);
    console.log(`    expected: ${C.dim(scenario.expectation)}`);
    console.log(`    result:   ${outcomeColor(result.kind)}`);

    if (result.kind === "BLOCKED") {
      const blocking = result.decision.checks.find((c) => c.outcome === "BLOCK");
      console.log(`    policy:   ${C.red(blocking?.name ?? "?")} — ${blocking?.publicMessage}`);
    }

    if (result.kind === "APPROVAL_REQUIRED") {
      console.log(`    ${C.yellow("→ approval gate hit; simulating human approval…")}`);
      const after = await svc.approveAndExecute(result.proposalId, "SIMULATION");
      console.log(`    after approval: ${outcomeColor(after.kind)}`);
      if (after.kind === "COMPLETED")
        printCompleted(after.payment, after.report.riskScore, after.report.riskBand, after.report.reportHash);
    }

    if (result.kind === "COMPLETED") {
      printCompleted(result.payment, result.report.riskScore, result.report.riskBand, result.report.reportHash);
    }

    if (result.kind === "NO_PURCHASE") {
      console.log(`    ${C.dim(result.explanation)}`);
    }

    if (result.kind === "FAILED") {
      console.log(`    ${C.red(result.errorCode)} — ${result.message}`);
    }
    console.log("");
  }

  console.log(C.green("  ✓ demo complete — every policy path exercised.\n"));
}

function printCompleted(
  payment: { amountTinybars: number; vendorAccountId: string; transactionId: string; mode: string },
  riskScore: number,
  riskBand: string,
  reportHash: string,
) {
  console.log(`    paid:     ${tinybarsToHbarDisplay(payment.amountTinybars)} → ${payment.vendorAccountId} ${C.dim(`(${payment.mode})`)}`);
  console.log(`    tx:       ${C.dim(payment.transactionId)}`);
  console.log(`    report:   risk ${riskScore}/100 (${riskBand}) · hash ${C.dim(reportHash.slice(0, 16) + "…")}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
