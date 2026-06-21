import { TopicMessageSubmitTransaction } from "@hiero-ledger/sdk";
import { config } from "../config/index.js";
import { getClient } from "./client.js";
import {
  type AuditAnchor,
  type AuditEventType,
  sha256,
} from "../domain/index.js";

/**
 * Anchors a compact, privacy-preserving audit record to HCS. We never put raw
 * shipment details or free text on-chain — only an event tag, hashes, and ids.
 *
 * Audit is intentionally decoupled from payment: an HCS failure is surfaced in
 * the UI but must NEVER cause a second payment or block the report. The proof
 * panel shows payment-confirmed and audit-confirmed as independent facts.
 */

export interface AuditPayload {
  v: 1;
  event: AuditEventType;
  proposal: string; // uuid prefix
  policyHash: string;
  txId: string | null;
  reportHash: string | null;
  entitlement: string | null;
  sku: string | null;
  paymentRef: string | null;
  ts: string;
}

export async function anchorAuditEvent(
  eventType: AuditEventType,
  data: {
    proposalId: string;
    policyHash: string;
    txId?: string | null;
    reportHash?: string | null;
    entitlementId?: string | null;
    sku?: string | null;
    mode: "SIMULATION" | "AUTONOMOUS_TESTNET";
  },
): Promise<AuditAnchor> {
  const payload: AuditPayload = {
    v: 1,
    event: eventType,
    proposal: data.proposalId.slice(0, 8),
    policyHash: data.policyHash,
    txId: data.txId ?? null,
    reportHash: data.reportHash ?? null,
    entitlement: data.entitlementId ?? null,
    sku: data.sku ?? null,
    paymentRef: data.txId ? sha256(data.txId).slice(0, 16) : null,
    ts: new Date().toISOString(),
  };
  const payloadHash = sha256(payload);
  const createdAt = new Date().toISOString();

  // In simulation, or when HCS isn't configured, we still produce a verifiable
  // local hash — just clearly labelled as not anchored on-chain.
  if (data.mode === "SIMULATION" || !config.hcsConfigured) {
    return {
      eventType,
      payloadHash,
      hcsTopicId: null,
      hcsSequenceNumber: null,
      hcsTransactionId: null,
      hcsStatus: "SKIPPED_SIMULATION",
      createdAt,
    };
  }

  try {
    const client = getClient();
    const tx = new TopicMessageSubmitTransaction()
      .setTopicId(config.HCS_AUDIT_TOPIC_ID!)
      .setMessage(JSON.stringify(payload));
    const response = await tx.execute(client);
    const receipt = await response.getReceipt(client);
    return {
      eventType,
      payloadHash,
      hcsTopicId: config.HCS_AUDIT_TOPIC_ID!,
      hcsSequenceNumber: receipt.topicSequenceNumber
        ? Number(receipt.topicSequenceNumber)
        : null,
      hcsTransactionId: response.transactionId.toString(),
      hcsStatus: "ANCHORED",
      createdAt,
    };
  } catch {
    // Audit failure is visible but non-fatal.
    return {
      eventType,
      payloadHash,
      hcsTopicId: config.HCS_AUDIT_TOPIC_ID ?? null,
      hcsSequenceNumber: null,
      hcsTransactionId: null,
      hcsStatus: "FAILED",
      createdAt,
    };
  }
}
