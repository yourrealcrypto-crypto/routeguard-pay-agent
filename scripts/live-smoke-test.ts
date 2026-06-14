import { AgentService } from "../src/server/agent-service.js";
import { getClient } from "../src/hedera/client.js";
import { config } from "../src/config/index.js";
import { store } from "../src/store/store.js";

/**
 * MANUAL live testnet smoke test. Excluded from CI. Performs ONE capped real
 * testnet payment through the full policy → pay → mirror-verify → unlock → HCS
 * path, then prints the proofs. Requires live env to be configured.
 *
 *   npm run smoke:testnet
 */
async function main() {
  if (!config.liveHederaConfigured) {
    console.error(
      "Live testnet not configured. Set LIVE_TESTNET_PAYMENTS_ENABLED=true plus operator + vendor accounts.",
    );
    process.exit(1);
  }
  console.log("Live testnet smoke test — one real 0.05 HBAR payment.\n");
  store.reset();
  const svc = new AgentService(getClient());

  const r = await svc.run({
    shipmentId: "RG-1001",
    scenarioId: "auto-approved",
    executionMode: "AUTONOMOUS_TESTNET",
  });

  console.log("  result:", r.kind);
  if (r.kind === "COMPLETED") {
    console.log("  tx id        :", r.payment.transactionId);
    console.log("  explorer     :", r.payment.explorerUrl);
    console.log("  amount       :", r.payment.amountTinybars, "tinybars");
    console.log("  memo         :", r.payment.memo);
    console.log("  report hash  :", r.report.reportHash);
    for (const a of r.auditTrail) {
      console.log(
        `  audit ${a.eventType}: ${a.hcsStatus}` +
          (a.hcsSequenceNumber ? ` seq#${a.hcsSequenceNumber}` : ""),
      );
    }
    console.log("\n  ✓ live smoke test complete.\n");
  } else if (r.kind === "FAILED") {
    console.error("  FAILED:", r.errorCode, r.message);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
