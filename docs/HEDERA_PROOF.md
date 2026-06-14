# Hedera proof

Every completed purchase produces a proof bundle the Judge Sandbox renders and that you can independently verify.

## Payment proof

| Field | Meaning |
|---|---|
| `network` | always `testnet` |
| `mode` | `SIMULATION` or `AUTONOMOUS_TESTNET` |
| `transactionId` | SDK format `0.0.x@seconds.nanos` |
| `vendorAccountId` | the allowlisted recipient |
| `amountTinybars` | exactly the catalog price (5,000,000 = 0.05 HBAR) |
| `memo` | `RG:<8-char proposal id>` |
| `explorerUrl` | HashScan link (live mode) |

In live mode the transaction id converts to mirror REST format `0.0.x-seconds-nanos` and is independently validated against `https://testnet.mirrornode.hedera.com`.

## Independent mirror verification

The unlock step does **not** trust that payment happened — it queries the mirror node (bounded exponential backoff for ingestion lag) and accepts the transaction only if **all** hold:

- `result === "SUCCESS"`
- `name === "CRYPTOTRANSFER"`
- the vendor account receives **exactly** the expected tinybars
- the expected payer appears as a debit
- the decoded memo equals the expected memo
- the transaction has not already been redeemed

This logic is pure and unit-tested (`evaluateMirrorBody`) against valid, wrong-vendor, wrong-amount, wrong-memo, unsuccessful, missing-payer, and malformed payloads.

## HCS audit trail

Compact, privacy-preserving payloads (no raw shipment data, no free text) are anchored to one HCS topic:

```json
{ "v": 1, "event": "PAYMENT_CONFIRMED", "proposal": "eec1b0b5",
  "policyHash": "<sha256>", "txId": "0.0.x@...", "reportHash": "<sha256>",
  "ts": "2026-..." }
```

Event types: `PURCHASE_PROPOSED`, `POLICY_AUTO_APPROVED`, `POLICY_APPROVAL_REQUIRED`, `POLICY_BLOCKED`, `HUMAN_APPROVED`, `PAYMENT_SUBMITTED`, `PAYMENT_CONFIRMED`, `API_ACCESS_GRANTED`, `REPORT_DELIVERED`, `EXECUTION_FAILED`.

In simulation (or when HCS isn't configured) a verifiable local payload hash is still produced and labelled `SKIPPED_SIMULATION`, so the audit shape is identical — only the on-chain anchor differs.

## Report hash

The premium report's scoring is deterministic, so `reportHash = sha256(report-without-hash)` is reproducible. The same shipment + transaction always yields the same factor contributions, which makes the on-chain report hash a meaningful integrity commitment.
