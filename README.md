<div align="center">

# RenderDoc for VS Code

**Inspect, analyze, and debug GPU captures — without ever leaving your editor.**

[![VS Code](https://img.shields.io/badge/VS%20Code-1.95%2B-007ACC?logo=visualstudiocode&logoColor=white)](https://code.visualstudio.com/)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Copilot Chat](https://img.shields.io/badge/Copilot%20Chat-Integrated-8A2BE2?logo=github)](https://github.com/features/copilot)
[![APIs](https://img.shields.io/badge/APIs-Vulkan%20%7C%20D3D12%20%7C%20D3D11%20%7C%20OpenGL%20ES-ff6b6b)]()

*A native-backed RenderDoc frontend, reimagined for the modern editor workflow.*

</div>

---

## ✨ Overview

**RenderDoc for VS Code** brings the full power of the RenderDoc graphics debugger into Visual Studio Code. Open any `.rdc` capture file and get an instant, first-class inspection experience — draw call timelines, live shader source, pipeline state, texture previews, and an AI-assisted frame analyzer via GitHub Copilot Chat.

No context switching. No external viewers. Just your capture, your editor, and your agent.

---

## 🎯 Highlights

<table>
<tr>
<td width="50%" valign="top">

### 🔬 Full Capture Inspector
A dedicated, tabbed inspector panel with **Overview**, **Pipeline**, **Shaders**, **Textures**, **Mesh**, and **Events** — modeled after RenderDoc's native UI.

</td>
<td width="50%" valign="top">

### 🌳 Event Browser Tree
Hierarchical draw-call tree with EID-prefixed labels and group ranges (e.g. `11-559 Camera.Render`) — mirrors RenderDoc's Event Browser.

</td>
</tr>
<tr>
<td width="50%" valign="top">

### 🎨 Live Texture Previews
Click a draw to see **only the textures that draw actually samples** — render targets, depth buffers, and sampler bindings auto-loaded as thumbnails.

</td>
<td width="50%" valign="top">

### 🧩 Native Replay Bridge
A C++ bridge (`renderdoc_bridge.exe`) links directly to RenderDoc's replay DLL — real pipeline state, real shader disassembly, real descriptor enumeration.

</td>
</tr>
<tr>
<td width="50%" valign="top">

### 💬 Copilot Chat Participant
Ask `@renderdoc` anything about your capture — it reads your current selection and runs 9 specialized language-model tools on your behalf.

</td>
<td width="50%" valign="top">

### 🖼️ ASTC & HDR Aware
Built-in ASTC decoder plus `R11F_G11F_B10F` / `RGBA16F` previews — works on mobile GLES captures that other tools choke on.

</td>
</tr>
</table>

---

## 🚀 Quick Start

```text
1. Install the extension in VS Code (1.95 or later)
2. File → Open File… → select your .rdc capture
3. The RenderDoc sidebar appears automatically
4. Click any draw call → Inspector opens to the side
5. Chat with @renderdoc for deep analysis
```

> **Requires:** A local RenderDoc installation (for the replay runtime DLL). The extension auto-discovers the default install path on Windows/Linux/macOS; override via **`RenderDoc: Configure RenderDoc Path`** if needed.

---

## 📖 Usage Guide

### 1 · Installing the extension

**Option A — from VSIX (recommended for end users):**
```powershell
code --install-extension renderdoc-for-vscode-0.0.1.vsix
```
Or in VS Code: `Extensions` panel → `···` menu → **Install from VSIX…**

**Option B — from source (for contributors):** see [Building from Source](#️-building-from-source).

### 2 · Installing RenderDoc (runtime dependency)

The extension loads RenderDoc's replay library (`renderdoc.dll` /
`librenderdoc.so` / `librenderdoc.dylib`) at runtime. **Install the official
build — no patched or custom fork is needed**; the extension ships its own
lightweight native bridge on top of the stock RenderDoc API.

Download and install from the official site:
**👉 [renderdoc.org/builds](https://renderdoc.org/builds)**

> 💡 Any recent stable version (**v1.30 or newer**) works. The default install
> location is auto-detected, so if you accept the installer defaults there's
> nothing else to configure.

| Platform | Auto-detected path                       |
| -------- | ---------------------------------------- |
| Windows  | `C:\Program Files\RenderDoc\`            |
| Linux    | `/usr/lib/x86_64-linux-gnu/librenderdoc` |
| macOS    | `/Applications/RenderDoc.app/`           |

If installed elsewhere (portable ZIP, custom path, etc.), run
**`RenderDoc: Configure RenderDoc Path`** from the command palette, or set
`renderdoc.installPath` in Settings to the folder containing
`renderdoc.dll` / `librenderdoc.*`.

### 3 · Opening a capture

Three equivalent ways:

- **File explorer:** right-click a `.rdc` file → **Open RDC Capture**
- **Command palette:** `RenderDoc: Open RDC Capture`
- **Drag & drop** a `.rdc` onto the VS Code window

Once loaded, the **RenderDoc** activity-bar icon (🎥) shows three sidebar
views: `Capture Info`, `Draw Calls`, and `Resources`.

### 4 · The Inspector workflow

Click any draw call in the **Draw Calls** tree — or press the `Open Inspector`
button on the sidebar title — to open the tabbed Inspector panel beside your
editor.

| Tab         | Workflow tip                                                                      |
| ----------- | --------------------------------------------------------------------------------- |
| **Overview**  | Start here to see frame thumbnail + capture metadata                              |
| **Pipeline**  | Click a shader stage chip to jump to its source                                   |
| **Shaders**   | `Open in Editor` button pipes the source to a new VS Code tab for diff/search    |
| **Textures**  | Thumbnails load automatically; click to open the full preview modal              |
| **Mesh**      | Inspect vertex buffers, index buffer, and input layout                           |
| **Events**    | Use the EID search box to jump to any event                                       |

Navigation shortcuts inside the Inspector:
- **‹ / ›** — previous/next event
- **EID input → Go** — jump to a specific event by number

### 5 · Asking Copilot Chat (`@renderdoc`)

Open VS Code Chat (`Ctrl+Alt+I`) and mention `@renderdoc`:

```
@renderdoc 你看下这个draw的开销
@renderdoc Find all draw calls that render to the depth buffer
@renderdoc Show the fragment shader for event 246
@renderdoc Analyze this frame for potential optimization opportunities
@renderdoc Which textures are sampled by the currently selected draw?
```

The participant automatically reads your **current selection** from the
Inspector (focused EID, draw call, sidebar item), so "this draw" / "the
selected event" always refers to what you're looking at.

Under the hood it has access to these tools — which you can also invoke
directly via `#tool-name` in chat:

```
#selectionContext  #captureInfo    #drawCalls       #resources
#resourceDetail    #eventDetails   #pipelineState   #shaderSource
#textureInfo       #analyzeFrame
```

### 6 · Exporting resources

- **Export a texture to disk:** right-click a texture in the `Resources` tree
  → **Export Texture** (saves as PNG, handles ASTC / HDR / sRGB automatically)
- **Copy shader source:** open a shader in Inspector → toolbar **Copy** button,
  or `Open in Editor` for a full editor buffer

### 7 · Troubleshooting

| Symptom                                        | Fix                                                              |
| ---------------------------------------------- | ---------------------------------------------------------------- |
| "Native bridge not available" / empty shaders  | Install RenderDoc and set `renderdoc.installPath`                |
| Inspector stays blank after clicking a draw    | Reload window (`Developer: Reload Window`) — auto-recreates panel |
| Textures tab shows nothing in current-draw mode | The draw has no sampled inputs / RTs, or pipeline is still loading |
| `@renderdoc` not available in Chat             | Make sure GitHub Copilot Chat is signed in and enabled           |

---

## 🧭 Feature Tour

### The Inspector

A webview panel dedicated to a single capture, with six tabs engineered for specific workflows:

| Tab         | What you get                                                                  |
| ----------- | ----------------------------------------------------------------------------- |
| **Overview**  | Capture metadata, API, GPU driver, frame thumbnail, section list              |
| **Pipeline**  | Stage-by-stage flow diagram (IA → VS → RS → FS → OM) with bound shader names |
| **Shaders**   | Per-stage source / disassembly with program name header, openable in editor  |
| **Textures**  | Grid of bound textures (current draw scope) with auto-loaded previews         |
| **Mesh**      | Vertex buffer layout and index buffer info                                    |
| **Events**    | Flat EID timeline for fast navigation                                         |

### Sidebar Views

- **Capture Info** — quick summary & action buttons
- **Draw Calls** — hierarchical event tree with per-group ranges
- **Resources** — all textures / buffers / shaders, filterable

### Copilot Chat Tools

Invoke `@renderdoc` in VS Code Chat. The agent has access to nine tools:

```
selectionContext · captureInfo · drawCalls · resources · resourceDetail
eventDetails · pipelineState · shaderSource · textureInfo · analyzeFrame
```

Example prompts:
- *"你看下这个draw的开销"* — analyzes the currently selected draw
- *"Find all draw calls using the depth buffer"*
- *"Show me the fragment shader for event 246"*

---

## 🏗️ Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│                    VS Code Extension Host                          │
│  ┌──────────────┐  ┌─────────────┐  ┌─────────────────────────┐    │
│  │   Sidebar    │  │   Inspector │  │    Copilot Participant  │    │
│  │   Views      │  │   Webview   │  │    + LM Tools (9×)      │    │
│  └──────┬───────┘  └──────┬──────┘  └────────────┬────────────┘    │
│         └─────────────────┼──────────────────────┘                 │
│                           ▼                                        │
│                 ┌────────────────────┐                             │
│                 │  RenderDocBridge   │  ◀── TypeScript wrapper    │
│                 │  (JSON-RPC stdio)  │                             │
│                 └─────────┬──────────┘                             │
└───────────────────────────┼────────────────────────────────────────┘
                            │ stdin/stdout
                            ▼
                ┌─────────────────────────┐
                │  renderdoc_bridge.exe   │  ◀── C++ native bridge
                │  (links to RenderDoc)   │
                └─────────┬───────────────┘
                          │ IReplayController
                          ▼
                ┌─────────────────────────┐
                │   renderdoc_replay.dll  │
                └─────────────────────────┘
```

The native bridge keeps a long-lived replay session alive, caches pipeline state, and streams results as JSON — meaning shader disassembly, descriptor access, and texture readback all run at native speed.

---

## 📦 Project Layout

```
renderdoc-for-vscode/
├── src/                      # TypeScript extension source
│   ├── extension.ts            # Activation & command registration
│   ├── renderdocBridge.ts      # Native bridge client (JSON-RPC)
│   ├── rdcParser.ts            # Standalone .rdc header parser
│   ├── views/                  # Sidebar providers + Inspector webview
│   └── copilot/                # Chat participant & language-model tools
├── native/                   # C++ native bridge
│   ├── include/                # RenderDoc public headers (vendored)
│   ├── 3rdparty/               # ASTC decoder + stb_image_write
│   ├── src/                    # main.cpp, dll_loader, json.hpp
│   └── CMakeLists.txt
├── package.json              # Extension manifest
├── tsconfig.json
└── LICENSE
```

---

## 🛠️ Building from Source

### Prerequisites
- **Node.js** 18+ and npm
- **CMake** 3.20+ and a C++17 compiler (MSVC / Clang / GCC)
- **RenderDoc** installed locally (for the replay DLL at runtime)

### Build steps

```powershell
# 1. TypeScript
npm install
npm run compile

# 2. Native bridge (Windows / MSVC)
cd native
cmake -B build -A x64
cmake --build build --config Release
```

The `renderdoc_bridge.exe` output is loaded automatically by the extension.

### Run the extension
Press `F5` in VS Code — an Extension Development Host launches with the extension loaded.

---

## ⚙️ Configuration

| Setting                            | Purpose                                                |
| ---------------------------------- | ------------------------------------------------------ |
| `renderdoc.path`                   | Override RenderDoc install directory                   |
| `renderdoc.nativeBridge.enabled`   | Toggle the native replay bridge                        |
| `renderdoc.nativeBridge.path`      | Override path to `renderdoc_bridge.exe`                |

Run the command **`RenderDoc: Configure RenderDoc Path`** for a guided setup.

---

## 🗺️ Supported APIs

|  API         | Capture Load | Pipeline State | Shader Source | Texture Preview |
| ------------ | :----------: | :------------: | :-----------: | :-------------: |
| **Vulkan**     | ✅           | ✅             | ✅            | ✅              |
| **D3D12**      | ✅           | ✅             | ✅            | ✅              |
| **D3D11**      | ✅           | ✅             | ✅            | ✅              |
| **OpenGL**     | ✅           | ✅             | ✅            | ✅              |
| **OpenGL ES**  | ✅           | ✅             | ✅            | ✅              |

---

## 🤝 Contributing

Pull requests welcome! For major changes, please open an issue first to discuss what you'd like to change.

1. Fork the repo
2. Create a feature branch (`git checkout -b feat/my-feature`)
3. Commit with conventional messages
4. Open a PR against `main`

---

## 📄 License

Released under the [MIT License](LICENSE).
RenderDoc itself is © Baldur Karlsson and contributors, licensed under the MIT License.

---

<div align="center">

*Built with ❤️ for graphics engineers who live in VS Code.*

</div>
