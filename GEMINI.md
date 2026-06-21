# RouteGuard Pay Agent AI Coding Instructions

RouteGuard Pay Agent is a Hedera Policy Agent bounty project.

Core thesis:

“The LLM proposes. Policy decides. Hedera proves.”

## Safety rules

Do not read or modify `.env.local`.

Do not enable live payments.

Do not change:

* Hedera accounts
* vendor account
* payment amount
* payment limits
* approval thresholds
* kill switches
* network behavior
* entitlement safety
* replay protection

Do not run:

* `npm run create:hcs-topic`
* `npm run smoke:testnet`

Do not commit.

Do not push.

After edits, run:

```powershell
npm run build
npm run typecheck
npm test
git diff --check
```

## Product direction

Focus on final UI/UX polish.

Design principles:

* progressive disclosure
* decision first, raw proof second
* logistics control tower style
* cyber-minimalist but enterprise-practical
* high signal, low noise
* readable for judges and business users
* technical proof remains accessible

Do not add new product scope unless explicitly approved.

## Current design priorities

1. Live Route Intelligence corridor view
2. Checkpoint risk summaries
3. Compact raw evidence disclosures
4. Compact technical appendix
5. Policy & Governance executive cockpit
6. Hide hashes by default
7. Archive completed cases in one click
8. Fix scroll/focus issues
9. Preserve premium API, entitlements, policy gates, and Hedera audit behavior
