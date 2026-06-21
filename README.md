# RouteGuard Pay Agent

> **The LLM proposes. Policy decides. Hedera proves.**

RouteGuard Pay Agent is a policy-gated logistics procurement agent. An AI agent may buy a **Premium RouteRisk report** through simulation or an explicitly enabled **HBAR payment on Hedera testnet** — but execution proceeds only when deterministic [Hedera Agent Kit](https://docs.hedera.com/hedera/open-source-solutions/ai-studio-on-hedera/hedera-ai-agent-kit/hooks-and-polices) hooks and policies approve the vendor, shipment context, service category, per-purchase cap, daily budget, and approval threshold.

Built for the **Hedera Week 5 Policy Agent** bounty.

---

## Judge quick start

```
npm install && npm run dev        # starts at http://localhost:3000
```

1. Open **Active Cases** → click **Auto-approved purchase** — fastest end-to-end path showing policy gate, simulated HBAR payment, single-use entitlement, and premium report with audit evidence.
2. Click **Human approval required** to see the human-in-the-loop escalation gate.
3. Open **Live Route Intelligence** → click **LIVE-MUC-IST** (PRIMARY DEMO, Pharma policy) → Assess live route risk.
4. Check **Verification & Audit** at the bottom of each result for transaction/simulation evidence.
5. Review **Policy & Governance** for the executive cockpit and locked payment safety.

> Everything works with **no credentials** in simulation mode. Testnet execution requires explicit configuration (see `.env.example`).

---

## Bounty fit

| Requirement | How RouteGuard demonstrates it |
|---|---|
| Policy-constrained agent payments | Eight proposal-time checks + transaction-integrity policy before any transfer |
| HBAR payment flow | Fixed 0.05 HBAR SKU, server-resolved vendor account, mirror-node verification |
| Hedera Agent Kit usage | Two `BaseTool` tools, custom `AbstractPolicy`, custom `AbstractHook` |
| Premium API purchase | Single-use entitlement unlocks premium RouteRisk API |
| Deterministic policy gates | No client/LLM control over vendor, amount, network, or approval |
| HCS / verification audit | Optional HCS anchoring + Verification & Audit evidence panel |

---

## Key features

- **Active Cases** — six sandbox scenarios with policy decision workspace and approval flow
- **Live Route Intelligence** — Open-Meteo weather evidence, checkpoint risk summaries, route-policy-aware explanations
- **Premium RouteRisk API** — fixed-price SKU with machine-readable report delivery
- **Single-use entitlement** — server-side redemption; tokens never exposed in UI or exports
- **Provider Evidence Vault** — private customer-specific evidence with hash-only Hedera binding
- **Private Provider Reliability Signal** — decision-support signal, not a public carrier rating
- **Policy & Governance** — risk policy cockpit, route policy assignments, locked payment safety
- **Report export** — download HTML, print/save PDF, email draft, copy summary
- **Archive** — per-case and bulk archive of completed operations (session state)

---

## Safety

- **Hedera testnet only** — startup guard rejects other networks
- **Simulation default** — no real HBAR unless explicitly configured
- **Dual kill switch** — `ENABLE_HEDERA_TX=false` and `LIVE_TESTNET_PAYMENTS_ENABLED` gate live execution
- **No mainnet / live production payments** in this demo
- **No `.env` committed** — secrets stay in local environment only
- **No raw entitlement tokens** in browser, exports, or audit UI
- **No raw provider documents on Hedera** — hashes and metadata only

See [docs/SECURITY.md](docs/SECURITY.md) for the full fund-safety model.

---

## How to run locally

```bash
npm install
npm run build
npm run typecheck
npm test
npm run dev
```

Open the Judge Sandbox at `http://localhost:3000`.

Everything above works with **no credentials** in simulation mode.

Optional:

```bash
npm run demo    # headless run of all scenarios
```

### Enable real Hedera testnet payments (optional)

Requires explicit human configuration. See `.env.example`. Do not enable without understanding fund-safety controls.

---

## Demo flow

1. Choose a case in **Active Cases**
2. Watch policy evaluate with readable explanations
3. Approve when required
4. Payment simulates or executes on testnet when configured
5. Single-use entitlement is issued and redeemed
6. Premium report is delivered
7. Export or print the report; inspect **Verification & Audit**

### Judge sandbox scenarios

| Scenario | Result | Demonstrates |
|---|---|---|
| Auto-approved purchase | Completed | Normal policy-approved path |
| Human approval required | Approval gate → completed | Human-in-the-loop escalation |
| Vendor blocked | Blocked | Allowlist enforcement |
| Daily budget exceeded | Blocked | Budget cap protection |
| Prompt-injection attempt | Completed (resisted) | Notes cannot steer money |
| No purchase needed | No purchase | Agent declines when risk is low |

---

## Hedera proof

| Mode | What judges see |
|---|---|
| Simulation (default) | Synthetic payment id, local policy/report hashes, simulation evidence badge |
| Testnet (when enabled) | Real capped HBAR transfer, mirror-node confirmation, optional HCS sequence numbers |

Audit events anchor to HCS when `HCS_AUDIT_TOPIC_ID` and operator credentials are configured.

---

## Architecture

```
Judge / User → Express server → AgentService → RouteGuard Agent Kit plugin
                      ├─ propose_route_risk_purchase (policy engine)
                      └─ execute_route_risk_purchase (integrity policy → payment → entitlement → report → audit)
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/POLICY_MODEL.md](docs/POLICY_MODEL.md).

---

## Submission links

| Resource | URL |
|---|---|
| Live demo | https://www.route-guard.online |
| GitHub repo | https://github.com/yourrealcrypto-crypto/routeguard-pay-agent |
| Feedback issue | https://github.com/hashgraph/hedera-agent-kit-js/issues/955 |

Copy-ready submission notes: [public/SUBMISSION_PACKAGE.md](public/SUBMISSION_PACKAGE.md)
Feedback issue draft: [public/FEEDBACK_ISSUE_DRAFT.md](public/FEEDBACK_ISSUE_DRAFT.md)
Project status: [public/PROJECT_STATUS.md](public/PROJECT_STATUS.md)

### Feedback submitted to Hedera Agent Kit

https://github.com/hashgraph/hedera-agent-kit-js/issues/955

---

## Disclaimer

RouteGuard is an **independent demo**. It is not affiliated with, sponsored by, or endorsed by Hedera Hashgraph, LLC.

Outputs are **decision-support only** — not insurance, legal, safety, or compliance advice. Shipment and weather data are synthetic demonstration inputs.

---

## License

Apache-2.0