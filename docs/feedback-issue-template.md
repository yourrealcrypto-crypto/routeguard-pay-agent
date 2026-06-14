# Feedback: Hedera Agent Kit (AI Studio tools)

**Project:** RouteGuard Pay Agent (Week 5 Policy Agent bounty)
**Packages:** `@hashgraph/hedera-agent-kit@4.0.0`, `@hiero-ledger/sdk@2.85.0`

## What worked well

- The `BaseTool` 7-stage lifecycle is an excellent control surface for payment agents. Having hooks/policies fire automatically at post-core-action (after the transfer is built, before submission) made it natural to enforce a hard transaction-integrity gate the LLM cannot bypass.
- `AbstractPolicy.shouldBlock*` semantics (return `true` → throw → halt) are clear and composable; we stacked a non-blocking `AbstractHook` and a blocking `AbstractPolicy` on the same context without friction.
- Explicit plugin opt-in (no implicit "all tools") is the right default for a least-privilege payment agent — registering exactly two tools is a real security property.
- `RETURN_BYTES` standardizing on `Uint8Array` in v4 simplified the human-in-the-loop story.

## Friction / suggestions

1. **Toolkit dependency conflict.** `@hashgraph/hedera-agent-kit-langchain@1.0.0` installs a nested `@langchain/core` that conflicts with `@langchain/langgraph`, producing `Package subpath './language_models/stream' is not defined by "exports"` on import. We worked around it by driving the core `BaseTool`/`AbstractPolicy` API directly with `@langchain/openai`. Pinning/peer-ranging the toolkit's `@langchain/*` set, or documenting a known-good lockfile, would help a lot.
2. **`AbstractPolicy` type exports.** The class is exported at runtime and typed, but the declaration lives in a separate chunk from the main `BaseTool` types; a single clearly documented import surface (with the hook param interfaces) would speed up custom-policy authoring.
3. **Hook param typing.** Because `AbstractHook` is generic, there's no compile-time safety on `coreActionResult`. A documented generic parameter or a typed helper for the post-core-action result would reduce casting.
4. **Plugin authoring docs.** A minimal end-to-end "custom plugin with one BaseTool + one policy, no framework toolkit" example (driving `tool.execute(client, context, params)` directly) would be a great addition alongside the LangChain examples.

## Environment

Node 20, TypeScript 5.9, `moduleResolution: Bundler`, ESM. Testnet. Happy to share the repo and a minimal reproduction of the toolkit import issue.
