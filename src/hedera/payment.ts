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
  type RGErrorCode,
  type SubmittedTransactionEvidence,
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

export class PaymentExecutionError extends RouteGuardError {
  constructor(
    code: RGErrorCode,
    publicMessage: string,
    retryable: boolean,
    public submittedTransaction?: SubmittedTransactionEvidence,
  ) {
    super(code, publicMessage, retryable);
    this.name = "PaymentExecutionError";
  }
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

  let submittedTransaction: SubmittedTransactionEvidence | undefined;
  try {
    const tx = new TransferTransaction()
      .addHbarTransfer(AccountId.fromString(payer), amount.negated())
      .addHbarTransfer(AccountId.fromString(req.vendorAccountId), amount)
      .setTransactionMemo(req.memo);

    const response = await tx.execute(client);
    const txId = response.transactionId.toString();
    submittedTransaction = {
      network: "testnet",
      mode: "AUTONOMOUS_TESTNET",
      transactionId: txId,
      hashscanUrl: explorerUrlForTx(txId),
      vendorAccountId: req.vendorAccountId,
      amountTinybars: req.amountTinybars,
      memo: req.memo,
    };

    const receipt = await response.getReceipt(client);
    if (receipt.status.toString() !== "SUCCESS") {
      throw new RouteGuardError(
        RGError.HEDERA_RECEIPT_FAILED,
        `Transaction did not reach SUCCESS (status ${receipt.status.toString()}).`,
        true,
      );
    }
  } catch (err) {
    if (err instanceof RouteGuardError)
      throw new PaymentExecutionError(
        err.code,
        err.publicMessage,
        err.retryable,
        submittedTransaction,
      );
    throw new PaymentExecutionError(
      RGError.HEDERA_SUBMISSION_FAILED,
      `Hedera submission failed: ${String(err)}`,
      true,
      submittedTransaction,
    );
  }

  if (!submittedTransaction)
    throw new PaymentExecutionError(
      RGError.HEDERA_SUBMISSION_FAILED,
      "Hedera submission returned no transaction evidence.",
      true,
    );

  return {
    network: "testnet",
    mode: "AUTONOMOUS_TESTNET",
    transactionId: submittedTransaction.transactionId,
    payerAccountId: payer,
    vendorAccountId: req.vendorAccountId,
    amountTinybars: req.amountTinybars,
    memo: req.memo,
    consensusTimestamp: null,
    result: "SUCCESS",
    explorerUrl: submittedTransaction.hashscanUrl,
  };
}
