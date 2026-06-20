import { describe, expect, it } from "vitest";
import {
  VerificationResultSchema,
  type AuditAnchor,
  type PaymentProof,
} from "../src/domain/index.js";
import {
  buildVerificationResult,
  REQUIRED_VERIFICATION_HCS_EVENTS,
} from "../src/verification/result.js";

const simulationPayment: PaymentProof = {
  network: "testnet",
  mode: "SIMULATION",
  transactionId: "0.0.0@1710000000.000000001",
  payerAccountId: "0.0.SIMULATED",
  vendorAccountId: "0.0.2002",
  amountTinybars: 5_000_000,
  memo: "RG:abcd1234",
  consensusTimestamp: "1710000000.000000001",
  result: "SUCCESS",
  explorerUrl: "simulation://no-on-chain-transaction",
};

const livePayment: PaymentProof = {
  ...simulationPayment,
  mode: "AUTONOMOUS_TESTNET",
  transactionId: "0.0.1001@1710000000.000000001",
  payerAccountId: "0.0.1001",
  consensusTimestamp: "1710000001.000000002",
  explorerUrl:
    "https://hashscan.io/testnet/transaction/0.0.1001@1710000000.000000001",
};

function anchor(
  eventType: AuditAnchor["eventType"],
  hcsStatus: AuditAnchor["hcsStatus"] = "ANCHORED",
  sequence = 1,
): AuditAnchor {
  return {
    eventType,
    payloadHash: "a".repeat(64),
    hcsTopicId: "0.0.3003",
    hcsSequenceNumber: hcsStatus === "ANCHORED" ? sequence : null,
    hcsTransactionId: hcsStatus === "ANCHORED" ? `0.0.1001@${sequence}.0` : null,
    hcsStatus,
    createdAt: "2026-06-21T00:00:00.000Z",
  };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    executionMode: "AUTONOMOUS_TESTNET" as const,
    payment: livePayment,
    mirrorNodeConfirmation: "CONFIRMED" as const,
    auditTrail: REQUIRED_VERIFICATION_HCS_EVENTS.map((event, index) =>
      anchor(event, "ANCHORED", index + 1),
    ),
    hcsConfigured: true,
    ...overrides,
  };
}

describe("authoritative verification result", () => {
  it("always classifies simulation as SIMULATION_EVIDENCE", () => {
    const result = buildVerificationResult({
      executionMode: "SIMULATION",
      payment: simulationPayment,
      mirrorNodeConfirmation: "NOT_APPLICABLE",
      auditTrail: [],
      hcsConfigured: false,
      failureCode: "RG_VENDOR_API_FAILED",
    });
    expect(result.status).toBe("SIMULATION_EVIDENCE");
    expect(result.transactionSubmitted).toBe(false);
    expect(result.transactionId).toBeNull();
    expect(VerificationResultSchema.safeParse(result).success).toBe(true);
  });

  it("returns VERIFICATION_PENDING after submission while Mirror Node is pending", () => {
    const preparing = buildVerificationResult({
      executionMode: "AUTONOMOUS_TESTNET",
      mirrorNodeConfirmation: "PENDING",
      auditTrail: [],
      hcsConfigured: true,
    });
    expect(preparing.status).toBe("VERIFICATION_PENDING");
    expect(preparing.transactionSubmitted).toBe(false);

    const result = buildVerificationResult(
      input({
        payment: { ...livePayment, consensusTimestamp: null },
        mirrorNodeConfirmation: "PENDING",
        auditTrail: [],
      }),
    );
    expect(result.status).toBe("VERIFICATION_PENDING");
    expect(result.transactionSubmitted).toBe(true);
    expect(result.transactionId).toBe(livePayment.transactionId);
  });

  it("returns VERIFIED_ON_HEDERA only with Mirror timestamp and every required HCS event", () => {
    const result = buildVerificationResult(input());
    expect(result.status).toBe("VERIFIED_ON_HEDERA");
    expect(result.mirrorNodeConfirmation).toBe("CONFIRMED");
    expect(result.hcsAnchoringStatus).toBe("ANCHORED");
    expect(result.hcsSequenceNumbers).toEqual([1, 2, 3]);
  });

  it("returns PARTIALLY_VERIFIED for a confirmed transaction with incomplete HCS", () => {
    const result = buildVerificationResult(
      input({ auditTrail: [anchor("PAYMENT_CONFIRMED")] }),
    );
    expect(result.status).toBe("PARTIALLY_VERIFIED");
    expect(result.transactionId).toBe(livePayment.transactionId);
    expect(result.consensusTimestamp).toBe(livePayment.consensusTimestamp);
    expect(result.hcsAnchoringStatus).toBe("PARTIAL");

    const notConfigured = buildVerificationResult(
      input({ hcsConfigured: false, auditTrail: [] }),
    );
    expect(notConfigured.status).toBe("PARTIALLY_VERIFIED");
    expect(notConfigured.hcsAnchoringStatus).toBe("NOT_CONFIGURED");
  });

  it("returns VERIFICATION_FAILED while preserving submitted transaction evidence", () => {
    const submittedTransaction = {
      network: "testnet" as const,
      mode: "AUTONOMOUS_TESTNET" as const,
      transactionId: "0.0.1001@1710000002.000000003",
      hashscanUrl:
        "https://hashscan.io/testnet/transaction/0.0.1001@1710000002.000000003",
      vendorAccountId: "0.0.2002",
      amountTinybars: 5_000_000,
      memo: "RG:abcd1234",
    };
    const result = buildVerificationResult({
      executionMode: "AUTONOMOUS_TESTNET",
      submittedTransaction,
      mirrorNodeConfirmation: "FAILED",
      auditTrail: [],
      hcsConfigured: true,
      failureCode: "RG_MIRROR_TIMEOUT",
      failureReason: "Mirror Node confirmation timed out.",
    });
    expect(result.status).toBe("VERIFICATION_FAILED");
    expect(result.transactionSubmitted).toBe(true);
    expect(result.transactionId).toBe(submittedTransaction.transactionId);
    expect(result.hashscanUrl).toBe(submittedTransaction.hashscanUrl);
    expect(result.failureCode).toBe("RG_MIRROR_TIMEOUT");

    const submissionFailure = buildVerificationResult({
      executionMode: "AUTONOMOUS_TESTNET",
      mirrorNodeConfirmation: "PENDING",
      auditTrail: [],
      hcsConfigured: true,
      failureCode: "RG_HEDERA_SUBMISSION_FAILED",
      failureReason: "No transaction was submitted.",
    });
    expect(submissionFailure.status).toBe("VERIFICATION_FAILED");
    expect(submissionFailure.transactionSubmitted).toBe(false);
  });
});
