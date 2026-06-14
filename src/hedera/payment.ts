import {
  TransferTransaction,
  Hbar,
  HbarUnit,
  AccountId,
} from "@hiero-ledger/sdk";
import { config } from "../config/index.js";
import { getClient, explorerUrlForTx } from "./client.js";
import {
  type PaymentProof,
  RouteGuardError,
  RGError,
} from "../domain/index.js";

export type ExecutionMode = "SIMULATION" | "AUTONOMOUS_TESTNET";

export interface PaymentRequest {
  vendorAccountId: string;
  amountTinybars: number;
  memo: string;
  mode: ExecutionMode;
}

/**
 * Builds and (optionally) submits the exact HBAR transfer. In SIMULATION mode no
 * on-chain action occurs and a deterministic synthetic transaction id is returned,
 * clearly labelled. In AUTONOMOUS_TESTNET mode the server operator signs and
 * submits a capped testnet transfer, then confirms SUCCESS via the receipt.
 */
export async function executePayment(
  req: PaymentRequest,
): Promise<PaymentProof> {
  if (req.mode === "SIMULATION") {
    // Unique synthetic id: whole-second consensus part + nanosecond entropy so
    // two simulated payments never collide (mirrors real tx-id uniqueness).
    const seconds = Math.floor(Date.now() / 1000);
    const nanos = String(
      (process.hrtime.bigint() % 1_000_000_000n).valueOf(),
    ).padStart(9, "0");
    const fakeTs = `${seconds}.${nanos}`;
    const synthetic = `0.0.0@${fakeTs}`;
    return {
      network: "testnet",
      mode: "SIMULATION",
      transactionId: synthetic,
      payerAccountId: config.HEDERA_OPERATOR_ID ?? "0.0.SIMULATED",
      vendorAccountId: req.vendorAccountId,
      amountTinybars: req.amountTinybars,
      memo: req.memo,
      consensusTimestamp: fakeTs,
      result: "SUCCESS",
      explorerUrl: "simulation://no-on-chain-transaction",
    };
  }

  // Live testnet path — gated by the kill switch + credentials.
  if (!config.liveHederaConfigured) {
    throw new RouteGuardError(
      RGError.LIVE_PAYMENTS_DISABLED,
      "Live testnet payments are disabled or operator credentials are missing.",
    );
  }

  const client = getClient();
  const payer = config.HEDERA_OPERATOR_ID!;
  const amount = Hbar.from(req.amountTinybars, HbarUnit.Tinybar);

  let txId: string;
  let consensusTimestamp: string | null = null;
  try {
    const tx = new TransferTransaction()
      .addHbarTransfer(AccountId.fromString(payer), amount.negated())
      .addHbarTransfer(AccountId.fromString(req.vendorAccountId), amount)
      .setTransactionMemo(req.memo);

    const response = await tx.execute(client);
    txId = response.transactionId.toString();

    const receipt = await response.getReceipt(client);
    if (receipt.status.toString() !== "SUCCESS") {
      throw new RouteGuardError(
        RGError.HEDERA_RECEIPT_FAILED,
        `Transaction did not reach SUCCESS (status ${receipt.status.toString()}).`,
        true,
      );
    }
  } catch (err) {
    if (err instanceof RouteGuardError) throw err;
    throw new RouteGuardError(
      RGError.HEDERA_SUBMISSION_FAILED,
      `Hedera submission failed: ${String(err)}`,
      true,
    );
  }

  return {
    network: "testnet",
    mode: "AUTONOMOUS_TESTNET",
    transactionId: txId,
    payerAccountId: payer,
    vendorAccountId: req.vendorAccountId,
    amountTinybars: req.amountTinybars,
    memo: req.memo,
    consensusTimestamp,
    result: "SUCCESS",
    explorerUrl: explorerUrlForTx(txId),
  };
}
