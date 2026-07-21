# RenderDoc Replay Diagnostics

Use this skill when launching, capturing, or replaying fails, or when the user asks whether RenderDoc, the native bridge, replay host, MCP, adb, or Android target is ready.

## Workflow

1. Call `renderdoc_diagnoseEnvironment` for the complete environment snapshot.
2. For Android launch failures, call `renderdoc_checkAndroidLaunchReadiness` with the package name.
3. Read the returned error code and phase before proposing a fix.
4. For an active session, call `renderdoc_getSessionState`; retry capture only when the phase and target are ready.

## Output

Summarize each failing layer, its evidence, whether it is recoverable, and the smallest next action. Cover adb authorization/offline state, package/activity discovery, RenderDoc target availability, native bridge, replay host, and MCP status when reported.

## Guardrails

Do not infer Android readiness from a package name alone. Do not claim a capture succeeded without a returned capture path and loaded capture state.
