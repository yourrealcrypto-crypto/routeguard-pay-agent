# Hedera Agent Kit feedback — RouteGuard Pay Agent

**Suggested issue title:** RouteGuard Pay Agent — policy-gated procurement demo feedback

**Repo:** TODO_GITHUB_REPO_URL

---

## What was built

RouteGuard Pay Agent is a policy-gated logistics procurement demo. An LLM proposes a bounded premium RouteRisk purchase; deterministic Agent Kit hooks and policies decide whether execution may proceed; Hedera testnet (when explicitly enabled) records payment and HCS audit evidence.

## How Hedera Agent Kit was used

- Two `BaseTool` tools: `propose_route_risk_purchase` and `execute_route_risk_purchase`
- Custom `AbstractPolicy` (`TransactionIntegrityPolicy`) at post-core-action
- Custom `AbstractHook` (`RouteGuardObservabilityHook`) for redacted lifecycle events
- `AgentMode.AUTONOMOUS` for controlled testnet execution after application-level approval gates

The project drives the core Agent Kit API directly (not the broken transitive LangChain wrapper noted in the README).

## What worked well

- Clear lifecycle stages for hooks/policies before transaction submission
- `BaseTool` extension maps cleanly to propose vs execute separation
- Policy throw/halt behavior is easy to reason about for fund safety
- Testnet HBAR transfer + mirror verification + optional HCS anchoring fit the demo narrative

## What could improve

- Published toolkit transitive dependency conflicts (`@langchain/core` subpath) blocked the wrapper import path
- More first-party examples for non-transactional propose tools + transactional execute tools in one plugin
- Clearer docs on which lifecycle stage is best for budget/replay checks vs transfer integrity

## Developer-experience friction

- Import path confusion between `@hashgraph/hedera-agent-kit` and `@hashgraph/hedera-agent-kit-langchain`
- Env/feature-flag matrix for simulation vs testnet vs HCS could be summarized in one checklist page
- Local testnet operator setup steps are spread across portal, scripts, and env vars

## Links

- RouteGuard repo: TODO_GITHUB_REPO_URL
- Live demo: TODO_LIVE_DEMO_URL
- Feedback issue (when filed): TODO_FEEDBACK_ISSUE_URL