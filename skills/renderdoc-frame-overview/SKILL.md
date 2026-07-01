---
name: renderdoc-frame-overview
description: Summarize the structure of a RenderDoc capture and identify its top-level passes, markers, and likely inspection targets. Use when asked for a frame overview, pass breakdown, render flow, first-look summary, or "what is happening in this frame?" for a RenderDoc capture.
---

# RenderDoc Frame Overview

Build a reliable first-pass map of the current RenderDoc capture before drilling into individual events.

## Workflow

1. Resolve capture state first.
Call `renderdoc_openCapture` with no `filePath` unless a specific capture path is already known and required.

2. Establish context.
Call `renderdoc_getSelectionContext` if the user refers to "this frame", "current capture", or a current selection.

3. Build the frame-level picture.
Call `renderdoc_getFrameSummary`.
Call `renderdoc_getCaptureInfo` if API, platform, driver, or replay context could affect interpretation.

4. Add timing context when the user asks about cost, bottlenecks, hot passes, or optimization.
Call `renderdoc_getActionTimings` before making any performance claim.

5. Highlight the most relevant next inspection targets.
Prefer top-level marker groups, major pass boundaries, expensive draws, and suspicious resources over raw event dumps.

## Output

Start with a compact summary of the frame's purpose and structure.

Then report:
- The major passes or marker groups in order.
- Any obviously expensive pass or event, with evidence if timings are available.
- Any capture constraints that matter, such as replay inactive or native-only features unavailable.
- The next 1-3 best follow-up questions or tool paths.

## Guardrails

- Do not jump straight into shader source, pipeline state, or buffer dumps unless the user explicitly asks.
- Do not invent pass names, timings, or marker hierarchy.
- If timings are unavailable, say that clearly and keep performance comments tentative.
- If the capture is not loaded, say so and stop after the recovery guidance from the tool output.
