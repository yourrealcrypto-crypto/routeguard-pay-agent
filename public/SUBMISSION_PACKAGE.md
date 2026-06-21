# RouteGuard Pay Agent — Bounty Submission Package

**Project name:** RouteGuard Pay Agent  
**Track / bounty:** Hedera Policy Agent / Week 5  
**One-line thesis:** The LLM proposes. Policy decides. Hedera proves.

**Live demo:** TODO_LIVE_DEMO_URL  
**GitHub repo:** TODO_GITHUB_REPO_URL  
**Feedback issue:** https://github.com/hashgraph/hedera-agent-kit-js/issues/955

---

## Judge quick start

1. Open the app → **Active Cases** → **Auto-approved purchase** — fastest end-to-end path.
2. Click **Human approval required** → Approve the purchase → see entitlement + premium report.
3. Open **Live Route Intelligence** → **LIVE-MUC-IST** (PRIMARY DEMO, Pharma policy) → Assess live route risk.
4. Review **Verification & Audit** at the bottom of each result.
5. Open **Policy & Governance** for the executive cockpit and locked payment safety.

---

## What the agent does

RouteGuard is a policy-gated procurement agent for logistics risk. It assesses shipment or live-route context, proposes a single fixed-price premium RouteRisk report SKU, and executes only when deterministic policies approve vendor, SKU, price, budget, approval, and transaction integrity.

## What is purchased

- **Product:** Premium RouteRisk Analysis
- **Vendor:** Route Risk Labs (server allowlist)
- **SKU:** `premium-route-risk-v1`
- **Price:** 0.05 HBAR (server-resolved, hard-capped)

## Why the purchase is policy-constrained

Money never follows LLM intent directly. Vendor account, amount, network, approval, and execution mode are resolved server-side. Eight proposal-time checks aggregate to ALLOW / REQUIRE APPROVAL / BLOCK; a post-core-action transaction-integrity policy halts any transfer that does not match the resolved intent.

## How the premium API works

1. Agent proposes purchase with rationale  
2. Policies evaluate shipment/route context  
3. Payment simulates or executes on Hedera testnet when enabled  
4. Single-use entitlement is issued  
5. Entitlement redeems premium API once  
6. Machine-readable premium report is delivered and exportable  

## How entitlements work

- One entitlement per successful purchase  
- Server-side token never exposed in UI or exports  
- Redemption is idempotent; replay protection prevents double payment  

## Hedera usage

- Native HBAR transfer on **testnet only** when `ENABLE_HEDERA_TX` and live testnet flags are configured
- Mirror Node verification for submitted transactions
- HCS audit anchoring when `HCS_AUDIT_TOPIC_ID` and operator credentials are configured
- Simulation mode produces local hashes only — no HBAR movement, no HCS write

## Agent Kit usage

- `propose_route_risk_purchase` — non-transactional intent tool  
- `execute_route_risk_purchase` — transactional execution tool  
- `TransactionIntegrityPolicy` — blocks mismatched transfers before submission  
- `RouteGuardObservabilityHook` — redacted lifecycle audit events  

## Testnet / simulation explanation

- **Default:** Simulation — synthetic payment id, local audit hashes, no real HBAR  
- **Optional:** Real testnet HBAR with explicit server configuration and human approval where required  
- **Never:** Mainnet or live production payments in this demo  

## Safety controls

- Testnet-only startup guard  
- Dual kill switch (`ENABLE_HEDERA_TX`, `LIVE_TESTNET_PAYMENTS_ENABLED`)  
- Fixed vendor, SKU, price from server config  
- Per-purchase cap, daily budget, replay/idempotency protection  
- No raw entitlement tokens or provider documents in browser exports  
- Payment safety policy locked globally (not overridable by route policy UI)  

## Main demo steps for judges

1. Open the Judge Sandbox  
2. Choose **Active Cases** → run auto-approved or approval-required scenario  
3. Inspect policy checks, readable explanations, and collapsed technical evidence  
4. Complete approval if required; observe payment + entitlement + premium report  
5. Open **Verification & Audit** for transaction / simulation evidence  
6. Try **Live Route Intelligence** → assess `LIVE-MUC-IST` (Pharma policy)  
7. Export or print the premium report  
8. Use **Archive completed cases** to clear finished operations  
9. Review **Policy & Governance** cockpit and locked payment safety  

## What to click first

**Active Cases → Auto-approved purchase** — fastest end-to-end path showing policy gate, simulated payment, entitlement, report, and verification evidence.

## What proof to look for

- Policy decision cards with readable business explanations  
- Technical evidence appendix (collapsed) with policy/report hashes  
- Entitlement ID (not raw token)  
- Simulation evidence badge or testnet transaction id + mirror confirmation  
- HCS sequence numbers when configured  
- Route policy assignment visible in Live Route Intelligence and premium reports  

## Known limitations

- In-memory store (demo persistence resets on restart)  
- Route policy assignments affect client-side explanation/reporting; payment safety remains server-locked  
- Synthetic shipment and weather data — decision-support only  
- Toolkit LangChain wrapper import conflict documented in README  

## Independent-demo disclaimer

RouteGuard is an independent demo. It is not affiliated with, sponsored by, or endorsed by Hedera Hashgraph, LLC. Outputs are decision-support only — not insurance, legal, safety, or compliance advice.