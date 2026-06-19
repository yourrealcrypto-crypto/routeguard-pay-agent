# RouteGuard Pay Agent

> **The LLM proposes. Policy decides. Hedera proves.**

RouteGuard Pay Agent is a policy-gated procurement agent. It lets an AI agent buy a **Premium RouteRisk report** through a simulated payment or an explicitly enabled **HBAR payment on Hedera testnet** — but execution proceeds **only** when deterministic [Hedera Agent Kit](https://docs.hedera.com/hedera/open-source-solutions/ai-studio-on-hedera/hedera-ai-agent-kit/hooks-and-polices) hooks and policies approve the vendor, shipment context, service category, per-purchase cap, daily budget, and approval threshold. Simulation produces local audit hashes; configured real-testnet runs can anchor audit events to the **Hedera Consensus Service (HCS)**.

Built for the **Hedera Week 5 Policy Agent** bounty.

---

## The problem

Businesses will not give an autonomous agent an open wallet. An LLM that can be steered by a cleverly worded document is one prompt-injection away from draining funds. The missing piece is not a smarter model — it is a **deterministic authority layer** between intent and money.

## The solution

RouteGuard separates three concerns and makes the boundary between them visible:

1. **The LLM proposes** a purchase and a rationale. It may request only one SKU. It can never choose a vendor account, an amount, a network, an approval, or a payment status.
2. **Deterministic policies decide.** Seven proposal-time policy checks aggregate to `ALLOW_AUTONOMOUS`, `REQUIRE_APPROVAL`, or `BLOCK`, then one execution-time transaction-integrity policy checks the built transfer before submission. One block blocks the purchase; approval can never override a hard cap.
3. **Hedera proves in real testnet mode.** The approved, capped HBAR transfer is submitted on testnet and independently verified against the mirror node. Audit events are anchored to HCS when `HCS_AUDIT_TOPIC_ID` and operator credentials are configured; simulation performs neither the transfer nor the HCS write.

The model creates intent. The policy layer grants authority. Hedera records the consequence.

## Why Hedera

- **Native HBAR transfers** with low, predictable fees — easy for an agent to reason about cost.
- **Hedera Consensus Service** gives a cheap, ordered, tamper-evident audit log without deploying a contract.
- **Agent Kit hooks and policies** let business rules intercept a tool's lifecycle *before submission* — exactly the control surface a payment agent needs.
- **Two execution modes** (autonomous and human-in-the-loop) map cleanly onto the auto-approve vs. approval-required distinction.

---

## Architecture

```
Judge / User
    │
    ▼
RouteGuard server (Express)  ── serves the Judge Sandbox UI
    │
    ▼
AgentService (orchestration)
    │
    ├─► LLM adapter (bounded intent; heuristic fallback)
    │
    └─► RouteGuard Agent Kit plugin
            │
            ├─ propose_route_risk_purchase  (BaseTool, non-transactional)
            │      └─ Policy engine (8 deterministic checks)
            │
            └─ execute_route_risk_purchase  (BaseTool, transactional)
                   ├─ [postCoreActionHook] TransactionIntegrityPolicy  ← blocks bad transfers
                   ├─ Payment (synthetic simulation id | capped testnet transfer)
                   ├─ Mirror-node verification (real testnet only)
                   ├─ Premium report unlock (single-use redemption)
                   └─ Audit (local hash | configured HCS anchor)
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full lifecycle and [docs/POLICY_MODEL.md](docs/POLICY_MODEL.md) for every policy.

---

## How the Hedera Agent Kit is used

This is the core of the bounty alignment, and it is **real, not decorative**:

- **Two `BaseTool` tools** (`propose_route_risk_purchase`, `execute_route_risk_purchase`). Extending `BaseTool` is what lets hooks and policies tap the 7-stage lifecycle automatically.
- **A custom `AbstractPolicy`** — `TransactionIntegrityPolicy` — runs at **post-core-action**, after the transfer is built but before it is submitted. It throws (halting the kit lifecycle) unless the transfer matches the server-resolved vendor, exact amount, and memo on testnet. The LLM cannot route around it.
- **A custom `AbstractHook`** — `RouteGuardObservabilityHook` — records redacted lifecycle events at each stage for the audit/timeline view.
- **`AgentMode.AUTONOMOUS`** context drives the execute tool; manual approval is an application-level gate that precedes autonomous testnet signing.
- **Capability is constrained by construction.** The plugin registers exactly two tools — there is no token-creation, account-deletion, contract, NFT, or arbitrary-transfer tool anywhere in the agent's reach.

> Implementation note: the published `@hashgraph/hedera-agent-kit-langchain` toolkit currently ships a nested `@langchain/core` that conflicts with `@langchain/langgraph` (a missing `./language_models/stream` subpath), which breaks importing the toolkit wrapper. RouteGuard therefore drives the agent through the **core Agent Kit `BaseTool` / `AbstractPolicy` / `AbstractHook` API directly** plus `@langchain/openai` — the exact layer the bounty judges — and avoids the broken transitive dependency. The dependency tree here imports cleanly.

---

## Demo flow

1. Open the app, pick a scenario.
2. See the free shipment assessment.
3. See the agent propose the premium report (with its rationale).
4. See **every policy check and its evidence** — not just a green/red badge.
5. Continue automatically, or tap **Approve** when the scenario requires it.
6. See the simulated payment or real testnet HBAR payment and the report unlock.
7. Inspect the proof bundle: transaction id, vendor, amount, memo, report hash, and whether audit events were locally hashed or anchored to HCS.

### Judge sandbox scenarios

| Scenario | Result | Demonstrates |
|---|---|---|
| Auto-approved purchase | Completed | Normal policy-approved path |
| Human approval required | Approval gate → completed | Human-in-the-loop escalation |
| Vendor blocked | Blocked | Allowlist enforcement, no transfer built |
| Daily budget exceeded | Blocked | Budget cap protection |
| Prompt-injection attempt | Ignored → normal path | Notes can't steer money |
| No purchase needed | No purchase | Agent declines when risk is low |

---

## Setup

```bash
npm install
cp .env.example .env      # optional — runs without it
npm run typecheck         # passes against the real Agent Kit v4 API
npm run test              # 42 deterministic tests
npm run demo              # runs every scenario headlessly (zero config)
npm run dev               # opens the Judge Sandbox at http://localhost:3000
```

Everything above works with **no credentials** in simulation mode.

### Execution modes

- **Simulation (default):** creates a clearly labelled synthetic payment id and local audit hashes. It moves no HBAR, performs no mirror-node verification, and writes nothing to HCS.
- **Real Hedera testnet:** submits the policy-approved capped HBAR transfer and verifies it independently through the mirror node. When `HCS_AUDIT_TOPIC_ID` and operator credentials are configured, audit events are also anchored to HCS; otherwise they remain local hashes.

### Enable real Hedera testnet payments

1. Create a testnet account at [portal.hedera.com](https://portal.hedera.com) and fund it.
2. Create a second account to act as the vendor.
3. Put both in `.env`, set `ENABLE_HEDERA_TX=true` and `LIVE_TESTNET_PAYMENTS_ENABLED=true`.
4. To enable real HCS audit anchoring, create an HCS audit topic and copy the printed id into `.env`:
   ```bash
   npm run create:hcs-topic
   ```
5. Verify readiness, then run one real capped payment end-to-end:
   ```bash
   npm run check:account
   npm run smoke:testnet
   ```

---

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` / `start` | Run the server + Judge Sandbox |
| `npm run demo` | Headless run of all 6 scenarios (simulation) |
| `npm run agent` | Natural-language CLI against a shipment |
| `npm run test` | Vitest unit + integration suite |
| `npm run typecheck` | `tsc --noEmit` against the real API |
| `npm run create:hcs-topic` | Create the HCS audit topic (run once) |
| `npm run check:account` | Show operator balance + feature readiness |
| `npm run smoke:testnet` | One real capped testnet payment (manual) |

---

## Security & fund-safety

Summarized here, detailed in [docs/SECURITY.md](docs/SECURITY.md):

- One SKU, one vendor, one fixed price, all server-resolved. No client-provided amount or recipient.
- Per-purchase cap (hard block), daily budget (atomic reservation), one purchase per shipment.
- `TransactionIntegrityPolicy` blocks any transfer that doesn't match the resolved intent.
- Single-use payment redemption; idempotent execution never double-pays.
- Prompt-injection resistance: notes are treated as data, all money is resolved server-side, and policy is re-evaluated at execution with no model involvement.
- Live payments off by default; per-IP and global daily live-spend rate limits; testnet-only guard at startup.
- Secrets live in env only, are never logged, and never reach the browser.

---

## Limitations & disclaimers

- **Hedera testnet only.** There is a startup guard against any other network.
- **HBAR has no real settlement role** in this demo — it proves the payment-authority pattern.
- **Shipment data is synthetic** and the risk report is **demonstration decision-support, not insurance, legal, safety, or compliance advice.**
- The store is in-memory for the demo; the same invariants map directly onto the PostgreSQL schema described in the docs.

## Hosting

The live demo URL is committed to remain available for at least **90 days** after submission.

## Feedback

Required bounty feedback on AI Studio tools is linked in the app footer and tracked in [docs/feedback-issue-template.md](docs/feedback-issue-template.md).

## License

Apache-2.0.
