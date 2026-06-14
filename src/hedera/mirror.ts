import { config } from "../config/index.js";
import { txIdToMirrorFormat } from "./client.js";

/**
 * Independent payment verification. The vendor side must NOT trust a buyer's
 * claim that payment happened — it queries the Hedera testnet mirror node and
 * validates payer, recipient, exact amount, memo, and success itself.
 */

export interface MirrorVerifyInput {
  transactionId: string;
  expectedPayerAccountId: string;
  expectedVendorAccountId: string;
  expectedAmountTinybars: number;
  expectedMemo: string;
}

export interface MirrorVerifyResult {
  ok: boolean;
  reasonCode?: string;
  consensusTimestamp?: string;
  detail?: Record<string, unknown>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function decodeMemo(b64?: string | null): string {
  if (!b64) return "";
  try {
    return Buffer.from(b64, "base64").toString("utf8");
  } catch {
    return "";
  }
}

/**
 * Poll the mirror node with bounded exponential backoff (ingestion lag).
 * Returns as soon as a SUCCESS CRYPTOTRANSFER matching all constraints is found.
 */
export async function verifyPaymentOnMirror(
  input: MirrorVerifyInput,
  opts: { attempts?: number; baseDelayMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<MirrorVerifyResult> {
  const attempts = opts.attempts ?? 6;
  const baseDelay = opts.baseDelayMs ?? 1500;
  const doFetch = opts.fetchImpl ?? fetch;
  const mirrorId = txIdToMirrorFormat(input.transactionId);
  const url = `${config.HEDERA_MIRROR_BASE_URL}/api/v1/transactions/${mirrorId}`;

  for (let i = 0; i < attempts; i++) {
    try {
      const res = await doFetch(url);
      if (res.ok) {
        const body = (await res.json()) as MirrorTransactionsResponse;
        const verdict = evaluateMirrorBody(body, input);
        if (verdict.ok || verdict.reasonCode !== "NOT_FOUND") return verdict;
      }
    } catch {
      // network hiccup — fall through to backoff
    }
    if (i < attempts - 1) await sleep(baseDelay * Math.pow(1.6, i));
  }
  return { ok: false, reasonCode: "RG_MIRROR_TIMEOUT" };
}

interface MirrorTransfer {
  account: string;
  amount: number;
}
interface MirrorTransaction {
  name?: string;
  result?: string;
  consensus_timestamp?: string;
  memo_base64?: string | null;
  transfers?: MirrorTransfer[];
}
interface MirrorTransactionsResponse {
  transactions?: MirrorTransaction[];
}

/** Pure validation of a mirror response — unit-testable without the network. */
export function evaluateMirrorBody(
  body: MirrorTransactionsResponse,
  input: MirrorVerifyInput,
): MirrorVerifyResult {
  const tx = body.transactions?.[0];
  if (!tx) return { ok: false, reasonCode: "NOT_FOUND" };

  if (tx.result !== "SUCCESS")
    return {
      ok: false,
      reasonCode: "RG_VENDOR_PAYMENT_INVALID",
      detail: { result: tx.result },
    };
  if (tx.name !== "CRYPTOTRANSFER")
    return {
      ok: false,
      reasonCode: "RG_VENDOR_PAYMENT_INVALID",
      detail: { name: tx.name },
    };

  const transfers = tx.transfers ?? [];
  // The vendor must receive exactly the expected positive amount.
  const credit = transfers.find(
    (t) =>
      t.account === input.expectedVendorAccountId &&
      t.amount === input.expectedAmountTinybars,
  );
  if (!credit)
    return {
      ok: false,
      reasonCode: "RG_VENDOR_PAYMENT_INVALID",
      detail: { reason: "vendor_credit_mismatch", transfers },
    };

  // The expected payer must appear as a debit (negative amount).
  const debit = transfers.find(
    (t) => t.account === input.expectedPayerAccountId && t.amount < 0,
  );
  if (!debit)
    return {
      ok: false,
      reasonCode: "RG_VENDOR_PAYMENT_INVALID",
      detail: { reason: "payer_debit_missing" },
    };

  const memo = decodeMemo(tx.memo_base64);
  if (memo !== input.expectedMemo)
    return {
      ok: false,
      reasonCode: "RG_VENDOR_PAYMENT_INVALID",
      detail: { reason: "memo_mismatch", got: memo, want: input.expectedMemo },
    };

  return {
    ok: true,
    consensusTimestamp: tx.consensus_timestamp,
    detail: { verified: true },
  };
}
