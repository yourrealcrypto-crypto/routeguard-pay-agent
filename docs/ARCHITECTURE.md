# Architecture

## Overview

RouteGuard is one polished vertical slice: an agent proposes a premium-report purchase, a deterministic policy layer decides, and an approved HBAR payment on Hedera testnet unlocks the report while HCS records the audit trail.

The codebase is deliberately layered so the **policy layer is independent of the LLM, the network, and the UI**.

```
src/
  config/      validated env (testnet-only guard, kill switch, tinybar policy values)
  domain/      Zod schemas, enums, canonical JSON + sha256, stable error codes
  risk/        deterministic basic + premium scoring (reproducible → hashable)
  policy/      the 8-check deterministic policy engine + decision aggregation
  hedera/      client, tx-id↔mirror conversion, transfer, HCS anchor, mirror verifier
  store/       in-memory store with the same invariants as the spec's Postgres schema
  agent/       BaseTool tools, AbstractPolicy, AbstractHook, plugin, LLM adapter
  server/      AgentService orchestration + Express API + static UI
  cli/         headless demo + natural-language chat
scripts/       create HCS topic, check account, live testnet smoke test
```

## The 7-stage BaseTool lifecycle

Both tools extend `BaseTool`, so the Agent Kit runs them through a fixed lifecycle and fires hooks/policies automatically:

```
[1] preToolExecutionHook        ← hooks/policies (observability)
[2] normalizeParams             ← load trusted shipment + server catalog
[3] postParamsNormalizationHook ← hooks/policies
[4] coreAction                  ← evaluate policy (propose) / build transfer (execute)
[5] postCoreActionHook          ← TransactionIntegrityPolicy throws here on mismatch
[6] secondaryAction             ← submit + verify + unlock + anchor (execute only)
[7] postToolExecutionHook       ← hooks/policies
```

The integrity policy living at stage 5 is the keystone: the transfer is **built but not yet submitted**, so a mismatch aborts before any money moves.

## Orchestration algorithm

```
load shipment → free basic report → bounded model intent
  NO_PURCHASE        → return free assessment + explanation
  PROPOSE_PURCHASE   → propose_route_risk_purchase (BaseTool)
      BLOCK            → return blocked + policy evidence
      REQUIRE_APPROVAL → return approval card
      ALLOW_AUTONOMOUS → execute_route_risk_purchase (BaseTool)
                         → payment → mirror verify → report → HCS anchor
After human Approve:
  record approval → re-evaluate ALL policies inside execute tool → execute
```

Re-evaluation after approval is mandatory: budget and catalog state can change between proposal and execution.

## Purchase state machine

```
PROPOSED → AUTO_APPROVED → EXECUTING → PAYMENT_CONFIRMED → API_UNLOCKED → COMPLETED
PROPOSED → APPROVAL_REQUIRED → HUMAN_APPROVED → EXECUTING → …
PROPOSED → BLOCKED (terminal)
EXECUTING → FAILED → EXECUTING (retry only when payment state permits)
```

Rules: `BLOCKED` is terminal; approval cannot change vendor/SKU/amount/shipment; a confirmed payment that fails to unlock retries the unlock **without repaying**; a repeated execute returns the existing result; a failed payment releases the budget reservation; a confirmed payment commits it.

## Persistence

The demo uses an in-memory store that enforces the spec's invariants: one purchase per proposal, single redemption per transaction, atomic (single-threaded) daily budget reservation. Swapping to PostgreSQL means implementing the same `store` interface with the documented tables (`purchase_proposals`, `policy_checks`, `budget_reservations`, `purchases`, `vendor_redemptions`, `premium_reports`, `audit_events`) — no other code changes.
