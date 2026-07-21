---
name: renderdoc-capture-diff
description: Compare two RenderDoc captures and explain metadata and resource footprint changes without inventing timing evidence.
---

# RenderDoc Capture Diff

1. Ask for baseline and candidate `.rdc` paths when they are not known.
2. Call `renderdoc_compareCaptures`.
3. Report API/context differences, resource counts, byte-size totals, added/removed resources, and changed dimensions/formats.
4. Treat timing conclusions as unavailable unless each capture has been replayed and timed independently.
5. Drill into relevant resources or events only after identifying a concrete delta.
