# RenderDoc Rule Ownership

This file is the deduplication checklist for the workspace skill and the `@renderdoc` participant prompt.

## Keep Only In The Skill

Use the skill as the single source of truth for generic tool-orchestration guidance that should help default Copilot.

- Preference for this workspace extension's `renderdoc_*` language model tools over equivalent external RenderDoc MCP tools.
- Which question shapes map to which RenderDoc workflow.
- Start-with-cheapest-tool guidance such as frame overview first, then narrower draw-call inspection.
- When shader source, texture data, or buffer contents are worth fetching.
- Reverse-lookup paths for shader, texture, and resource tracing.
- Buffer paging strategy with `offset` and `len`.
- Generic answer-shape guidance such as concise findings first and avoiding raw JSON dumps.
- Common English and Chinese trigger phrases for skill discovery.

## Keep Only In The Participant Prompt

Use the `@renderdoc` prompt as the single source of truth for runtime-dependent hard constraints that must always apply during participant chats.

- Never fabricate RenderDoc facts; use `renderdoc_*` tools for all capture data.
- Resolve missing event or resource IDs from selection context before deeper inspection.
- For performance ranking, trust `expensiveDraws` rather than vertex or index counts.
- When reporting expensive draws, include the full logical marker hierarchy path.
- Reference events as `EID <n>`.
- Native bridge availability messaging and fallback behavior.

## Keep In Tool Schema Or Tool Implementation

Do not duplicate these in either the skill or the participant prompt unless the rule is critical for model safety.

- Filter parameters and pagination knobs such as `markerFilter`, `onlyDrawCalls`, `eventIdMin`, `eventIdMax`, `offset`, and `len`.
- Selection-context payload shape.
- Pre-aggregated fields such as `expensiveDraws` and frame-summary structure.
- Native-only capability boundaries enforced by tool implementation.

## Editing Rule

Before adding a new RenderDoc guidance rule, decide where it belongs:

1. Tool layer if it can be enforced structurally.
2. Skill if it is a reusable workflow for default Copilot.
3. Participant prompt only if it is a runtime-dependent hard rule for `@renderdoc`.