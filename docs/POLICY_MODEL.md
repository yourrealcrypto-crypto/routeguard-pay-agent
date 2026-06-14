# Policy model

Policies are **code, not prompt text**. Each returns a machine-readable `outcome` (`PASS` / `REQUIRE_APPROVAL` / `BLOCK`), a stable `reasonCode`, a `publicMessage`, and an `evidence` object surfaced in the UI.

## Decision aggregation

```
BLOCK > REQUIRE_APPROVAL > ALLOW_AUTONOMOUS
```

One blocking check blocks the whole purchase. Approval can never override a hard block. The full decision is canonicalized and SHA-256 hashed; that hash appears in the UI and in HCS events.

## The eight checks

| # | Policy | Blocks when | Key reason codes |
|---|---|---|---|
| 1 | **Allowed Vendor** | vendor id or account not on the allowlist / catalog | `VENDOR_NOT_ALLOWED`, `VENDOR_ACCOUNT_MISMATCH` |
| 2 | **Service Catalog** | SKU inactive/not allowed, wrong category, network, or currency | `SERVICE_INACTIVE`, `SKU_NOT_ALLOWED`, `WRONG_NETWORK` |
| 3 | **Shipment Context** | already purchased, or no deterministic need condition met | `SHIPMENT_INELIGIBLE`, `ALREADY_PURCHASED` |
| 4 | **Per-Purchase Cap** | amount > cap (hard block; approval cannot override) | `PER_PURCHASE_CAP` |
| 5 | **Approval Threshold** | above auto-approve threshold and not yet approved at execution | `APPROVAL_REQUIRED` |
| 6 | **Daily Budget** | committed + reserved + this amount > daily budget | `DAILY_BUDGET` |
| 7 | **Replay Protection** | memo already exists for another purchase | `REPLAY` |
| 8 | **Transaction Integrity** | built transfer ≠ resolved intent (vendor/amount/memo/testnet) | `RG_POLICY_TRANSACTION_INTEGRITY` |

Checks 1–7 run at **proposal time and again at execution time**. Check 8 is the `AbstractPolicy` that runs **inside** the execute tool's lifecycle (post-core-action), before submission.

## Deterministic shipment-need conditions

A premium report is warranted only if at least one is true (the LLM's rationale alone is never sufficient):

- cargo value ≥ €50,000
- free-tier confidence < 0.75
- one or more declared risk signals
- cargo type is temperature-controlled, fragile, or high-value

## Sandbox profiles

| Profile | Effect |
|---|---|
| `standard` | base config; the 0.05 HBAR purchase auto-approves |
| `strict` | auto-approve threshold lowered to 0.02 HBAR → approval required |
| `budget_exhausted` | reports the daily budget as already spent → budget block |
| `blocked_vendor` | substitutes a non-allowlisted vendor account → vendor block |

Profiles change the *world* (context), never the *rules* (policy functions), so the policy code stays honest.
