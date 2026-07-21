---
name: renderdoc-app-launch-capture
description: Launch a Windows executable or Android application through RenderDoc and capture a frame from the active session. Use when the user asks to start an app, launch a package, or capture a frame from a launched app.
---

# RenderDoc Application Launch and Capture

Use this workflow for live application control. Do not guess the platform when the user only gives an application name.

## Platform routing

1. If the request does not clearly say Windows or Android, ask which platform.
2. Windows requires an existing `.exe` path; a bare package name is not enough.
3. Android requires an installed `adb`, an authorized online device, an installed package, a resolvable launcher activity, and a matching RenderDoc target.
4. With multiple Android devices, ask the user to choose one unless a serial, target URL, or device name was supplied.

## Windows

Call `renderdoc_launchWindowsApplication` with the executable path. Preserve the live session. Later, call `renderdoc_triggerCapture` when the user asks to capture.

## Android

Call `renderdoc_checkAndroidLaunchReadiness` before launch. Resolve package/activity and device first, then call `renderdoc_launchRemoteApplication`. Later, call `renderdoc_triggerCapture`.

## Error handling

Report actionable causes: missing adb, unauthorized/offline device, missing package, missing activity, absent RenderDoc target, injection failure, or non-debug/develop build. Do not claim launch succeeded unless the tool reports an active live target.

## Capture

Do not re-launch for a later “capture frame” request. Use the existing live session. The capture tool saves and loads the RDC into the inspector.

## Follow-up analysis

After a successful capture, use `renderdoc_getSessionState` to confirm the session and `renderdoc_generatePerformanceReport` or `renderdoc_resourceMemoryAudit` only when the user asks for performance or memory analysis. Always distinguish measured timing/resource facts from hypotheses.
