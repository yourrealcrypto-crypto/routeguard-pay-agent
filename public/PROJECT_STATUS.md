# Project Status — RouteGuard Pay Agent

**Last updated:** 21 June 2026

## What this project is

RouteGuard Pay Agent is a policy-gated AI procurement demo for logistics risk. The LLM proposes a bounded premium RouteRisk purchase; deterministic policies decide; Hedera testnet proves execution when explicitly enabled.

## What is already built

- Judge Sandbox UI (Active Cases, Live Route Intelligence, Policy & Governance, Archive)
- Premium RouteRisk API purchase flow with single-use entitlements
- Hedera Agent Kit plugin (propose + execute tools, transaction-integrity policy, observability hook)
- Provider Evidence Vault and Private Provider Reliability Signal
- Report export (download, print/PDF, email draft, copy summary)
- Verification & Audit evidence panel
- Simulation default with optional Hedera testnet execution
- Submission prep: README polish, feedback issue draft, submission package

## Current focus / Next tasks

1. File Hedera Agent Kit feedback issue — https://github.com/hashgraph/hedera-agent-kit-js/issues/955
2. Publish live demo URL — https://www.route-guard.online
3. Publish GitHub repo URL — https://github.com/yourrealcrypto-crypto/routeguard-pay-agent

## Submission readiness checklist

- [x] Judge Sandbox UI — Active Cases, Live Route Intelligence, Policy & Governance, Archive
- [x] Policy-gated purchase flow with 8 deterministic checks
- [x] Single-use entitlement and premium report delivery
- [x] Simulation default (no real HBAR without explicit config)
- [x] Hedera testnet execution path (requires local .env configuration)
- [x] HCS audit anchoring (requires HCS_AUDIT_TOPIC_ID configuration)
- [x] Report export (download HTML, print/PDF, email draft, copy summary)
- [x] Archive with Restore to Active Cases
- [x] README with thesis, bounty fit, run instructions, and submission placeholders
- [x] SUBMISSION_PACKAGE.md and FEEDBACK_ISSUE_DRAFT.md
- [ ] Fill in https://www.route-guard.online once deployed
- [ ] Fill in https://github.com/yourrealcrypto-crypto/routeguard-pay-agent once pushed
- [ ] File feedback issue and fill in https://github.com/hashgraph/hedera-agent-kit-js/issues/955

## Notes / Known issues

- On first load the workspace auto-resets the demo sandbox and runs the Auto-approved case (simulation) so judges always land on a clean, completed policy decision. Reloading the page starts a fresh demo; the "Reset demo state" button does the same on demand.
- Route policy assignments deepen client-side explanations and reports; backend payment safety unchanged
- Archive state is browser-session only until persistent store is added
- In-memory demo state is shared per running server; a page reload resets it for everyone on that server (expected for a single-judge demo)
- Feedback issue URL pending — see `public/FEEDBACK_ISSUE_DRAFT.md`

## Feedback submitted to Hedera Agent Kit

https://github.com/hashgraph/hedera-agent-kit-js/issues/955