---
name: renderdoc-replay-recovery-helper
description: Recover from missing RenderDoc capture or replay state before attempting deeper analysis. Use when tools report no capture loaded, replay inactive, native-only data unavailable, or when the user asks to restore enough state for RenderDoc inspection to continue.
---

# RenderDoc Replay Recovery Helper

Recover analysis state safely and explicitly instead of guessing through missing replay data.

## Workflow

1. Resolve capture state first.
Call `renderdoc_openCapture` with no `filePath` unless the user provided a specific path.

2. Inspect current state.
Call `renderdoc_getSelectionContext` if the user expects a current selection or active event.

3. Classify the failure mode.
Possible cases:
- No capture is loaded
- A capture is loaded but replay-only features are unavailable
- The current request depends on a selection that does not exist
- The requested native detail is unsupported in the current state

4. Continue only as far as the state allows.
If frame-level data is still available, provide it.
If replay-only detail is unavailable, stop short of inventing the missing detail and explain the limitation.

5. Tell the user the shortest path forward.
Prefer one concrete next step over a long troubleshooting list.

## Output

State clearly:
- What is available right now
- What is missing
- Which analysis paths remain possible
- The next best recovery step

## Guardrails

- Never fabricate replay-only data when replay is unavailable.
- Do not ask for a file path unless `renderdoc_openCapture` makes clear that no active or open capture could be resolved.
- Keep the answer calm and operational. The goal is to unblock the next step quickly.
