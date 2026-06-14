import {
  Client,
  AccountId,
  PrivateKey,
  type PrivateKey as PrivateKeyType,
} from "@hiero-ledger/sdk";
import { config } from "../config/index.js";

/**
 * Testnet-only Hedera client. Private keys are read from env on the server and
 * never logged, persisted, or returned to the browser.
 */

let cachedClient: Client | null = null;

/** Accepts both ECDSA and ED25519, hex or DER, via explicit fallbacks. */
export function parsePrivateKey(raw: string): PrivateKeyType {
  const attempts: Array<() => PrivateKeyType> = [
    () => PrivateKey.fromStringECDSA(raw),
    () => PrivateKey.fromStringED25519(raw),
    () => PrivateKey.fromStringDer(raw),
  ];
  let lastErr: unknown;
  for (const attempt of attempts) {
    try {
      return attempt();
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(
    `Could not parse HEDERA_OPERATOR_KEY as ECDSA, ED25519, or DER: ${String(
      lastErr,
    )}`,
  );
}

export function getClient(): Client {
  if (cachedClient) return cachedClient;
  if (config.HEDERA_NETWORK !== "testnet") {
    throw new Error("RouteGuard supports Hedera testnet only.");
  }
  if (!config.HEDERA_OPERATOR_ID || !config.HEDERA_OPERATOR_KEY) {
    throw new Error(
      "Hedera operator credentials are not configured (HEDERA_OPERATOR_ID / HEDERA_OPERATOR_KEY).",
    );
  }
  const client = Client.forTestnet().setOperator(
    AccountId.fromString(config.HEDERA_OPERATOR_ID),
    parsePrivateKey(config.HEDERA_OPERATOR_KEY),
  );
  cachedClient = client;
  return client;
}

/**
 * Convert SDK transaction-id format `0.0.123@1700000000.123456789`
 * to mirror REST format `0.0.123-1700000000-123456789`.
 */
export function txIdToMirrorFormat(txId: string): string {
  const [acct, ts] = txId.split("@");
  if (!acct || !ts) return txId;
  return `${acct}-${ts.replace(".", "-")}`;
}

export function explorerUrlForTx(txId: string): string {
  return `https://hashscan.io/testnet/transaction/${txIdToMirrorFormat(txId)}`;
}

export function explorerUrlForTopic(topicId: string): string {
  return `https://hashscan.io/testnet/topic/${topicId}`;
}

export function maskAccount(id: string): string {
  // 0.0.123456 → 0.0.12••56
  const parts = id.split(".");
  const last = parts[parts.length - 1] ?? id;
  if (last.length <= 4) return id;
  parts[parts.length - 1] =
    last.slice(0, 2) + "••" + last.slice(-2);
  return parts.join(".");
}
