# Hedera Agent Kit feedback — RouteGuard Pay Agent

## What was built

RouteGuard Pay Agent is a policy-gated logistics procurement demo for the Hedera AI Studio Policy Agent bounty.

The core flow is:

> The LLM proposes. Policy decides. Hedera proves.

An LLM proposes a bounded Premium RouteRisk purchase. Deterministic policy gates decide whether execution may proceed. When explicitly enabled in a controlled local/testnet environment, Hedera testnet records the HBAR payment and HCS audit evidence.

The public demo is simulation-safe by default. Production/mainnet payments remain intentionally locked.

## How Hedera Agent Kit was used

* Two `BaseTool` tools:

  * `propose_route_risk_purchase`
  * `execute_route_risk_purchase`
* Custom `AbstractPolicy`:

  * `TransactionIntegrityPolicy`
  * used at the post-core-action stage
* Custom `AbstractHook`:

  * `RouteGuardObservabilityHook`
  * used for redacted lifecycle/audit events
* `AgentMode.AUTONOMOUS` for controlled testnet execution after application-level approval gates, policy checks, kill switches, and replay protection

The project drives the core Agent Kit API directly.

## What worked well

* The hook/policy lifecycle made the payment flow easier to reason about before transaction submission.
* `BaseTool` extension mapped cleanly to the separation between “propose purchase” and “execute purchase.”
* Policy throw/halt behavior was useful for fund-safety constraints.
* Hedera testnet transfer, mirror verification, and optional HCS anchoring fit the demo narrative well.
* The Agent Kit abstraction made it possible to show a clean product story:

  * LLM proposes
  * policy decides
  * Hedera proves

## What could improve

* More first-party examples for combining non-transactional proposal tools with transactional execution tools in one agent workflow.
* Clearer guidance on which lifecycle stage is best for:

  * budget checks
  * replay checks
  * vendor/SKU allowlists
  * transfer integrity checks
  * audit/HCS anchoring
* More explicit documentation around simulation vs testnet vs HCS-enabled configurations.
* Clearer examples for safe demo patterns where public demos remain simulation-only while local/testnet proofs demonstrate real network execution.

## Developer-experience friction

* Import path and package-boundary clarity between core Agent Kit usage and LangChain integration could be improved.
* Dependency/version compatibility around LangChain-related wrappers was a point of friction, so the project used the core Agent Kit API directly.
* Testnet operator setup, environment flags, and optional HCS topic setup could benefit from a single checklist-style page.

## Links

* RouteGuard repo: https://github.com/yourrealcrypto-crypto/routeguard-pay-agent
* Live demo: https://www.route-guard.online

After this issue is filed, I will add the issue URL back into the RouteGuard submission docs.
