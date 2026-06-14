import { TopicCreateTransaction } from "@hiero-ledger/sdk";
import { getClient, explorerUrlForTopic } from "../src/hedera/client.js";
import { config } from "../src/config/index.js";

/**
 * Creates one HCS topic for audit anchoring. Run once, then put the printed id
 * into HCS_AUDIT_TOPIC_ID. Do NOT create a topic on every app start.
 */
async function main() {
  if (!config.HEDERA_OPERATOR_ID || !config.HEDERA_OPERATOR_KEY) {
    console.error(
      "Set HEDERA_OPERATOR_ID and HEDERA_OPERATOR_KEY in .env first.",
    );
    process.exit(1);
  }
  const client = getClient();
  console.log("Creating HCS audit topic on testnet…");
  const tx = await new TopicCreateTransaction()
    .setTopicMemo("RouteGuard Pay Agent — audit trail v1")
    .execute(client);
  const receipt = await tx.getReceipt(client);
  const topicId = receipt.topicId?.toString();
  if (!topicId) {
    console.error("No topic id in receipt.");
    process.exit(1);
  }
  console.log("\n  ✓ HCS topic created");
  console.log(`  topic id : ${topicId}`);
  console.log(`  explorer : ${explorerUrlForTopic(topicId)}`);
  console.log(`\n  Add to your .env:`);
  console.log(`  HCS_AUDIT_TOPIC_ID=${topicId}\n`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
