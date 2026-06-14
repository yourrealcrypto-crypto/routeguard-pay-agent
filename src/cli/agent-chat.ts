import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { AgentService } from "../server/agent-service.js";
import { SHIPMENTS } from "../store/fixtures.js";
import { store } from "../store/store.js";
import { tinybarsToHbarDisplay } from "../domain/index.js";

/**
 * A minimal natural-language CLI. Pick a shipment; the agent assesses it,
 * proposes (or declines), and — if policy allows — buys the premium report in
 * simulation mode. Approval is requested interactively when required.
 */
async function main() {
  const rl = readline.createInterface({ input, output });
  console.log("\n  RouteGuard agent chat (simulation mode)\n");
  console.log("  Shipments:");
  for (const s of SHIPMENTS)
    console.log(
      `    ${s.id}  ${s.origin.city}→${s.destination.city}  ${s.cargoType}  €${s.cargoValueEur.toLocaleString("en-US")}`,
    );
  console.log("");

  const id = (await rl.question("  Shipment id (default RG-1001): ")).trim() || "RG-1001";
  store.reset();
  const svc = new AgentService({} as never);
  const r = await svc.run({
    shipmentId: id,
    scenarioId: "auto-approved",
    executionMode: "SIMULATION",
  });

  console.log(`\n  Agent decision: ${r.kind}`);
  if (r.kind === "NO_PURCHASE") console.log(`  ${r.explanation}`);
  if (r.kind === "BLOCKED") {
    const b = r.decision.checks.find((c) => c.outcome === "BLOCK");
    console.log(`  Blocked by ${b?.name}: ${b?.publicMessage}`);
  }
  if (r.kind === "APPROVAL_REQUIRED") {
    const ans = (await rl.question("  Approve this purchase? (y/N): ")).trim().toLowerCase();
    if (ans === "y") {
      const after = await svc.approveAndExecute(r.proposalId, "SIMULATION");
      if (after.kind === "COMPLETED") printCompleted(after);
    } else {
      console.log("  Not approved. No payment made.");
    }
  }
  if (r.kind === "COMPLETED") printCompleted(r);

  rl.close();
}

function printCompleted(r: {
  payment: { amountTinybars: number; transactionId: string };
  report: { riskScore: number; riskBand: string; recommendedControls: string[] };
}) {
  console.log(`  Paid ${tinybarsToHbarDisplay(r.payment.amountTinybars)} (tx ${r.payment.transactionId})`);
  console.log(`  Premium risk: ${r.report.riskScore}/100 (${r.report.riskBand})`);
  console.log(`  Controls:`);
  for (const c of r.report.recommendedControls) console.log(`    • ${c}`);
  console.log("");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
