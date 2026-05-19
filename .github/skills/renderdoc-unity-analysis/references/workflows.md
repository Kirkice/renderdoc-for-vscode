# RenderDoc Unity Workflow Playbook

This file focuses on Unity-specific routing on top of the generic RenderDoc analysis flow.

## Unity Performance Triage

Use this path when the user asks about URP, HDRP, SRP, or Unity-side performance owners.

0. If the question is about the currently selected draw, call `renderdoc_getSelectionContext` first and use the focused event as the Unity-side debugging target.
1. Call `renderdoc_getFrameSummary` first for frame structure.
2. Call `renderdoc_getActionTimings` to identify the hottest Unity-visible passes or leaf draws.
3. Pick the top hot EIDs and explain them one by one instead of only listing pass timings.
4. For a suspicious EID, call `renderdoc_getShaderInfo` if the issue looks shader- or binding-related.
5. Call `renderdoc_findProjectImplementation` with the EID or derived shader/pass names.
6. Explain the result in Unity terms and reference the highest-ranked candidates first.

For Unity performance answers, prefer this shape:

1. Frame-level Unity takeaway.
2. Top expensive Unity-visible passes or hot leaf draws with timings and RenderDoc hierarchy.
3. For the hottest EIDs, explain the likely Unity subsystem or owner: URP pass, HDRP custom pass, RendererFeature, ScriptableRenderPass, RenderGraph pass, fullscreen effect, or shader.
4. If project mapping is available, cite the best Unity-side implementation candidates.
5. End with the next most useful optimization or debugging target.

## Unity Pass And Shader Mapping

Use this path when the user asks where a RenderDoc pass or shader comes from in the Unity project.

1. Resolve the target event or shader.
2. Call `renderdoc_findProjectImplementation`.
3. Read `compatibility.status` before making any claim.
4. Use `prioritizedMatches` first.
5. Prefer results in this order:
   shader file hit
   C# pass string hit
   marker path hit
6. If multiple high-ranked files exist, present them as candidates with a short explanation of why each one is plausible.

## Unity-Specific Clues To Look For

- C# types such as `ScriptableRendererFeature`, `ScriptableRenderPass`, `CustomPass`, `RenderGraphModule`, `RenderGraph`, `RendererList`, `ProfilingSampler`, `ShaderTagId`, `RenderPassEvent`, `Blitter`, `CoreUtils`, `RTHandle`, `CommandBuffer`.
- Shader assets or includes such as `.shader`, `.shadergraph`, `.hlsl`, `.hlsli`, `.cginc`.
- ShaderLab pass names, profiling scope strings, or marker names that align with the RenderDoc hierarchy.
- URP/HDRP conventions like depth prepass, shadow caster, GBuffer, forward opaque, transparents, fullscreen blit, post-processing, or RenderGraph utility passes.

## Compatibility And Fallbacks

- `ready`: treat top-ranked candidates as strong likely owners.
- `partial`: the workspace is usable, but the source mapping is not definitive. Present candidates, not certainties.
- `weakMatch`: the workspace has relevant file types, but names do not line up well. Explain the uncertainty.
- `noRelevantFiles`: the opened workspace likely is not the Unity project that produced the capture.
- `noWorkspace`: continue with capture-only analysis and ask the user to open the Unity project when they want source mapping.

## Answer Shape

- Lead with the likely Unity-side owner first.
- Then cite the RenderDoc evidence: EID, pass path, timings, shader stage, or suspicious binding.
- If the mapping signal is weak, say that before listing candidates.
- Keep the distinction clear between confirmed capture facts and inferred Unity implementation candidates.