---
name: renderdoc-unity-analysis
description: 'Analyze Unity RenderDoc captures in VS Code. Use when working with Unity, URP, HDRP, SRP, ScriptableRendererFeature, ScriptableRenderPass, RenderGraph, ShaderLab, Blitter, Fullscreen Pass, RendererList, ProfilingSampler, RenderPassEvent, Unity shader files, selected draw timing, selected draw performance cost, or mapping a RenderDoc pass/shader back to Unity C# implementation. Covers bottlenecks, GPU timings, suspicious passes, Unity render path debugging, 当前选中的draw性能开销, 当前draw为什么慢, 帮我在Unity工程里定位这个pass, URP/HDRP性能分析, RenderGraph pass 对应实现, 这个shader在Unity哪里定义.'
argument-hint: 'Describe the Unity capture issue, pass, shader, or optimization goal'
---

# RenderDoc Unity Analysis

Use this skill when the capture question is specifically about a Unity project or Unity rendering stack: Built-in RP, URP, HDRP, custom SRP, RenderGraph, ScriptableRendererFeature, ScriptableRenderPass, ShaderLab, or Unity-side pass/shader implementation lookup.

This skill is layered on top of the existing RenderDoc capture tools. It does not replace the generic `renderdoc-analysis` workflow. Capture facts should still come from the extension's existing `renderdoc_*` language model tools. This skill adds Unity-specific routing, naming heuristics, and fallback behavior when mapping a suspicious RenderDoc event back to Unity project code.

## Preconditions

- Use the same `renderdoc_*` tools as the generic RenderDoc workflow for all capture facts.
- Treat Unity-specific conclusions as hypotheses unless the project mapping results have strong signals.
- Prefer `renderdoc_findProjectImplementation` when the user asks where a pass, shader, or bottleneck comes from in Unity project code.
- Respect the tool's `compatibility` field before making strong claims about Unity source locations.
- If no Unity project workspace is open, continue with capture analysis and say explicitly that Unity code mapping is unavailable.

## Default Procedure

1. Start with generic RenderDoc capture analysis to establish the relevant event, pass, shader, or timing bottleneck.
2. When the question becomes Unity-specific, map the suspicious event or shader back to project code.
3. Explain the likely Unity-side owner using Unity render-pipeline concepts, not only raw RenderDoc terms.
4. If the workspace mapping signal is weak, say so and present candidates rather than a single definitive source file.

Detailed Unity workflows are in [workflow playbook](./references/workflows.md).

## Tool Strategy

- Use `renderdoc_getSelectionContext` when the user says "this", "current", or is focused on a selected draw or shader.
- For a Unity question about the currently selected draw's cost or timing, resolve the focused event through `renderdoc_getSelectionContext` before any deeper lookup.
- Use `renderdoc_getFrameSummary` and `renderdoc_getActionTimings` first for Unity performance questions.
- For Unity performance work, drill into the hottest Unity-visible EIDs instead of only listing pass timings.
- Use `renderdoc_getShaderInfo` when the issue likely lives in a specific Unity shader stage, constant buffer, or binding set.
- Use `renderdoc_findProjectImplementation` to map suspicious passes or shaders back to Unity C# and shader files.
- Prefer `prioritizedMatches` from `renderdoc_findProjectImplementation` over lower-level raw match lists.
- Treat match strength in this order: shader file hit, C# pass string hit, marker path hit.

## Unity Interpretation Rules

- Translate expensive RenderDoc passes into likely Unity owners such as `ScriptableRendererFeature`, `ScriptableRenderPass`, `RenderGraph` pass builder code, fullscreen effects, or shader files.
- When explaining a likely source location, name the Unity subsystem if possible: URP, HDRP, custom SRP, post-processing, shadow pass, depth prepass, transparent pass, fullscreen blit, or RenderGraph utility pass.
- If a pass name looks generic, avoid overcommitting. Use the candidate ordering and explain why the highest-ranked files are only candidates.
- If `compatibility.status` is `noWorkspace`, `noRelevantFiles`, or `weakMatch`, do not claim to have found the Unity implementation.
- For performance answers, include both the RenderDoc evidence and the likely Unity-side owner or subsystem so the user can move directly from bottleneck to code investigation.

## Common Triggers

- "Which Unity pass is causing this bottleneck?"
- "Find the URP/HDRP code behind this RenderDoc pass"
- "Map this shader back to the Unity project"
- "Where is this ScriptableRenderPass implemented?"
- "Which RendererFeature owns this fullscreen pass?"

## Common Chinese Triggers

- "帮我定位这个 pass 在 Unity 工程里的实现"
- "这个 RenderDoc pass 对应 URP/HDRP 的哪段代码？"
- "帮我找出这个 ShaderLab / HLSL 在 Unity 项目里哪里定义"
- "这个性能瓶颈在 Unity 里大概率是哪一个 RendererFeature 或 RenderPass"
- "把这个 EID 对应回 Unity 的 RenderGraph pass 或 C# 实现"