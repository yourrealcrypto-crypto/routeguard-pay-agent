# RouteGuard Pay Agent Instructions

## Project objective

RouteGuard Pay Agent is a policy-gated AI procurement agent.

The LLM proposes.
Policy decides.
Hedera testnet proves execution.

## Safety rules

* Hedera testnet only.
* Never add or enable mainnet.
* Never execute real HBAR payments without explicit human approval.
* Never read, display, modify, or commit private keys.
* Never commit .env or .env.local.
* Never expose secrets in browser code.
* Never let user input or LLM output choose the payment recipient, amount, vendor, network, or approval status.
* Financial values must come from trusted server configuration.
* Never bypass policy, approval, budget, replay, idempotency, or transaction-integrity checks.
* Never deploy or push to GitHub without explicit approval.
* Never use --force, --legacy-peer-deps, --yolo, or permission-bypass options.

## Current mode

Keep real Hedera execution disabled.

ENABLE_HEDERA_TX=false

Treat all payments as simulation unless explicitly authorized.

## Before editing code

1. Read the relevant files.
2. Explain the current behavior.
3. Identify the exact problem.
4. Show the relevant file paths.
5. Propose the smallest safe change.
6. Wait for approval before large changes.

## After editing code

1. Run npm run typecheck.
2. Run npm test.
3. Run npm run demo when the agent flow changes.
4. List every changed file.
5. Show the Git diff.
6. Do not claim success unless tests pass.

## Priorities

1. Fund safety
2. Correct Hedera Agent Kit integration
3. Trusted server-side payment parameters
4. Idempotency and replay protection
5. Policy re-evaluation
6. Persistent state
7. Mirror Node verification
8. Tests
9. UI polish

## Git rules

* Never commit secrets.
* Never rewrite Git history.
* Never force-push.
* Create checkpoints before substantial changes.
* Keep changes small and reviewable.
