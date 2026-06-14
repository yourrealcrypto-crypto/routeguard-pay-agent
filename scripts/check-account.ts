import { AccountBalanceQuery, AccountId } from "@hiero-ledger/sdk";
import { getClient } from "../src/hedera/client.js";
import { config } from "../src/config/index.js";

/** Quick readiness check: operator balance + which features are live. */
async function main() {
  console.log("RouteGuard config check\n");
  console.log(`  network              : ${config.HEDERA_NETWORK}`);
  console.log(`  operator id          : ${config.HEDERA_OPERATOR_ID ?? "(unset)"}`);
  console.log(`  vendor account       : ${config.HEDERA_VENDOR_ACCOUNT_ID ?? "(unset)"}`);
  console.log(`  HCS topic            : ${config.HCS_AUDIT_TOPIC_ID ?? "(unset)"}`);
  console.log(`  live payments        : ${config.liveHederaConfigured ? "ENABLED" : "disabled"}`);
  console.log(`  HCS configured       : ${config.hcsConfigured ? "yes" : "no"}`);
  console.log(`  LLM                  : ${config.llmConfigured ? config.LLM_MODEL : "heuristic fallback"}`);

  if (!config.HEDERA_OPERATOR_ID || !config.HEDERA_OPERATOR_KEY) {
    console.log("\n  No operator credentials — running in simulation only. That's fine for the demo.\n");
    return;
  }

  try {
    const client = getClient();
    const balance = await new AccountBalanceQuery()
      .setAccountId(AccountId.fromString(config.HEDERA_OPERATOR_ID))
      .execute(client);
    console.log(`\n  operator balance     : ${balance.hbars.toString()}`);
    console.log("");
  } catch (e) {
    console.error("\n  Could not query balance:", String(e), "\n");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
