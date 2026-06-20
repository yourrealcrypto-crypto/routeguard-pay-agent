import type {
  AuditAnchor,
  AuditEventType,
  HcsAnchoringStatus,
  MirrorNodeConfirmation,
  PaymentProof,
  PolicyDecisionResult,
  PremiumReport,
  SubmittedTransactionEvidence,
  VerificationResult,
} from "../domain/index.js";

export const REQUIRED_VERIFICATION_HCS_EVENTS = [
  "PAYMENT_CONFIRMED",
  "API_ACCESS_GRANTED",
  "REPORT_DELIVERED",
] as const satisfies readonly AuditEventType[];

export interface VerificationEvidenceInput {
  executionMode: "SIMULATION" | "AUTONOMOUS_TESTNET";
  payment?: PaymentProof;
  submittedTransaction?: SubmittedTransactionEvidence;
  vendorAccountId?: string | null;
  amountTinybars?: number | null;
  memo?: string | null;
  mirrorNodeConfirmation: MirrorNodeConfirmation;
  auditTrail: AuditAnchor[];
  hcsConfigured: boolean;
  configuredHcsTopicId?: string | null;
  report?: PremiumReport;
  decision?: PolicyDecisionResult;
  failureCode?: string | null;
  failureReason?: string | null;
}

function hcsStatus(input: VerificationEvidenceInput): HcsAnchoringStatus {
  if (input.executionMode === "SIMULATION") return "NOT_APPLICABLE";
  if (!input.hcsConfigured) return "NOT_CONFIGURED";

  const required = REQUIRED_VERIFICATION_HCS_EVENTS.map((eventType) =>
    input.auditTrail.find((anchor) => anchor.eventType === eventType),
  );
  if (
    required.every(
      (anchor) => anchor?.hcsStatus === "ANCHORED",
    )
  )
    return "ANCHORED";
  if (required.some((anchor) => anchor?.hcsStatus === "PENDING"))
    return "PENDING";
  const anchored = required.filter(
    (anchor) => anchor?.hcsStatus === "ANCHORED",
  ).length;
  if (anchored > 0) return "PARTIAL";
  if (required.some((anchor) => anchor?.hcsStatus === "FAILED"))
    return "FAILED";
  return "PENDING";
}

/**
 * Authoritative server-side verification state machine. The UI renders this
 * object and never upgrades a case based on a selected execution mode.
 */
export function buildVerificationResult(
  input: VerificationEvidenceInput,
): VerificationResult {
  const livePayment =
    input.payment?.mode === "AUTONOMOUS_TESTNET" ? input.payment : undefined;
  const submitted = input.submittedTransaction;
  const transactionId = livePayment?.transactionId ?? submitted?.transactionId ?? null;
  const transactionSubmitted = Boolean(transactionId);
  const anchoringStatus = hcsStatus(input);
  const consensusTimestamp = livePayment?.consensusTimestamp ?? null;

  const common = {
    executionMode: input.executionMode,
    transactionSubmitted,
    transactionId:
      input.executionMode === "AUTONOMOUS_TESTNET" ? transactionId : null,
    hashscanUrl:
      livePayment?.explorerUrl ?? submitted?.hashscanUrl ?? null,
    vendorAccountId:
      input.payment?.vendorAccountId ??
      submitted?.vendorAccountId ??
      input.vendorAccountId ??
      null,
    amountTinybars:
      input.payment?.amountTinybars ??
      submitted?.amountTinybars ??
      input.amountTinybars ??
      null,
    memo: input.payment?.memo ?? submitted?.memo ?? input.memo ?? null,
    mirrorNodeConfirmation:
      input.executionMode === "SIMULATION"
        ? ("NOT_APPLICABLE" as const)
        : input.mirrorNodeConfirmation,
    consensusTimestamp:
      input.executionMode === "AUTONOMOUS_TESTNET"
        ? consensusTimestamp
        : null,
    hcsConfigured: input.hcsConfigured,
    hcsAnchoringStatus: anchoringStatus,
    hcsTopicId:
      input.auditTrail.find((anchor) => anchor.hcsTopicId)?.hcsTopicId ??
      input.configuredHcsTopicId ??
      null,
    hcsSequenceNumbers: input.auditTrail
      .map((anchor) => anchor.hcsSequenceNumber)
      .filter((sequence): sequence is number => sequence !== null),
    reportHash: input.report?.reportHash ?? null,
    policyHash:
      input.report?.policyHash ?? input.decision?.canonicalHash ?? null,
    policyVersion:
      input.report?.policyVersion ?? input.decision?.policyVersion ?? null,
    failureCode: input.failureCode ?? null,
    failureReason: input.failureReason ?? null,
  };

  if (input.executionMode === "SIMULATION")
    return { ...common, status: "SIMULATION_EVIDENCE" };

  if (!transactionSubmitted)
    return {
      ...common,
      status: input.failureCode
        ? "VERIFICATION_FAILED"
        : "VERIFICATION_PENDING",
    };

  if (
    input.mirrorNodeConfirmation === "FAILED" ||
    (input.failureCode && input.mirrorNodeConfirmation !== "CONFIRMED")
  )
    return { ...common, status: "VERIFICATION_FAILED" };

  if (
    input.mirrorNodeConfirmation !== "CONFIRMED" ||
    !consensusTimestamp
  )
    return { ...common, status: "VERIFICATION_PENDING" };

  if (anchoringStatus === "ANCHORED")
    return { ...common, status: "VERIFIED_ON_HEDERA" };

  return { ...common, status: "PARTIALLY_VERIFIED" };
}
