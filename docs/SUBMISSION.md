# Submission

## Project summary

RouteGuard Pay Agent is a policy-gated procurement agent: an AI agent proposes buying a Premium RouteRisk report and pays for it in HBAR on Hedera testnet, but the payment executes only when deterministic Hedera Agent Kit policies approve the vendor, shipment context, service category, per-purchase cap, daily budget, and approval threshold. A custom `AbstractPolicy` runs inside the tool lifecycle and blocks any transfer that doesn't match the server-resolved intent; the vendor side independently verifies the payment on the mirror node; and every lifecycle event is anchored to HCS. The model proposes, policy decides, Hedera proves.

## Technical summary

- **Agent Kit v4 custom plugin** with two `BaseTool` tools (`propose_route_risk_purchase`, `execute_route_risk_purchase`).
- **Policy lifecycle**: a custom `AbstractPolicy` (`TransactionIntegrityPolicy`) blocks at post-core-action before submission; a custom `AbstractHook` records redacted lifecycle events; eight deterministic policy checks aggregate with `BLOCK > REQUIRE_APPROVAL > ALLOW_AUTONOMOUS`.
- **HBAR transfer** built with exact tinybar amounts to a fixed allowlisted vendor, memo `RG:<id>`.
- **Mirror-node verification** independent of the buyer's claim, with replay/single-use redemption.
- **HCS audit** with compact, privacy-preserving payloads; decoupled from payment.
- **Hosted paid API** semantics: the report stays locked until a verified payment.
- **Safety**: server-resolved money, re-evaluation at execution, idempotent execution, atomic budget reservation, kill switch, rate limits, testnet-only guard.

## Bounty requirements checklist

- [x] Public GitHub repository
- [x] Built with the Hedera Agent Kit (JS, v4) — `BaseTool`, `AbstractPolicy`, `AbstractHook`
- [x] Live demo agent URL (Judge Sandbox)
- [x] Hosted URL committed for ≥ 90 days
- [x] Policy layer clearly integrated into interface and execution flow
- [x] One feedback issue on AI Studio tools (see `docs/feedback-issue-template.md`)
- [x] Agents make it impossible to drain funds without consent (caps, approval, integrity policy, server-resolved money)

## Demo video order

problem & thesis → auto-approved flow → approval-required flow → blocked flow → Hedera transaction proof → HCS proof → code walkthrough of BaseTool + policies → mirror verification.
