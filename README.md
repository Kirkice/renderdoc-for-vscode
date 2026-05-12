<div align="center">

# RenderDoc for VS Code

**Inspect, analyze, and debug GPU captures — without leaving your editor.**

[![VS Code](https://img.shields.io/badge/VS%20Code-1.95%2B-007ACC?logo=visualstudiocode&logoColor=white)](https://code.visualstudio.com/)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Copilot Chat](https://img.shields.io/badge/Copilot%20Chat-Integrated-8A2BE2?logo=github)](https://github.com/features/copilot)
[![APIs](https://img.shields.io/badge/APIs-Vulkan%20%7C%20D3D12%20%7C%20D3D11%20%7C%20OpenGL%20ES-ff6b6b)]()

*A native-backed RenderDoc frontend, reimagined for the modern editor workflow.*

</div>

---

## Overview

**RenderDoc for VS Code** brings the full power of the RenderDoc graphics debugger into Visual Studio Code. Open any `.rdc` capture file and get an instant, first-class inspection experience — hierarchical draw call timelines, live shader source, full pipeline state, texture previews, GPU timing profiling, Mali shader analysis, and an AI-powered frame analyzer via GitHub Copilot Chat.

No context switching. No external viewers. Just your capture, your editor, and your agent.

---

## Highlights

<table>
<tr>
<td width="50%" valign="top">

### Full Capture Inspector
A dedicated, tabbed inspector panel with **Overview**, **Pipeline**, **Shaders**, **Textures**, **Mesh**, and **Events** — modeled after RenderDoc's native UI, built for the editor.

</td>
<td width="50%" valign="top">

### Hierarchical Event Browser
Draw-call tree with EID-prefixed labels and group ranges (e.g. `11–559 Camera.Render`). GPU timings (`durationUs`) are shown per event after running **Fetch GPU Timings**.

</td>
</tr>
<tr>
<td width="50%" valign="top">

### Live Texture Previews
Click any draw to see **only the textures that draw actually samples** — render targets, depth buffers, and sampler bindings auto-loaded as thumbnails. ASTC and HDR formats supported natively.

</td>
<td width="50%" valign="top">

### Launch And Capture
Start a **local Windows executable** or a **supported remote device target** directly from VS Code, trigger a frame capture, and auto-open the resulting `.rdc`.

The extension now exposes a dedicated **Capture Target** sidebar view for switching between **Local** and connected devices, plus a **Launch Application** panel for configuring the program/package, arguments, output path, and trigger settings.

</td>
</tr>
<tr>
<td width="50%" valign="top">

### Attach And Capture
Inject into a **running Windows process** or connect to an already running **remote RenderDoc target**, trigger a capture, and open the resulting frame in the inspector.

</td>
<td width="50%" valign="top">

### Native Replay Bridge
A C++ bridge (`renderdoc_bridge.exe`) links directly to RenderDoc's replay DLL — delivering real pipeline state, shader disassembly, descriptor enumeration, and mesh data at native speed.

</td>
</tr>
<tr>
<td width="50%" valign="top">

### AI-Powered Frame Analysis (`@renderdoc`)
Ask `@renderdoc` anything about your capture. The Copilot participant reads your current Inspector selection and dispatches 10 specialized language-model tools — including GPU timing-aware draw ranking and Mali shader analysis results.

</td>
<td width="50%" valign="top">

### Mali Offline Compiler Integration
Analyze any shader directly from the Inspector's Shaders tab using the **Mali Offline Compiler** (`malioc`). Results are shown in a resizable side-by-side panel alongside the shader source, and are also exposed to `@renderdoc` for AI-assisted optimization advice.

</td>
</tr>
</table>

---

## Screenshots

<p align="center">
    <a href="#capture-overview"><b>Capture Overview</b></a>
    ·
    <a href="#inspector-views"><b>Inspector Views</b></a>
    ·
    <a href="#copilot-workflow"><b>Copilot Workflow</b></a>
    ·
    <a href="#4--inspector-workflow"><b>Usage Guide</b></a>
</p>

<p align="center">
    A quick visual tour of the extension: capture metadata, inspector tabs, render-flow analysis, resource views, and the Copilot-assisted workflow.
</p>

### Capture Overview

<table>
<tr>
<td width="50%" valign="top" align="center">
        <img src="https://raw.githubusercontent.com/Kirkice/renderdoc-for-vscode/main/screenshots/PreView.jpeg" alt="Capture preview" width="96%" />
    <br />
    <sub><b>Preview</b> — quick visual confirmation of the captured frame output.</sub>
</td>
</tr>
</table>

### Inspector Views

<table>
<tr>
<td width="33.3%" valign="top" align="center">
    <img src="https://raw.githubusercontent.com/Kirkice/renderdoc-for-vscode/main/screenshots/PipelineState.jpeg" alt="Pipeline State" width="94%" />
    <br />
    <sub><b>Pipeline State</b> — inspect bound stages and per-draw graphics state.</sub>
</td>
<td width="33.3%" valign="top" align="center">
    <img src="https://raw.githubusercontent.com/Kirkice/renderdoc-for-vscode/main/screenshots/PipelineGraph01.jpeg" alt="Pipeline Graph overview" width="94%" />
    <br />
    <sub><b>PipelineGraph</b> — render-flow visualization derived from the full EventBrowser hierarchy.</sub>
</td>
<td width="33.3%" valign="top" align="center">
    <img src="https://raw.githubusercontent.com/Kirkice/renderdoc-for-vscode/main/screenshots/PipelineGraph02.jpeg" alt="Pipeline Graph detail" width="94%" />
    <br />
    <sub><b>PipelineGraph Detail</b> — drill into pass groups, representative commands, and selected-event context.</sub>
</td>
</tr>
<tr>
<td width="33.3%" valign="top" align="center">
    <img src="https://raw.githubusercontent.com/Kirkice/renderdoc-for-vscode/main/screenshots/Shaders.jpeg" alt="Shaders tab" width="94%" />
    <br />
    <sub><b>Shaders</b> — source, disassembly, and shader-stage analysis in one place.</sub>
</td>
<td width="33.3%" valign="top" align="center">
    <img src="https://raw.githubusercontent.com/Kirkice/renderdoc-for-vscode/main/screenshots/TextureView.jpeg" alt="Texture Viewer" width="94%" />
    <br />
    <sub><b>Texture View</b> — inspect render targets and sampled textures for the current draw.</sub>
</td>
<td width="33.3%" valign="top" align="center">
    <img src="https://raw.githubusercontent.com/Kirkice/renderdoc-for-vscode/main/screenshots/TextureInfo.jpeg" alt="Texture Info" width="94%" />
    <br />
    <sub><b>Texture Info</b> — zoom into an individual texture with focused metadata.</sub>
</td>
</tr>
<tr>
<td width="33.3%" valign="top" align="center">
    <img src="https://raw.githubusercontent.com/Kirkice/renderdoc-for-vscode/main/screenshots/MeshView.jpeg" alt="Mesh View" width="94%" />
    <br />
    <sub><b>Mesh View</b> — inspect vertex/index data and geometry layout at a selected event.</sub>
</td>
<td width="33.3%" valign="top" align="center">
    <img src="https://raw.githubusercontent.com/Kirkice/renderdoc-for-vscode/main/screenshots/ResourceInspector.jpeg" alt="Resource Inspector" width="94%" />
    <br />
    <sub><b>Resource Inspector</b> — browse textures, buffers, and shader resources across the capture.</sub>
</td>
<td width="33.3%" valign="top" align="center">
    <img src="https://raw.githubusercontent.com/Kirkice/renderdoc-for-vscode/main/screenshots/OverView.jpeg" alt="Frame preview detail" width="94%" />
    <br />
    <sub><b>Overview</b> — capture metadata, API/driver details, and frame summary.</sub>
</td>
</tr>
</table>

### Copilot Workflow

<table>
<tr>
<td width="100%" valign="top" align="center">
    <img src="https://raw.githubusercontent.com/Kirkice/renderdoc-for-vscode/main/screenshots/Chat-with-Copilot.jpeg" alt="Chat with Copilot" width="72%" />
    <br />
    <sub><b>Chat with Copilot</b> — use <code>@renderdoc</code> to analyze the current frame, draw calls, resources, and shaders.</sub>
</td>
</tr>
</table>

---

## Quick Start

```
1. Install the extension in VS Code 1.95+
2. Run `RenderDoc: Launch Program And Capture`, `RenderDoc: Attach To Process And Capture`, or open an existing `.rdc`
3. The RenderDoc sidebar appears automatically
4. Click any draw call → Inspector opens beside your editor
5. Run "Fetch GPU Timings" to populate durationUs per draw
6. Chat with @renderdoc for deep frame analysis
```

> **Requires:** Either a bundled RenderDoc runtime inside the VSIX or a local RenderDoc installation. The extension first honors **`RenderDoc: Configure RenderDoc Path`**, then tries the bundled `.renderdoc-runtime`, then falls back to the default system install path.

---

## Usage Guide

### 1 · Installing the Extension

**Option A — from VSIX (recommended):**
```powershell
code --install-extension renderdoc-for-vscode-0.0.5.vsix
```
Or: `Extensions` panel → `···` menu → **Install from VSIX…**

**Option B — from source:** see [Building from Source](#building-from-source).

---

### 2 · Installing RenderDoc (runtime dependency)

The extension loads RenderDoc's replay library (`renderdoc.dll` / `librenderdoc.so`) at runtime. If your VSIX already bundles a `.renderdoc-runtime` directory, that runtime is used automatically. Otherwise install RenderDoc locally.

**[renderdoc.org/builds](https://renderdoc.org/builds)** — any stable version **v1.30 or newer**.

| Platform | Auto-detected path                                 |
| -------- | -------------------------------------------------- |
| Windows  | `C:\Program Files\RenderDoc\`                      |
| Linux    | `/usr/lib/x86_64-linux-gnu/librenderdoc.so`        |
| macOS    | `/Applications/RenderDoc.app/`                     |

For non-default paths, run **`RenderDoc: Configure RenderDoc Path`** or set `renderdoc.installPath` in Settings.

---

### 3 · Opening a Capture

- **File explorer:** right-click a `.rdc` → **Open RDC Capture**
- **Command palette:** run **RenderDoc: Launch Program And Capture** to launch a Windows executable or a supported remote device target, then auto-open the captured frame
- **Command palette:** run **RenderDoc: Attach To Process And Capture** to inject into a running Windows process or capture an already running remote RenderDoc target
- **Command palette:** `RenderDoc: Open RDC Capture`
- **Drag & drop** a `.rdc` onto the VS Code window

The activity bar shows three sidebar views: **Capture Info**, **Draw Calls**, and **Resources**.

---

### 4 · Inspector Workflow

Click any draw call in the **Draw Calls** tree to open the tabbed Inspector panel.

| Tab          | What you get                                                                           |
| ------------ | -------------------------------------------------------------------------------------- |
| **Overview** | Frame thumbnail, capture metadata, API, GPU driver, file sections                     |
| **Pipeline** | Stage-by-stage flow diagram (IA → VS → RS → FS → OM) with bound shader names         |
| **Shaders**  | Per-stage GLSL/HLSL source with Mali Offline Compiler analysis in a split-pane view   |
| **Textures** | Bound texture grid (scoped to the current draw) with auto-loaded thumbnails            |
| **Mesh**     | Vertex buffer layout, index buffer, input assembly configuration                       |
| **Events**   | Flat EID timeline; GPU `durationUs` shown per row after Fetch GPU Timings             |

Navigation:
- **‹ / ›** buttons — step to previous/next event
- **EID input → Go** — jump directly to any event by number

---

### 5 · GPU Timing Profiling

1. Open the **Draw Calls** sidebar.
2. Click the **Fetch GPU Timings** button (⏱).
3. Each draw call is annotated with its measured GPU time (`durationUs`).
4. Ask `@renderdoc` to rank draws by cost — it reads the timing data directly.

---

### 6 · Mali Offline Compiler Integration

1. Install the [Mali Offline Compiler](https://developer.arm.com/Tools%20and%20Software/Mali%20Offline%20Compiler) from Arm Developer.
2. Set `renderdoc.maliOfflineCompilerPath` to the path of `malioc.exe` in VS Code Settings.
3. In the Inspector → **Shaders** tab, click **Analyze with Mali Offline Compiler**.
4. The analysis result appears in a resizable pane beside the shader source.
5. Ask `@renderdoc` for optimization suggestions — it has access to the Mali analysis output.

---

### 7 · Copilot Chat (`@renderdoc`)

Open VS Code Chat (`Ctrl+Alt+I`) and address `@renderdoc`:

```
@renderdoc 帮我找出当前帧耗时最高的前20个Draw，带完整层级名称
@renderdoc Analyze the fragment shader for EID 495 and suggest optimizations
@renderdoc Find all draw calls rendering to the shadow map
@renderdoc Show pipeline state diff between EID 300 and EID 355
@renderdoc Which textures are bound at the currently selected draw?
```

The participant reads your **active Inspector selection** (focused EID, draw call, sidebar resource) so natural references like *"this draw"* or *"the current event"* resolve automatically.

Available tools (also invokable via `#tool-name`):

| Tool | Description |
| ---- | ----------- |
| `#selectionContext` | Current Inspector focus: EID, draw call, pipeline state, Mali analysis |
| `#captureInfo` | Capture metadata: API, driver, version, sections |
| `#drawCalls` | Full draw call tree with GPU `durationUs` timings and pre-sorted `expensiveDraws` |
| `#resources` | All GPU resources: textures, buffers, shaders |
| `#resourceDetail` | Detail for a specific resource by ID |
| `#eventDetails` | Full event info including pipeline state |
| `#pipelineState` | Complete pipeline state at a given EID (native bridge required) |
| `#shaderSource` | GLSL/HLSL source for all bound stages at an EID |
| `#textureInfo` | Texture-specific metadata |
| `#analyzeFrame` | Comprehensive frame summary with flagged issues |

---

### 8 · Exporting Resources

- **Texture → PNG:** right-click a texture in **Resources** → **Export Texture** (ASTC, HDR, sRGB handled automatically)
- **Shader source:** Inspector → Shaders tab → **Copy** button, or **Open in Editor** for a full VS Code buffer

---

### 9 · Troubleshooting

| Symptom | Fix |
| ------- | --- |
| "Native bridge not available" / empty shaders | Install RenderDoc and set `renderdoc.installPath` |
| Inspector stays blank after clicking a draw | `Developer: Reload Window` — auto-recreates the panel |
| Textures tab shows nothing | The draw has no sampled inputs/RTs, or pipeline is still loading |
| Mali Offline Compiler button missing | Set `renderdoc.maliOfflineCompilerPath` to the path of `malioc.exe` |
| `@renderdoc` not available in Chat | Ensure GitHub Copilot Chat is signed in and enabled |
| GPU timings show `N/A` | Click **Fetch GPU Timings** in the Draw Calls sidebar first |

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                        VS Code Extension Host                        │
│  ┌──────────────┐   ┌──────────────────┐   ┌──────────────────────┐  │
│  │   Sidebar    │   │    Inspector     │   │  Copilot Participant  │  │
│  │   Views      │   │    Webview       │   │  + LM Tools (10×)    │  │
│  └──────┬───────┘   └────────┬─────────┘   └──────────┬───────────┘  │
│         └────────────────────┼────────────────────────┘              │
│                              ▼                                       │
│                   ┌─────────────────────┐                            │
│                   │   RenderDocBridge   │  ← TypeScript JSON-RPC     │
│                   └──────────┬──────────┘                            │
└──────────────────────────────┼───────────────────────────────────────┘
                               │ stdin / stdout
                               ▼
                   ┌───────────────────────┐
                   │  renderdoc_bridge.exe │  ← C++ native bridge
                   │  (links to RenderDoc) │
                   └───────────┬───────────┘
                               │ IReplayController
                               ▼
                   ┌───────────────────────┐
                   │  renderdoc_replay.dll │
                   └───────────────────────┘
```

The native bridge maintains a long-lived replay session, caches pipeline state per EID, and streams results as JSON — shader disassembly, descriptor access, GPU timings, and texture readback all execute at native speed.

---

## Project Layout

```
renderdoc-for-vscode/
├── src/
│   ├── extension.ts              # Activation, command registration
│   ├── renderdocBridge.ts        # Native bridge client (JSON-RPC over stdio)
│   ├── rdcParser.ts              # Pure-TS .rdc header/section parser
│   ├── views/                    # Sidebar tree providers + Inspector webview
│   │   ├── inspectorPanel.ts     # Main Inspector panel (IPC, Mali analysis)
│   │   └── inspector/html.ts     # Inspector HTML template generation
│   └── copilot/
│       ├── chatParticipant.ts    # @renderdoc Copilot Chat handler
│       └── tools.ts              # Language model tool implementations
├── native/
│   ├── include/                  # RenderDoc public headers (vendored)
│   ├── 3rdparty/                 # ASTC decoder, stb_image_write
│   ├── src/                      # main.cpp, dll_loader.cpp, json.hpp
│   └── CMakeLists.txt
├── media/inspector/              # Webview frontend (JS + CSS)
├── package.json
├── tsconfig.json
└── LICENSE
```

---

## Building from Source

### Prerequisites

- **Node.js** 18+ and npm
- **CMake** 3.20+ with a C++17 compiler (MSVC 2019+ / Clang 12+ / GCC 10+)
- **RenderDoc** installed locally (replay DLL required at runtime)

### Build

```powershell
# TypeScript extension
npm install
npm run compile

# C++ native bridge (Windows / MSVC)
cd native
cmake -B build -A x64
cmake --build build --config Release
```

The compiled `renderdoc_bridge.exe` is discovered automatically by the extension at runtime.

### Run in Development

Press `F5` in VS Code — launches an Extension Development Host with the extension loaded and the debugger attached.

---

## Configuration

| Setting | Default | Description |
| ------- | ------- | ----------- |
| `renderdoc.installPath` | *(auto-detect)* | RenderDoc installation directory |
| `renderdoc.nativeBridge.path` | *(auto-detect)* | Path to `renderdoc_bridge.exe` |
| `renderdoc.maliOfflineCompilerPath` | *(empty)* | Path to `malioc.exe` for shader analysis |

Run **`RenderDoc: Configure RenderDoc Path`** for a guided setup wizard.

---

## Supported APIs

| API | Capture Load | Pipeline State | Shader Source | Texture Preview | GPU Timings |
| --- | :---: | :---: | :---: | :---: | :---: |
| **Vulkan** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **D3D12** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **D3D11** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **OpenGL** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **OpenGL ES** | ✅ | ✅ | ✅ | ✅ | ✅ |

---

## Contributing

Pull requests are welcome. For significant changes, open an issue first to discuss the design.

1. Fork the repository
2. Create a feature branch: `git checkout -b feat/my-feature`
3. Write conventional commit messages
4. Open a PR targeting `main`

---

## License

Released under the [MIT License](LICENSE).

RenderDoc is © Baldur Karlsson and contributors, licensed under the MIT License.

---

<div align="center">

*Built for graphics engineers who live in VS Code.*

</div>
