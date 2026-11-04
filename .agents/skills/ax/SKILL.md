---
name: ax
description: >-
  Build, test, optimize and ship UniiChat LLM programs with Ax (@ax-llm/ax, DSPy
  for TypeScript) on Bun, above all the compactor that writes one-line summaries
  of at most 512 UTF-8 bytes. Use when writing or changing Ax signatures, AxGen
  programs, asserts and retries, the adapter that sends Ax calls through
  UniiChat's own model routes, GEPA or bootstrap optimization, metrics or LLM
  judges, or loading a saved optimized program. Do not use for UniiChat model
  routing, subscriptions or the TUI and web UI themselves, or for Python DSPy and
  DSPx work; use the repository code and AGENTS.md, or the dspx repo, instead.
compatibility: "Bun 1.4+, @ax-llm/ax 25.4.x"
metadata:
  version: "1.0.0"
  owner: "uniichat maintainers"
  canonical_source: "uniichat/.agents/skills/ax"
  source_policy: "versioned: @ax-llm/ax 25.4.6 package and ax repo v25.4.8 (686f8ba96)"
  last_verified: "2026-11-04"
---

# Ax in UniiChat

Ax turns a signature (`inputs -> outputs`) into a prompt, parses the answer into fields, checks it and retries. Optimizers rewrite the instruction and demos; the result is plain JSON that a program loads at startup.

## Boundary

- Own Ax programs in UniiChat: signatures, asserts, the route adapter, optimization runs and the saved program.
- Model routing, subscriptions, `Memory` storage and the UI stay with the repository code; change them only as the compactor needs, under AGENTS.md.

## Non-negotiable decisions

1. **Bytes, not characters.** `f.string().max(n)` and `maxLength` count characters (`value.length`). A summary of 300 `ä` passes `max(512)` at 600 bytes. Enforce the limit with `addAssert` on `Buffer.byteLength(text, 'utf8')`.
2. **One line is your check.** Ax returns a multi-line answer as one field value. Assert or flatten single-line output yourself.
3. **Exhaustion throws, and the attempts are gone.** When `maxRetries` (default 3, extra tries after the first) runs out, `forward` throws `AxGenerateError` ("Generate failed: Unable to fix validation error: …"). An error thrown inside the adapter (a route stop) comes out as the same `AxGenerateError` after one call, so record stops in the adapter and rethrow them. Keep every answer in the adapter, so UniiChat can still store the shortest one cut with `Memory.cut`. Never let a summary go unstored or over the limit.
4. **Our routes, no API keys.** Ax calls go through UniiChat's `Memory.ask`/`AskAI` via an `AxMockAIService` `chatResponse` adapter, so provenance (`by`), patience, repicks and stop handling keep working. Do not use `ai({ name: 'openai', apiKey })` in UniiChat.
5. **The prompt changes.** Ax writes its own system prompt (`<identity>`, `<input_fields>`, `<output_fields>`, `<formatting_rules>`) and expects `field: value` lines. A retry is a new turn: the previous answer as `assistant`, then `Follow these instructions: <assert message>` as `user`. Compare old and new prompts with `scripts/preview.mjs` before trusting any quality comparison.
6. **Ship JSON, never optimize at runtime.** Commit the serialized optimized program and apply it at load; optimization is an offline run with its own call budget and the operator's authorization for live calls.
7. **Pin the version.** Use an exact `@ax-llm/ax` 25.4.x version. The global Bun `minimumReleaseAge` (7 days) refuses newer releases; an exclusion needs a supply-chain review first. The package's postinstall installs agent skills; Bun blocks it, and it must stay blocked (or set `AX_SKIP_SKILL_INSTALL=1`).

## Workflow

1. Read the current compactor code (`Memory.build`, `Memory.ask_till_fits`, `Memory.ask`, `Memory.task`, `Memory.over`) before changing it; Ax replaces the try loop, not the storing, provenance or fallback.
2. Build the program and adapter as in [compactor-program.md](references/compactor-program.md).
3. Prove it with a mock service under Bun in a scratch directory: an over-long answer retries, exhaustion falls back, provenance is set, multi-line output is caught. Then run it the way a user would (isolated container, copied state), per AGENTS.md.
4. To improve the instruction or demos, follow [optimize-and-ship.md](references/optimize-and-ship.md): metric first, held-out set, budget, saved JSON, A/B against the current prompt.
5. Finish with `bun run check` at 0 errors.

## Resources

| Resource | Read when |
|---|---|
| [references/compactor-program.md](references/compactor-program.md) | Writing the signature, asserts, adapter, fallback or mock tests |
| [references/optimize-and-ship.md](references/optimize-and-ship.md) | Optimizing, writing metrics or judges, saving and loading programs, budgets |
| `scripts/preview.mjs` | Seeing the exact messages Ax sends for a signature: `bun .agents/skills/ax/scripts/preview.mjs 'source:string -> summary:string'` |
| `node_modules/@ax-llm/ax/skills/ax-*.md` | Any other Ax API (flows, agents, refine, typesafe); they match the installed version. Without an install: `~/ai-society/softwareco/contrib/ax/website/static/typescript/.well-known/agent-skills/` |

## Verification

- The mock proof shows: retry on an over-long answer, fallback on exhaustion, a stop rethrown, multi-line caught, `by` set.
- The user-like run shows stored summaries at most 512 bytes, one line, with `by` and `at`.
- `bun run check` reports 0 errors.

## Stop conditions

- An API in this skill does not match the installed version's types: trust `node_modules/@ax-llm/ax/index.d.ts`, then fix this skill.
- An optimization needs live provider calls: stop and ask the operator for the route and a call budget.
