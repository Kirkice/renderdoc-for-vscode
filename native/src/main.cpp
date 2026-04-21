/**
 * renderdoc_bridge — Standalone C++ exe that communicates with the VS Code
 * extension via JSON-over-stdin/stdout. Loads renderdoc.dll at runtime and
 * exposes the replay API for shader viewing, texture export, pipeline state, etc.
 *
 * Protocol (newline-delimited JSON):
 *   Request:  {"id":1,"method":"openCapture","params":{"path":"C:/file.rdc"}}
 *   Response: {"id":1,"result":{...}}
 *   Error:    {"id":1,"error":{"code":-1,"message":"..."}}
 */

#include "dll_loader.h"
#include "json.hpp"

#include <iostream>
#include <string>
#include <sstream>
#include <fstream>
#include <filesystem>
#include <mutex>
#include <vector>
#include <map>
#include <set>
#include <chrono>
#include <cmath>
#include <thread>
#include <atomic>

// Third-party: ASTC LDR software decoder (BSD/Apache from ANGLE via basis_universal)
#include "astc_dec/astc_decomp.h"

// Third-party: single-header PNG encoder
#define STB_IMAGE_WRITE_IMPLEMENTATION
#include "stb/stb_image_write.h"

#ifdef _WIN32
#include <windows.h>
// Export the replay marker so that renderdoc.dll recognizes this process as a
// replay application and does NOT install its D3D11/DXGI/Vulkan hooks.
// Without this, ANGLE's D3D11 backend deadlocks because RenderDoc hooks
// intercept and try to wrap the D3D11 device ANGLE creates internally.
extern "C" __declspec(dllexport) int renderdoc__replay__marker = 0;
#endif

using json = nlohmann::json;

// ── Global state ────────────────────────────────────────────────────────────
static DllLoader         g_dll;
static ICaptureFile     *g_capFile    = nullptr;
static IReplayController*g_replay     = nullptr;
static bool              g_replayInit = false;

// Guards all writes to stdout. The replay worker thread can emit progress
// notifications while the main thread is also writing responses/logs, so
// every `std::cout` write must hold this lock to avoid interleaved JSON
// lines (which would make TS-side JSON.parse silently drop the message).
static std::mutex        g_stdoutMutex;

static inline void writeJsonLine(const json &j) {
    std::lock_guard<std::mutex> lock(g_stdoutMutex);
    std::cout << j.dump() << "\n" << std::flush;
}

// Cached headless replay output for drawcall-overlay rendering.
// Reused across events as long as the backing dimensions don't change.
static IReplayOutput    *g_overlayOut  = nullptr;
static int32_t           g_overlayW    = 0;
static int32_t           g_overlayH    = 0;

// ── Helpers ─────────────────────────────────────────────────────────────────

static json makeError(int id, int code, const std::string &msg) {
    return {{"id", id}, {"error", {{"code", code}, {"message", msg}}}};
}

static json makeResult(int id, const json &result) {
    return {{"id", id}, {"result", result}};
}

static std::string rdcToStr(const rdcstr &s) {
    return std::string(s.c_str(), s.size());
}

// ResourceId has private id field — use memcpy to extract/inject
static uint64_t resIdToU64(const ResourceId &r) {
    uint64_t v;
    memcpy(&v, &r, sizeof(uint64_t));
    return v;
}
static ResourceId u64ToResId(uint64_t v) {
    ResourceId r;
    memcpy(&r, &v, sizeof(uint64_t));
    return r;
}

// ResultDetails::Message() is implemented in the DLL — provide our own
static std::string resultMessage(const ResultDetails &r) {
    if (r.internal_msg) return rdcToStr(*r.internal_msg);
    return "error code " + std::to_string((uint32_t)r.code);
}

// ResourceFormat::Name() calls RENDERDOC_ResourceFormatName in the DLL.
// Provide a basic string representation instead.
static std::string formatToStr(const ResourceFormat &f) {
    std::string s;
    if (f.compCount > 0) s += "R";
    if (f.compCount > 1) s += "G";
    if (f.compCount > 2) s += "B";
    if (f.compCount > 3) s += "A";
    s += std::to_string(f.compByteWidth * 8);
    switch(f.compType) {
        case CompType::Float:  s += "_FLOAT"; break;
        case CompType::UNorm:  s += "_UNORM"; break;
        case CompType::SNorm:  s += "_SNORM"; break;
        case CompType::UInt:   s += "_UINT"; break;
        case CompType::SInt:   s += "_SINT"; break;
        case CompType::Depth:  s += "_DEPTH"; break;
        default: break;
    }
    return s;
}

// Serialize ActionDescription tree to JSON (recursive)
static json actionToJson(const ActionDescription &a, const SDFile *sdfile) {
    json j;
    j["eventId"]  = a.eventId;
    j["actionId"] = a.actionId;

    // Prefer the human-readable name: customName for markers, chunk name for draws.
    std::string name;
    if (!a.customName.empty()) {
        name = rdcToStr(a.customName);
    } else if (sdfile && !a.events.empty()) {
        uint32_t chunkIndex = a.events.back().chunkIndex;
        if (chunkIndex < sdfile->chunks.size() && sdfile->chunks[chunkIndex]) {
            name = rdcToStr(sdfile->chunks[chunkIndex]->name) + "()";
        }
    }
    j["name"]  = name;
    j["flags"] = (uint32_t)a.flags;

    if (a.numIndices > 0)    j["numIndices"]   = a.numIndices;
    if (a.numInstances > 1)  j["numInstances"] = a.numInstances;

    if (!a.children.empty()) {
        json kids = json::array();
        for (size_t i = 0; i < a.children.size(); i++)
            kids.push_back(actionToJson(a.children[i], sdfile));
        j["children"] = std::move(kids);
    }
    return j;
}

// Look up a resource's display name (O(n) per call — callers should cache
// when looping over many ids).
static std::string resNameLookup(ResourceId rid) {
    if (rid == ResourceId() || !g_replay) return "";
    const rdcarray<ResourceDescription> &resources = g_replay->GetResources();
    for (size_t i = 0; i < resources.size(); i++) {
        if (resources[i].resourceId == rid) {
            return rdcToStr(resources[i].name);
        }
    }
    return "";
}

// Serialize ResourceDescription to JSON
static json resourceToJson(const ResourceDescription &r) {
    json j;
    j["resourceId"] = resIdToU64(r.resourceId);
    j["name"]       = rdcToStr(r.name);
    j["type"]       = (uint32_t)r.type;
    return j;
}

// Serialize TextureDescription to JSON
static json textureToJson(const TextureDescription &t) {
    json j;
    j["resourceId"] = resIdToU64(t.resourceId);
    j["width"]      = t.width;
    j["height"]     = t.height;
    j["depth"]      = t.depth;
    j["mips"]       = t.mips;
    j["arraysize"]  = t.arraysize;
    j["format"]     = formatToStr(t.format);
    j["dimension"]  = (uint32_t)t.dimension;
    j["type"]       = (uint32_t)t.type;
    return j;
}

// ── Command handlers ────────────────────────────────────────────────────────

static json handleInit(int id, const json &params) {
    std::string rdocPath = params.value("renderdocPath", "");
    if (rdocPath.empty())
        return makeError(id, -1, "renderdocPath is required");

#ifdef _WIN32
    // Point the Windows DLL loader at the RenderDoc install dir BEFORE
    // loading renderdoc.dll. The replay backends (GLES, Vulkan, etc.) live
    // next to renderdoc.dll and in its plugins/ subfolder. Without this,
    // OpenCapture can hang for minutes searching for missing dependencies.
    {
        std::wstring wpath(rdocPath.begin(), rdocPath.end());
        SetDllDirectoryW(wpath.c_str());
        // Also chdir so any relative-path lookups (plugins/<api>/...) work.
        SetCurrentDirectoryW(wpath.c_str());
    }
#endif

    if (!g_dll.load(rdocPath))
        return makeError(id, -2, "Failed to load renderdoc.dll from: " + rdocPath);

    // Initialize the replay system
    GlobalEnvironment env = {};
    rdcarray<rdcstr> args;
    g_dll.InitialiseReplay(env, args);
    g_replayInit = true;

    const char *ver = g_dll.GetVersionString();
    json result;
    result["version"] = ver ? ver : "unknown";
    if (g_dll.GetCommitHash) {
        const char *hash = g_dll.GetCommitHash();
        if (hash) result["commitHash"] = hash;
    }
    return makeResult(id, result);
}

static json handleGetVersion(int id) {
    if (!g_dll.isLoaded())
        return makeError(id, -1, "DLL not loaded. Call init first.");
    const char *ver = g_dll.GetVersionString();
    return makeResult(id, {{"version", ver ? ver : "unknown"}});
}

static json handleOpenCapture(int id, const json &params) {
    if (!g_dll.isLoaded())
        return makeError(id, -1, "DLL not loaded. Call init first.");

    std::string path = params.value("path", "");
    if (path.empty())
        return makeError(id, -2, "path is required");

    // Close previous capture if any. The overlay output is owned by the
    // replay controller, so Shutdown() tears it down — just null our cache.
    g_overlayOut = nullptr; g_overlayW = 0; g_overlayH = 0;
    if (g_replay) { g_replay->Shutdown(); g_replay = nullptr; }
    if (g_capFile) { g_capFile->Shutdown(); g_capFile = nullptr; }

    g_capFile = g_dll.OpenCaptureFile();
    if (!g_capFile)
        return makeError(id, -3, "RENDERDOC_OpenCaptureFile returned null");

    rdcstr filename(path.c_str());
    rdcstr filetype;  // empty = auto-detect
    fprintf(stderr, "[bridge] OpenFile: %s\n", path.c_str());
    ResultDetails openResult = g_capFile->OpenFile(filename, filetype, nullptr);
    fprintf(stderr, "[bridge] OpenFile result: %d\n", (int)openResult.code);
    if (openResult.code != ResultCode::Succeeded) {
        std::string msg = "OpenFile failed: " + resultMessage(openResult);
        g_capFile->Shutdown();
        g_capFile = nullptr;
        return makeError(id, -4, msg);
    }

    // Check local replay support first
    fprintf(stderr, "[bridge] Checking LocalReplaySupport...\n");
    ReplaySupport localSupport = g_capFile->LocalReplaySupport();
    fprintf(stderr, "[bridge] LocalReplaySupport: %d\n", (int)localSupport);

    if (localSupport == ReplaySupport::Unsupported) {
        // Truly unsupported — return file info without replay
        json result;
        result["path"]   = path;
        result["driver"] = rdcToStr(g_capFile->DriverName());
        result["replay"] = false;
        result["replayError"] = "Replay completely unsupported for this capture.";
        return makeResult(id, result);
    }

    if (localSupport == ReplaySupport::SuggestRemote) {
        // Different OS (e.g. Android capture on Windows desktop).
        // Don't auto-replay — it can crash the driver. Let user explicitly trigger tryReplay.
        json result;
        result["path"]   = path;
        result["driver"] = rdcToStr(g_capFile->DriverName());
        result["replay"] = false;
        result["suggestRemote"]  = true;
        result["canTryReplay"]   = true;
        result["replayMessage"]  = "This capture was made on a different OS. "
                                   "Local replay may work but could be unstable. "
                                   "Use 'Try Local Replay' to attempt it.";
        return makeResult(id, result);
    }

    // LocalReplaySupport == Supported.
    //
    // Do NOT auto-open the replay here. Re-opening a capture after tearing
    // down a previous replay can crash some backends (notably GL/ANGLE on
    // Windows when the first capture was Android GLES). Return capture info
    // with canTryReplay=true and let the TS layer explicitly invoke
    // `tryReplay` — that path is wrapped in a crash handler.
    fprintf(stderr, "[bridge] LocalReplaySupport==Supported; deferring OpenCapture to explicit tryReplay.\n");

    json result;
    result["path"]   = path;
    result["driver"] = rdcToStr(g_capFile->DriverName());
    result["replay"] = false;
    result["canTryReplay"] = true;
    result["replayMessage"] = "Capture is supported locally. Use 'Try Local Replay' to start the replay.";
    return makeResult(id, result);
}

static json handleCloseCapture(int id) {
    g_overlayOut = nullptr; g_overlayW = 0; g_overlayH = 0;
    if (g_replay) { g_replay->Shutdown(); g_replay = nullptr; }
    if (g_capFile) { g_capFile->Shutdown(); g_capFile = nullptr; }
    return makeResult(id, {{"closed", true}});
}

// Explicitly try local replay for SuggestRemote captures (user-initiated).
// If OpenCapture crashes (e.g. GLES on desktop), we override the crash handler
// to exit silently instead of showing RenderDoc's Bug Reporter dialog.
static json handleTryReplay(int id) {
    if (!g_capFile)
        return makeError(id, -1, "No capture file loaded. Call openCapture first.");
    if (g_replay)
        return makeResult(id, {{"replay", true}, {"message", "Replay already active."}});

    ReplayOptions opts;
    opts.apiValidation = false;
    fprintf(stderr, "[bridge] tryReplay: attempting local replay...\n");

#ifdef _WIN32
    // Override RenderDoc's crash handler to prevent Bug Reporter dialog.
    // If OpenCapture crashes, the process exits with code 0xDEAD instead.
    SetUnhandledExceptionFilter([](PEXCEPTION_POINTERS) -> LONG {
        fprintf(stderr, "[bridge] tryReplay crashed (access violation). Exiting silently.\n");
        fflush(stderr);
        TerminateProcess(GetCurrentProcess(), 0xDEAD);
        return EXCEPTION_EXECUTE_HANDLER;
    });
#endif

    // Emit periodic progress notifications so the TS side can drive a
    // progress bar while OpenCapture crunches. RenderDoc calls this
    // callback from its replay-worker thread, so we emit at most ~20 fps
    // and only when the value changes meaningfully (>=1%). The notification
    // has no `id` field; the TS dispatcher treats such messages as events.
    auto lastEmitNs = std::chrono::steady_clock::now();
    float lastProgress = -1.0f;
    std::atomic<float> sharedProgress{0.0f};
    std::atomic<bool>  openCaptureDone{false};
    RENDERDOC_ProgressCallback progressCb = [&](float p) {
        sharedProgress.store(p, std::memory_order_relaxed);
        auto now = std::chrono::steady_clock::now();
        auto sinceMs = std::chrono::duration_cast<std::chrono::milliseconds>(now - lastEmitNs).count();
        if (sinceMs < 50 && std::abs(p - lastProgress) < 0.01f) return;
        lastEmitNs = now;
        lastProgress = p;
        fprintf(stderr, "[bridge] OpenCapture progress: %.3f\n", p);
        fflush(stderr);
        json note = {
            {"method", "tryReplayProgress"},
            {"params", {{"progress", p}}},
        };
        writeJsonLine(note);
    };

    // Watchdog: RenderDoc's ProgressCallback is not monotonic and for some
    // phases (e.g. shader compilation) it can be silent for tens of seconds.
    // Print a heartbeat every 5s with the last-seen progress value so the
    // user can tell we're alive and waiting for renderdoc.dll, rather than
    // the bridge being hung on our side.
    std::thread watchdog([&]() {
        auto start = std::chrono::steady_clock::now();
        while (!openCaptureDone.load(std::memory_order_acquire)) {
            std::this_thread::sleep_for(std::chrono::seconds(5));
            if (openCaptureDone.load(std::memory_order_acquire)) break;
            auto secs = std::chrono::duration_cast<std::chrono::seconds>(
                std::chrono::steady_clock::now() - start).count();
            fprintf(stderr,
                "[bridge] OpenCapture still running: elapsed=%llds, lastProgress=%.3f\n",
                (long long)secs, sharedProgress.load(std::memory_order_relaxed));
            fflush(stderr);
        }
    });

    fprintf(stderr, "[bridge] Calling g_capFile->OpenCapture() ...\n");
    fflush(stderr);

    rdcpair<ResultDetails, IReplayController *> replayResult =
        g_capFile->OpenCapture(opts, progressCb);

    openCaptureDone.store(true, std::memory_order_release);
    if (watchdog.joinable()) watchdog.join();

    fprintf(stderr, "[bridge] OpenCapture() returned, code=%d\n", (int)replayResult.first.code);
    fflush(stderr);

    if (replayResult.first.code != ResultCode::Succeeded) {
        fprintf(stderr, "[bridge] tryReplay failed: code=%d\n", (int)replayResult.first.code);
        json result;
        result["replay"] = false;
        result["replayError"] = "OpenCapture failed with code " + std::to_string((int)replayResult.first.code);
        return makeResult(id, result);
    }

    g_replay = replayResult.second;
    fprintf(stderr, "[bridge] tryReplay succeeded!\n");
    return makeResult(id, {{"replay", true}});
}

static json handleSetFrameEvent(int id, const json &params) {
    if (!g_replay)
        return makeError(id, -1, "No replay active");
    uint32_t eventId = params.value("eventId", (uint32_t)0);
    bool force = params.value("force", false);
    g_replay->SetFrameEvent(eventId, force);
    return makeResult(id, {{"eventId", eventId}});
}

static json handleGetRootActions(int id) {
    if (!g_replay)
        return makeError(id, -1, "No replay active");

    const rdcarray<ActionDescription> &actions = g_replay->GetRootActions();
    const SDFile &sdfile = g_replay->GetStructuredFile();
    json arr = json::array();
    for (size_t i = 0; i < actions.size(); i++)
        arr.push_back(actionToJson(actions[i], &sdfile));

    return makeResult(id, {{"actions", arr}, {"count", actions.size()}});
}

static json handleGetResources(int id) {
    if (!g_replay)
        return makeError(id, -1, "No replay active");

    const rdcarray<ResourceDescription> &resources = g_replay->GetResources();
    json arr = json::array();
    for (size_t i = 0; i < resources.size(); i++)
        arr.push_back(resourceToJson(resources[i]));

    return makeResult(id, {{"resources", arr}, {"count", resources.size()}});
}

static json handleGetTextures(int id) {
    if (!g_replay)
        return makeError(id, -1, "No replay active");

    const rdcarray<TextureDescription> &textures = g_replay->GetTextures();
    json arr = json::array();
    for (size_t i = 0; i < textures.size(); i++)
        arr.push_back(textureToJson(textures[i]));

    return makeResult(id, {{"textures", arr}, {"count", textures.size()}});
}

static json handleGetDisassemblyTargets(int id) {
    if (!g_replay)
        return makeError(id, -1, "No replay active");

    rdcarray<rdcstr> targets = g_replay->GetDisassemblyTargets(true);
    json arr = json::array();
    for (size_t i = 0; i < targets.size(); i++)
        arr.push_back(rdcToStr(targets[i]));

    return makeResult(id, {{"targets", arr}});
}

static json handleGetShaderEntryPoints(int id, const json &params) {
    if (!g_replay)
        return makeError(id, -1, "No replay active");

    uint64_t rid = params.value("resourceId", (uint64_t)0);
    ResourceId resId = u64ToResId(rid);

    rdcarray<ShaderEntryPoint> entries = g_replay->GetShaderEntryPoints(resId);
    json arr = json::array();
    for (size_t i = 0; i < entries.size(); i++) {
        arr.push_back({
            {"name", rdcToStr(entries[i].name)},
            {"stage", (uint32_t)entries[i].stage}
        });
    }
    return makeResult(id, {{"entryPoints", arr}});
}

static json handleGetShaderSource(int id, const json &params) {
    if (!g_replay)
        return makeError(id, -1, "No replay active");

    uint64_t rid = params.value("resourceId", (uint64_t)0);
    uint64_t pipelineId = params.value("pipelineId", (uint64_t)0);
    std::string entryName = params.value("entryPoint", "");
    uint32_t stageInt = params.value("stage", (uint32_t)0);
    std::string target = params.value("target", "");

    ResourceId resId = u64ToResId(rid);
    ResourceId pipeline = u64ToResId(pipelineId);

    ShaderEntryPoint ep;
    ep.name = entryName.c_str();
    ep.stage = (ShaderStage)stageInt;

    // Get the shader reflection (pipeline, shader, entry)
    const ShaderReflection *refl = g_replay->GetShader(pipeline, resId, ep);
    if (!refl)
        return makeError(id, -2, "GetShader returned null");

    json result;
    result["entryPoint"] = rdcToStr(refl->entryPoint);
    result["stage"]      = (uint32_t)refl->stage;

    // If a disassembly target was specified, get the disassembly
    if (!target.empty()) {
        rdcstr tgt(target.c_str());
        rdcstr disasm = g_replay->DisassembleShader(resId, refl, tgt);
        result["disassembly"] = rdcToStr(disasm);
    }

    // Include raw source if available in reflection
    if (!refl->rawBytes.empty()) {
        result["hasRawBytes"] = true;
        result["rawBytesSize"] = (uint64_t)refl->rawBytes.size();
    }

    // Include debug info
    if (!refl->debugInfo.files.empty()) {
        json files = json::array();
        for (size_t i = 0; i < refl->debugInfo.files.size(); i++) {
            files.push_back({
                {"filename", rdcToStr(refl->debugInfo.files[i].filename)},
                {"contents", rdcToStr(refl->debugInfo.files[i].contents)}
            });
        }
        result["sourceFiles"] = files;
    }

    return makeResult(id, result);
}

// High-level: SetFrameEvent → GetPipelineState → GetShader for all bound stages
// Returns shader source for each active stage at a given draw call event.
static json handleGetShaderSourceForEvent(int id, const json &params) {
    if (!g_replay)
        return makeError(id, -1, "No replay active");

    uint32_t eventId = params.value("eventId", (uint32_t)0);
    std::string targetDisasm = params.value("target", "");

    fprintf(stderr, "[bridge] getShaderSourceForEvent: eventId=%u\n", eventId);

    // 1. Set the frame event
    g_replay->SetFrameEvent(eventId, true);

    // 2. Get pipeline state to find bound shaders
    struct StageInfo {
        const char *name;
        ResourceId resourceId;
        ShaderStage stage;
    };
    std::vector<StageInfo> stages;

    const auto *gl = g_replay->GetGLPipelineState();
    if (gl) {
        // On GLES the shader object may be null (monolithic program); fall
        // back to programResourceId in that case so GetShader() still works.
        auto pickGL = [](const GLPipe::Shader &s) -> ResourceId {
            return s.shaderResourceId != ResourceId() ? s.shaderResourceId : s.programResourceId;
        };
        if (pickGL(gl->vertexShader) != ResourceId())
            stages.push_back({"vertex", pickGL(gl->vertexShader), ShaderStage::Vertex});
        if (pickGL(gl->fragmentShader) != ResourceId())
            stages.push_back({"fragment", pickGL(gl->fragmentShader), ShaderStage::Pixel});
        if (pickGL(gl->geometryShader) != ResourceId())
            stages.push_back({"geometry", pickGL(gl->geometryShader), ShaderStage::Geometry});
        if (pickGL(gl->tessControlShader) != ResourceId())
            stages.push_back({"tessControl", pickGL(gl->tessControlShader), ShaderStage::Hull});
        if (pickGL(gl->tessEvalShader) != ResourceId())
            stages.push_back({"tessEval", pickGL(gl->tessEvalShader), ShaderStage::Domain});
        if (pickGL(gl->computeShader) != ResourceId())
            stages.push_back({"compute", pickGL(gl->computeShader), ShaderStage::Compute});
    }
    const auto *vk = g_replay->GetVulkanPipelineState();
    if (vk) {
        if (vk->vertexShader.resourceId != ResourceId())
            stages.push_back({"vertex", vk->vertexShader.resourceId, ShaderStage::Vertex});
        if (vk->fragmentShader.resourceId != ResourceId())
            stages.push_back({"fragment", vk->fragmentShader.resourceId, ShaderStage::Pixel});
        if (vk->geometryShader.resourceId != ResourceId())
            stages.push_back({"geometry", vk->geometryShader.resourceId, ShaderStage::Geometry});
        if (vk->tessControlShader.resourceId != ResourceId())
            stages.push_back({"tessControl", vk->tessControlShader.resourceId, ShaderStage::Hull});
        if (vk->tessEvalShader.resourceId != ResourceId())
            stages.push_back({"tessEval", vk->tessEvalShader.resourceId, ShaderStage::Domain});
        if (vk->computeShader.resourceId != ResourceId())
            stages.push_back({"compute", vk->computeShader.resourceId, ShaderStage::Compute});
    }
    const auto *d11 = g_replay->GetD3D11PipelineState();
    if (d11) {
        if (d11->vertexShader.resourceId != ResourceId())
            stages.push_back({"vertex", d11->vertexShader.resourceId, ShaderStage::Vertex});
        if (d11->pixelShader.resourceId != ResourceId())
            stages.push_back({"pixel", d11->pixelShader.resourceId, ShaderStage::Pixel});
        if (d11->geometryShader.resourceId != ResourceId())
            stages.push_back({"geometry", d11->geometryShader.resourceId, ShaderStage::Geometry});
        if (d11->hullShader.resourceId != ResourceId())
            stages.push_back({"hull", d11->hullShader.resourceId, ShaderStage::Hull});
        if (d11->domainShader.resourceId != ResourceId())
            stages.push_back({"domain", d11->domainShader.resourceId, ShaderStage::Domain});
        if (d11->computeShader.resourceId != ResourceId())
            stages.push_back({"compute", d11->computeShader.resourceId, ShaderStage::Compute});
    }
    const auto *d12 = g_replay->GetD3D12PipelineState();
    if (d12) {
        if (d12->vertexShader.resourceId != ResourceId())
            stages.push_back({"vertex", d12->vertexShader.resourceId, ShaderStage::Vertex});
        if (d12->pixelShader.resourceId != ResourceId())
            stages.push_back({"pixel", d12->pixelShader.resourceId, ShaderStage::Pixel});
        if (d12->geometryShader.resourceId != ResourceId())
            stages.push_back({"geometry", d12->geometryShader.resourceId, ShaderStage::Geometry});
        if (d12->hullShader.resourceId != ResourceId())
            stages.push_back({"hull", d12->hullShader.resourceId, ShaderStage::Hull});
        if (d12->domainShader.resourceId != ResourceId())
            stages.push_back({"domain", d12->domainShader.resourceId, ShaderStage::Domain});
        if (d12->computeShader.resourceId != ResourceId())
            stages.push_back({"compute", d12->computeShader.resourceId, ShaderStage::Compute});
    }

    if (stages.empty())
        return makeError(id, -2, "No shaders bound at this event");

    // 3. For each stage, get shader reflection and source
    json result;
    json shaderSources = json::object();

    // Find pipeline ID (needed for GetShader)
    ResourceId pipelineId;
    if (gl)  pipelineId = gl->pipelineResourceId;
    // Vulkan/D3D pipelines — use default ResourceId (works for most APIs)

    for (auto &si : stages) {
        ShaderEntryPoint ep;
        ep.name = "main";
        ep.stage = si.stage;

        const ShaderReflection *refl = g_replay->GetShader(pipelineId, si.resourceId, ep);
        if (!refl) {
            fprintf(stderr, "[bridge] GetShader returned null for stage %s\n", si.name);
            continue;
        }

        json stageResult;
        stageResult["resourceId"] = resIdToU64(si.resourceId);
        stageResult["name"] = resNameLookup(si.resourceId);
        stageResult["entryPoint"] = rdcToStr(refl->entryPoint);

        // Mirror RenderDoc desktop: expose every source file as its own tab
        // instead of concatenating, and mark which file is the entry point.
        // files[0] is always the entry file per the API contract; editBaseFile
        // may override, and LineColumnInfo::fileIndex is another fallback.
        const ShaderDebugInfo &dbg = refl->debugInfo;
        int32_t entryFile = -1;
        if (!dbg.files.empty()) {
            if (dbg.editBaseFile >= 0 && (size_t)dbg.editBaseFile < dbg.files.size())
                entryFile = dbg.editBaseFile;
            else if (dbg.entryLocation.fileIndex >= 0 &&
                     (size_t)dbg.entryLocation.fileIndex < dbg.files.size())
                entryFile = dbg.entryLocation.fileIndex;
            else
                entryFile = 0;

            json files = json::array();
            for (size_t i = 0; i < dbg.files.size(); i++) {
                files.push_back({
                    {"filename", rdcToStr(dbg.files[i].filename)},
                    {"contents", rdcToStr(dbg.files[i].contents)}
                });
            }
            stageResult["sourceFiles"] = files;
            stageResult["entryFileIndex"] = entryFile;
            // Back-compat `source` field: return ONLY the entry file (matches
            // RenderDoc's default tab) instead of a concat of everything.
            stageResult["source"] = rdcToStr(dbg.files[entryFile].contents);
            stageResult["sourceEncoding"] = (uint32_t)dbg.encoding;
        }

        // Disassembly: pick a target that matches what RenderDoc's UI shows
        // by default for this API, instead of blindly taking targets[0].
        if (entryFile < 0 || !targetDisasm.empty()) {
            rdcarray<rdcstr> targets = g_replay->GetDisassemblyTargets(true);
            rdcstr tgt;
            if (!targetDisasm.empty()) {
                tgt = targetDisasm.c_str();
            } else if (!targets.empty()) {
                // Preferred default per API — matches the initial selection
                // in the RenderDoc Shader Viewer dropdown.
                const char *preferred[] = {
                    // Pick in order: if the capture API had GLSL source then
                    // disassembly isn't usually shown as default; otherwise:
                    gl  ? "GLSL" :
                    vk  ? "SPIR-V (RenderDoc)" :
                    d11 ? "DXBC" :
                    d12 ? "DXIL" : "",
                    // Vulkan sometimes advertises plain "SPIR-V".
                    vk  ? "SPIR-V" : "",
                    // Generic fallback list — first match wins.
                    "GLSL", "DXIL", "DXBC", "SPIR-V"
                };
                for (const char *p : preferred) {
                    if (!p || !*p) continue;
                    for (size_t i = 0; i < targets.size(); i++) {
                        if (targets[i] == p) { tgt = targets[i]; break; }
                    }
                    if (!tgt.empty()) break;
                }
                if (tgt.empty()) tgt = targets[0];
            }
            if (!tgt.empty()) {
                rdcstr disasm = g_replay->DisassembleShader(si.resourceId, refl, tgt);
                std::string disasmStr = rdcToStr(disasm);
                if (!disasmStr.empty()) {
                    stageResult["disassembly"] = disasmStr;
                    stageResult["disassemblyTarget"] = rdcToStr(tgt);
                    if (entryFile < 0) {
                        // No sources at all — surface the disassembly in the
                        // `source` field so existing UI paths keep working.
                        stageResult["source"] = disasmStr;
                    }
                }
                // Also expose the list of targets so the UI can offer a dropdown.
                json tgtList = json::array();
                for (size_t i = 0; i < targets.size(); i++)
                    tgtList.push_back(rdcToStr(targets[i]));
                stageResult["disassemblyTargets"] = tgtList;
            }
        }

        shaderSources[si.name] = stageResult;
    }

    result["eventId"] = eventId;
    result["shaders"] = shaderSources;
    return makeResult(id, result);
}

// Find the maximum eventId in the action tree (recursive)
static uint32_t findMaxEventId(const rdcarray<ActionDescription> &actions) {
    uint32_t maxId = 0;
    for (size_t i = 0; i < actions.size(); i++) {
        if (actions[i].eventId > maxId) maxId = actions[i].eventId;
        if (!actions[i].children.empty()) {
            uint32_t childMax = findMaxEventId(actions[i].children);
            if (childMax > maxId) maxId = childMax;
        }
    }
    return maxId;
}

// High-level: Save texture to temp file and return base64-encoded image data
// Base64-encode a byte buffer
static std::string base64Encode(const std::vector<uint8_t> &data) {
    static const char b64chars[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    out.reserve((data.size() + 2) / 3 * 4);
    for (size_t i = 0; i < data.size(); i += 3) {
        uint32_t n = (uint32_t)data[i] << 16;
        if (i + 1 < data.size()) n |= (uint32_t)data[i+1] << 8;
        if (i + 2 < data.size()) n |= (uint32_t)data[i+2];
        out += b64chars[(n >> 18) & 0x3F];
        out += b64chars[(n >> 12) & 0x3F];
        out += (i + 1 < data.size()) ? b64chars[(n >> 6) & 0x3F] : '=';
        out += (i + 2 < data.size()) ? b64chars[n & 0x3F] : '=';
    }
    return out;
}

// Read a file into a byte vector
static std::vector<uint8_t> readFileBytes(const std::string &path) {
    std::ifstream f(path, std::ios::binary);
    if (!f.is_open()) return {};
    return std::vector<uint8_t>((std::istreambuf_iterator<char>(f)),
                                 std::istreambuf_iterator<char>());
}

// Known 2D ASTC block sizes (blockW, blockH)
static const int astcBlockSizes[][2] = {
    {4,4},{5,4},{5,5},{6,5},{6,6},{8,5},{8,6},{8,8},
    {10,5},{10,6},{10,8},{10,10},{12,10},{12,12}
};

// Deduce ASTC block dimensions from raw data size and texture dimensions
static bool deduceASTCBlockSize(size_t dataSize, uint32_t w, uint32_t h,
                                 int &outBW, int &outBH) {
    for (auto &bs : astcBlockSizes) {
        int bw = bs[0], bh = bs[1];
        size_t blocksX = (w + bw - 1) / bw;
        size_t blocksY = (h + bh - 1) / bh;
        if (blocksX * blocksY * 16 == dataSize) {
            outBW = bw; outBH = bh;
            return true;
        }
    }
    return false;
}

// Decompress an entire ASTC LDR texture into an RGBA8 buffer.
// Returns true on success. `rgbaOut` will be resized to w*h*4 bytes.
static bool decompressASTCNative(const uint8_t *blockData, size_t dataSize,
                                  uint32_t w, uint32_t h,
                                  int blockW, int blockH,
                                  bool isSRGB,
                                  std::vector<uint8_t> &rgbaOut) {
    const uint32_t blocksX = (w + blockW - 1) / blockW;
    const uint32_t blocksY = (h + blockH - 1) / blockH;
    if (blocksX * blocksY * 16 != dataSize) {
        fprintf(stderr, "[bridge] ASTC: data size mismatch (expected %u, got %zu)\n",
                blocksX * blocksY * 16, dataSize);
        return false;
    }

    rgbaOut.assign((size_t)w * h * 4, 0);
    std::vector<uint8_t> blockPixels((size_t)blockW * blockH * 4);

    const uint8_t *src = blockData;
    for (uint32_t by = 0; by < blocksY; by++) {
        for (uint32_t bx = 0; bx < blocksX; bx++, src += 16) {
            if (!basisu::astc::decompress(blockPixels.data(), src, isSRGB, blockW, blockH)) {
                // Block decode failed — leave as black+opaque for that block
                std::fill(blockPixels.begin(), blockPixels.end(), (uint8_t)0);
                for (int i = 3; i < (int)blockPixels.size(); i += 4) blockPixels[i] = 255;
            }

            // Copy block pixels into the full image (clamped to image bounds)
            for (int py = 0; py < blockH; py++) {
                uint32_t iy = by * blockH + py;
                if (iy >= h) break;
                for (int px = 0; px < blockW; px++) {
                    uint32_t ix = bx * blockW + px;
                    if (ix >= w) break;
                    const uint8_t *s = &blockPixels[(py * blockW + px) * 4];
                    uint8_t *d = &rgbaOut[((size_t)iy * w + ix) * 4];
                    d[0] = s[0]; d[1] = s[1]; d[2] = s[2]; d[3] = s[3];
                }
            }
        }
    }
    return true;
}

// stb_image_write callback — append bytes to a std::vector<uint8_t>
static void stbiWriteToVector(void *ctx, void *data, int size) {
    auto *v = (std::vector<uint8_t> *)ctx;
    v->insert(v->end(), (uint8_t *)data, (uint8_t *)data + size);
}

// Encode RGBA8 pixels as PNG into a memory buffer
static bool encodePNGToMemory(const std::vector<uint8_t> &rgba, uint32_t w, uint32_t h,
                               std::vector<uint8_t> &pngOut) {
    pngOut.clear();
    int stride = (int)(w * 4);
    return stbi_write_png_to_func(stbiWriteToVector, &pngOut,
                                   (int)w, (int)h, 4, rgba.data(), stride) != 0;
}

static json handleGetTexturePreview(int id, const json &params) {
    if (!g_replay)
        return makeError(id, -1, "No replay active");

    uint64_t rid = params.value("resourceId", (uint64_t)0);
    uint32_t mip = params.value("mip", (uint32_t)0);
    uint32_t eventId = params.value("eventId", (uint32_t)0);
    int channelExtract = params.value("channelExtract", -1);  // -1=all, 0=R, 1=G, 2=B, 3=A

    ResourceId resId = u64ToResId(rid);
    fprintf(stderr, "[bridge] getTexturePreview: resourceId=%llu mip=%u eventId=%u\n", rid, mip, eventId);

    // Set the frame event so that textures have their rendered content.
    if (eventId == 0) {
        const rdcarray<ActionDescription> &actions = g_replay->GetRootActions();
        eventId = findMaxEventId(actions);
    }
    if (eventId > 0) {
        fprintf(stderr, "[bridge] Setting frame event to %u for texture preview\n", eventId);
        g_replay->SetFrameEvent(eventId, true);
    }

    // Get texture info
    const rdcarray<TextureDescription> &textures = g_replay->GetTextures();
    uint32_t width = 0, height = 0;
    uint32_t compCount = 0;
    ResourceFormatType fmtType = ResourceFormatType::Undefined;
    std::string format;
    for (size_t i = 0; i < textures.size(); i++) {
        if (textures[i].resourceId == resId) {
            width = textures[i].width;
            height = textures[i].height;
            compCount = textures[i].format.compCount;
            fmtType = textures[i].format.type;
            format = formatToStr(textures[i].format);
            break;
        }
    }

    std::vector<uint8_t> pngData;
    bool usedASTCFallback = false;

    // ASTC: ANGLE D3D11 backend can't sample ASTC textures, so SaveTexture
    // returns all-black output. Use software decompression instead.
    if (fmtType == ResourceFormatType::ASTC && width > 0 && height > 0) {
        fprintf(stderr, "[bridge] ASTC texture detected, using native software decompression\n");

        Subresource sub;
        sub.mip = mip;
        sub.slice = 0;
        sub.sample = 0;
        bytebuf rawData = g_replay->GetTextureData(resId, sub);

        if (!rawData.empty()) {
            int blockW = 0, blockH = 0;
            if (deduceASTCBlockSize(rawData.size(), width, height, blockW, blockH)) {
                std::vector<uint8_t> rgba;
                // sRGB flag: match source format's sRGB-ness for correct endpoint scaling
                bool isSRGB = false;
                for (size_t i = 0; i < textures.size(); i++) {
                    if (textures[i].resourceId == resId) {
                        isSRGB = (textures[i].format.compType == CompType::UNormSRGB);
                        break;
                    }
                }
                if (decompressASTCNative(rawData.data(), rawData.size(),
                                          width, height, blockW, blockH,
                                          isSRGB, rgba)) {
                    if (encodePNGToMemory(rgba, width, height, pngData)) {
                        usedASTCFallback = true;
                        fprintf(stderr, "[bridge] ASTC decoded: %ux%u block=%dx%d srgb=%d\n",
                                width, height, blockW, blockH, isSRGB);
                    }
                }
            } else {
                fprintf(stderr, "[bridge] Could not deduce ASTC block size from %zu bytes for %ux%u\n",
                        rawData.size(), width, height);
            }
        } else {
            fprintf(stderr, "[bridge] GetTextureData returned empty for ASTC texture\n");
        }
    }

    // Standard path: use SaveTexture (works for non-ASTC formats)
    if (!usedASTCFallback) {
        std::string tmpPath = std::filesystem::temp_directory_path().string() + "/rdctex_" + std::to_string(rid) + ".png";

        TextureSave save;
        save.resourceId = resId;
        save.destType = FileType::PNG;
        save.mip = mip;
        save.slice.sliceIndex = 0;
        save.comp.blackPoint = 0.0f;
        save.comp.whitePoint = 1.0f;
        save.alpha = AlphaMapping::Preserve;
        save.channelExtract = channelExtract;

        rdcstr outPath(tmpPath.c_str());
        fprintf(stderr, "[bridge] SaveTexture: %ux%u fmt=%s -> %s\n", width, height, format.c_str(), tmpPath.c_str());
        ResultDetails saveResult = g_replay->SaveTexture(save, outPath);

        if (saveResult.code != ResultCode::Succeeded)
            return makeError(id, -3, "SaveTexture failed: " + resultMessage(saveResult));

        pngData = readFileBytes(tmpPath);
        std::filesystem::remove(tmpPath);
    }

    if (pngData.empty())
        return makeError(id, -5, "Texture data is empty");

    fprintf(stderr, "[bridge] Texture ready: %zu bytes PNG, %ux%u, fmt=%s, astcFallback=%d\n",
            pngData.size(), width, height, format.c_str(), usedASTCFallback);

    std::string base64 = base64Encode(pngData);

    json result;
    result["base64"] = base64;
    result["format"] = "png";
    result["width"] = width;
    result["height"] = height;
    result["texFormat"] = format;
    result["size"] = pngData.size();
    result["compCount"] = compCount;
    return makeResult(id, result);
}

static json handleSaveTexture(int id, const json &params) {
    if (!g_replay)
        return makeError(id, -1, "No replay active");

    uint64_t rid = params.value("resourceId", (uint64_t)0);
    std::string outputPath = params.value("outputPath", "");
    uint32_t fileTypeInt = params.value("fileType", (uint32_t)FileType::PNG);

    if (outputPath.empty())
        return makeError(id, -2, "outputPath is required");

    ResourceId resId = u64ToResId(rid);

    TextureSave save;
    save.resourceId = resId;
    save.destType = (FileType)fileTypeInt;
    save.mip = params.value("mip", -1);
    save.slice.sliceIndex = params.value("slice", -1);

    rdcstr outPath(outputPath.c_str());
    ResultDetails result = g_replay->SaveTexture(save, outPath);

    if (result.code != ResultCode::Succeeded)
        return makeError(id, -3, "SaveTexture failed: " + resultMessage(result));

    return makeResult(id, {{"path", outputPath}, {"saved", true}});
}

static json handleGetPipelineState(int id, const json &params) {
    if (!g_replay)
        return makeError(id, -1, "No replay active");

    uint32_t eventId = params.value("eventId", (uint32_t)0);
    if (eventId > 0) {
        g_replay->SetFrameEvent(eventId, true);
    }

    json result;
    json shaders = json::object();

    // Use API-specific pipeline state getters to avoid PipeState helper methods
    // (those are implemented in the DLL and we can't link to them)
    auto addShader = [&](const char *name, ResourceId resId, ShaderStage stage) {
        if (resId != ResourceId()) {
            shaders[name] = {
                {"resourceId", resIdToU64(resId)},
                {"name",       resNameLookup(resId)},
                {"stage", (uint32_t)stage}
            };
        }
    };

    // Collect framebuffer color/depth render targets so UI can scope "bound
    // textures at this draw" to actual render targets.
    json framebuffer = json::object();
    json colorTargets = json::array();
    uint64_t depthTarget = 0;
    uint64_t stencilTarget = 0;

    // Vertex input (index buffer + vertex buffers)
    json vertexInput = json::object();
    json vertexBuffers = json::array();
    uint64_t indexBuffer = 0;

    // Try each API
    const auto *gl = g_replay->GetGLPipelineState();
    if (gl) {
        result["api"] = "OpenGL";
        // On GLES, program-only pipelines may leave shaderResourceId empty;
        // fall back to programResourceId so the stage is reported as bound.
        auto pickGL = [](const GLPipe::Shader &s) -> ResourceId {
            return s.shaderResourceId != ResourceId() ? s.shaderResourceId : s.programResourceId;
        };
        addShader("vertex",   pickGL(gl->vertexShader),   ShaderStage::Vertex);
        addShader("tessCtrl", pickGL(gl->tessControlShader), ShaderStage::Hull);
        addShader("tessEval", pickGL(gl->tessEvalShader),  ShaderStage::Domain);
        addShader("geometry", pickGL(gl->geometryShader),  ShaderStage::Geometry);
        addShader("fragment", pickGL(gl->fragmentShader),  ShaderStage::Pixel);
        addShader("compute",  pickGL(gl->computeShader),   ShaderStage::Compute);

        for (const auto &att : gl->framebuffer.drawFBO.colorAttachments) {
            if (att.resource != ResourceId())
                colorTargets.push_back(resIdToU64(att.resource));
        }
        if (gl->framebuffer.drawFBO.depthAttachment.resource != ResourceId())
            depthTarget = resIdToU64(gl->framebuffer.drawFBO.depthAttachment.resource);
        if (gl->framebuffer.drawFBO.stencilAttachment.resource != ResourceId())
            stencilTarget = resIdToU64(gl->framebuffer.drawFBO.stencilAttachment.resource);

        if (gl->vertexInput.indexBuffer != ResourceId())
            indexBuffer = resIdToU64(gl->vertexInput.indexBuffer);
        for (const auto &vb : gl->vertexInput.vertexBuffers) {
            if (vb.resourceId != ResourceId()) {
                vertexBuffers.push_back({
                    {"resourceId", resIdToU64(vb.resourceId)},
                    {"stride", vb.byteStride},
                    {"offset", (uint64_t)vb.byteOffset},
                });
            }
        }
    }
    const auto *vk = g_replay->GetVulkanPipelineState();
    if (vk) {
        result["api"] = "Vulkan";
        addShader("vertex",   vk->vertexShader.resourceId,   ShaderStage::Vertex);
        addShader("tessCtrl", vk->tessControlShader.resourceId, ShaderStage::Hull);
        addShader("tessEval", vk->tessEvalShader.resourceId,  ShaderStage::Domain);
        addShader("geometry", vk->geometryShader.resourceId,  ShaderStage::Geometry);
        addShader("fragment", vk->fragmentShader.resourceId,  ShaderStage::Pixel);
        addShader("compute",  vk->computeShader.resourceId,   ShaderStage::Compute);

        for (const auto &att : vk->currentPass.framebuffer.attachments) {
            if (att.resource != ResourceId())
                colorTargets.push_back(resIdToU64(att.resource));
        }
        if (vk->inputAssembly.indexBuffer.resourceId != ResourceId())
            indexBuffer = resIdToU64(vk->inputAssembly.indexBuffer.resourceId);
        for (const auto &vb : vk->vertexInput.vertexBuffers) {
            if (vb.resourceId != ResourceId()) {
                vertexBuffers.push_back({
                    {"resourceId", resIdToU64(vb.resourceId)},
                    {"stride", vb.byteStride},
                    {"offset", (uint64_t)vb.byteOffset},
                });
            }
        }
    }
    const auto *d11 = g_replay->GetD3D11PipelineState();
    if (d11) {
        result["api"] = "D3D11";
        addShader("vertex",   d11->vertexShader.resourceId,   ShaderStage::Vertex);
        addShader("hull",     d11->hullShader.resourceId,     ShaderStage::Hull);
        addShader("domain",   d11->domainShader.resourceId,   ShaderStage::Domain);
        addShader("geometry", d11->geometryShader.resourceId,  ShaderStage::Geometry);
        addShader("pixel",    d11->pixelShader.resourceId,    ShaderStage::Pixel);
        addShader("compute",  d11->computeShader.resourceId,   ShaderStage::Compute);

        for (const auto &rt : d11->outputMerger.renderTargets) {
            if (rt.resource != ResourceId())
                colorTargets.push_back(resIdToU64(rt.resource));
        }
        if (d11->outputMerger.depthTarget.resource != ResourceId())
            depthTarget = resIdToU64(d11->outputMerger.depthTarget.resource);

        if (d11->inputAssembly.indexBuffer.resourceId != ResourceId())
            indexBuffer = resIdToU64(d11->inputAssembly.indexBuffer.resourceId);
        for (const auto &vb : d11->inputAssembly.vertexBuffers) {
            if (vb.resourceId != ResourceId()) {
                vertexBuffers.push_back({
                    {"resourceId", resIdToU64(vb.resourceId)},
                    {"stride", vb.byteStride},
                    {"offset", (uint64_t)vb.byteOffset},
                });
            }
        }
    }
    const auto *d12 = g_replay->GetD3D12PipelineState();
    if (d12) {
        result["api"] = "D3D12";
        addShader("vertex",   d12->vertexShader.resourceId,   ShaderStage::Vertex);
        addShader("hull",     d12->hullShader.resourceId,     ShaderStage::Hull);
        addShader("domain",   d12->domainShader.resourceId,   ShaderStage::Domain);
        addShader("geometry", d12->geometryShader.resourceId,  ShaderStage::Geometry);
        addShader("pixel",    d12->pixelShader.resourceId,    ShaderStage::Pixel);
        addShader("compute",  d12->computeShader.resourceId,   ShaderStage::Compute);

        for (const auto &rt : d12->outputMerger.renderTargets) {
            if (rt.resource != ResourceId())
                colorTargets.push_back(resIdToU64(rt.resource));
        }
        if (d12->outputMerger.depthTarget.resource != ResourceId())
            depthTarget = resIdToU64(d12->outputMerger.depthTarget.resource);

        if (d12->inputAssembly.indexBuffer.resourceId != ResourceId())
            indexBuffer = resIdToU64(d12->inputAssembly.indexBuffer.resourceId);
        for (const auto &vb : d12->inputAssembly.vertexBuffers) {
            if (vb.resourceId != ResourceId()) {
                vertexBuffers.push_back({
                    {"resourceId", resIdToU64(vb.resourceId)},
                    {"stride", vb.byteStride},
                    {"offset", (uint64_t)vb.byteOffset},
                });
            }
        }
    }

    framebuffer["colorTargets"] = colorTargets;
    if (depthTarget != 0)   framebuffer["depthTarget"]   = depthTarget;
    if (stencilTarget != 0) framebuffer["stencilTarget"] = stencilTarget;
    result["framebuffer"] = framebuffer;

    vertexInput["vertexBuffers"] = vertexBuffers;
    if (indexBuffer != 0) vertexInput["indexBuffer"] = indexBuffer;
    result["vertexInput"] = vertexInput;

    // Bound read-only textures (sampler bindings) at the current event.
    // Walks DescriptorAccess → GetDescriptors and filters image-type entries.
    json boundTextures = json::array();
    {
        const rdcarray<DescriptorAccess> &accesses = g_replay->GetDescriptorAccess();
        // Group ranges per descriptor store so we batch GetDescriptors calls.
        std::map<ResourceId, rdcarray<DescriptorRange>> storeRanges;
        std::map<ResourceId, std::vector<const DescriptorAccess *>> storeAccesses;
        for (size_t i = 0; i < accesses.size(); i++) {
            const DescriptorAccess &acc = accesses[i];
            if (acc.descriptorStore == ResourceId()) continue;
            // Only sampler-read image types
            if (acc.type != DescriptorType::Image &&
                acc.type != DescriptorType::ImageSampler &&
                acc.type != DescriptorType::TypedBuffer)
                continue;
            storeRanges[acc.descriptorStore].push_back(DescriptorRange(acc));
            storeAccesses[acc.descriptorStore].push_back(&acc);
        }
        std::set<uint64_t> seen;
        for (auto &kv : storeRanges) {
            rdcarray<Descriptor> descs = g_replay->GetDescriptors(kv.first, kv.second);
            for (size_t i = 0; i < descs.size(); i++) {
                const Descriptor &d = descs[i];
                if (d.resource == ResourceId()) continue;
                uint64_t rid = resIdToU64(d.resource);
                if (seen.count(rid)) continue;
                seen.insert(rid);
                boundTextures.push_back(rid);
            }
        }
    }
    result["boundTextures"] = boundTextures;

    result["shaders"] = shaders;
    return makeResult(id, result);
}

// ────────────────────────────────────────────────────────────────────────────
// Drawcall overlay — mirrors RenderDoc desktop's "Highlight Drawcall" feature.
// Renders the active color RT at `eventId` with DebugOverlay::Drawcall, reads
// the result back and returns it as a base64 PNG so the webview can display
// the draw call location on top of the scene.
// ────────────────────────────────────────────────────────────────────────────

// Return the first bound color render target ResourceId at the current event,
// or a default-constructed ResourceId() if nothing is bound.
static ResourceId getCurrentColorTargetId() {
    if (!g_replay) return ResourceId();

    const auto *gl = g_replay->GetGLPipelineState();
    if (gl) {
        for (const auto &att : gl->framebuffer.drawFBO.colorAttachments) {
            if (att.resource != ResourceId()) return att.resource;
        }
    }
    const auto *vk = g_replay->GetVulkanPipelineState();
    if (vk) {
        for (const auto &att : vk->currentPass.framebuffer.attachments) {
            if (att.resource != ResourceId()) return att.resource;
        }
    }
    const auto *d11 = g_replay->GetD3D11PipelineState();
    if (d11) {
        for (const auto &rt : d11->outputMerger.renderTargets) {
            if (rt.resource != ResourceId()) return rt.resource;
        }
    }
    const auto *d12 = g_replay->GetD3D12PipelineState();
    if (d12) {
        for (const auto &rt : d12->outputMerger.renderTargets) {
            if (rt.resource != ResourceId()) return rt.resource;
        }
    }
    return ResourceId();
}

static json handleGetDrawcallOverlay(int id, const json &params) {
    if (!g_replay)
        return makeError(id, -1, "No replay active");

    uint32_t eventId = params.value("eventId", (uint32_t)0);
    if (eventId == 0)
        return makeError(id, -2, "eventId is required");

    fprintf(stderr, "[bridge] getDrawcallOverlay: eventId=%u\n", eventId);

    // Seek to the requested event so pipeline state reflects the draw.
    g_replay->SetFrameEvent(eventId, true);

    // Locate the first bound color render target at this event.
    ResourceId rtId = getCurrentColorTargetId();
    if (rtId == ResourceId())
        return makeError(id, -3, "No color render target bound at this event");

    // Look up dimensions/samples of the RT.
    const rdcarray<TextureDescription> &textures = g_replay->GetTextures();
    uint32_t width = 0, height = 0;
    uint32_t samples = 1;
    for (size_t i = 0; i < textures.size(); i++) {
        if (textures[i].resourceId == rtId) {
            width   = textures[i].width;
            height  = textures[i].height;
            samples = textures[i].msSamp > 0 ? textures[i].msSamp : 1;
            break;
        }
    }
    if (width == 0 || height == 0)
        return makeError(id, -4, "Color render target has zero dimensions");

    // (Re)create the headless output to match the RT dimensions.
    if (!g_overlayOut || g_overlayW != (int32_t)width || g_overlayH != (int32_t)height) {
        if (g_overlayOut) {
            g_overlayOut->Shutdown();
            g_overlayOut = nullptr;
        }
        WindowingData win = CreateHeadlessWindowingData((int32_t)width, (int32_t)height);
        g_overlayOut = g_replay->CreateOutput(win, ReplayOutputType::Texture);
        if (!g_overlayOut)
            return makeError(id, -5, "CreateOutput(headless) returned null");
        g_overlayW = (int32_t)width;
        g_overlayH = (int32_t)height;
    }

    // Configure the texture display with the drawcall overlay enabled.
    TextureDisplay disp;
    disp.resourceId           = rtId;
    disp.typeCast             = CompType::Typeless;
    disp.scale                = 1.0f;
    disp.red = disp.green = disp.blue = true;
    disp.alpha                = false;
    disp.flipY                = false;
    disp.hdrMultiplier        = -1.0f;
    disp.linearDisplayAsGamma = true;
    disp.rangeMin             = 0.0f;
    disp.rangeMax             = 1.0f;
    disp.subresource          = {0, 0, samples > 1 ? TextureDisplay::ResolveSamples : 0u};
    disp.overlay              = DebugOverlay::Drawcall;

    g_overlayOut->SetTextureDisplay(disp);
    g_overlayOut->Display();

    bytebuf pixels = g_overlayOut->ReadbackOutputTexture();
    if (pixels.empty())
        return makeError(id, -6, "ReadbackOutputTexture returned empty buffer");

    // ReadbackOutputTexture returns tightly packed RGB 3-byte data.
    const int comp = 3;
    const int stride = (int)width * comp;
    if ((size_t)stride * height != pixels.size()) {
        fprintf(stderr, "[bridge] overlay readback size mismatch: got %zu, expected %d\n",
                pixels.size(), stride * (int)height);
        return makeError(id, -7, "Overlay readback size mismatch");
    }

    std::vector<uint8_t> pngData;
    if (!stbi_write_png_to_func(stbiWriteToVector, &pngData,
                                 (int)width, (int)height, comp,
                                 pixels.data(), stride)) {
        return makeError(id, -8, "PNG encode of overlay failed");
    }

    fprintf(stderr, "[bridge] overlay ready: %zu PNG bytes, %ux%u\n",
            pngData.size(), width, height);

    json result;
    result["base64"]     = base64Encode(pngData);
    result["format"]     = "png";
    result["width"]      = width;
    result["height"]     = height;
    result["eventId"]    = eventId;
    result["resourceId"] = resIdToU64(rtId);
    result["rtName"]     = resNameLookup(rtId);
    return makeResult(id, result);
}

// ── API Inspector: per-event structured chunk list ─────────────────────────
// Walk the action tree and return pointer to the action whose eventId matches.
static const ActionDescription *findActionByEventId(
    const rdcarray<ActionDescription> &actions, uint32_t eventId)
{
    for (size_t i = 0; i < actions.size(); i++) {
        const ActionDescription &a = actions[i];
        if (a.eventId == eventId) return &a;
        if (!a.children.empty()) {
            const ActionDescription *hit = findActionByEventId(a.children, eventId);
            if (hit) return hit;
        }
        // Also check nested events list — some APIs bundle multiple events
        // under one ActionDescription. We consider a match if any of the
        // APIEvents have the matching eventId, returning the enclosing action.
        for (size_t e = 0; e < a.events.size(); e++) {
            if (a.events[e].eventId == eventId) return &a;
        }
    }
    return nullptr;
}

// Best-effort string form of an SDObject's leaf value (no deep recursion).
// Used to build the API Inspector parameter preview line.
static std::string sdLeafToStr(const SDObject *o) {
    if (!o) return "null";
    if (o->IsNULL()) return "NULL";
    SDBasic bt = o->type.basetype;
    switch (bt) {
        case SDBasic::String:
            return std::string("\"") + o->AsString().c_str() + "\"";
        case SDBasic::UnsignedInteger:
            return std::to_string(o->AsUInt64());
        case SDBasic::SignedInteger:
            return std::to_string(o->AsInt64());
        case SDBasic::Float: {
            char buf[32];
            snprintf(buf, sizeof(buf), "%g", o->AsDouble());
            return buf;
        }
        case SDBasic::Boolean:
            return o->AsBool() ? "true" : "false";
        case SDBasic::Character: {
            char buf[8];
            snprintf(buf, sizeof(buf), "'%c'", (char)o->AsUInt64());
            return buf;
        }
        case SDBasic::Enum:
            // For enums, SDObject stores the stringized value in data.str
            return o->AsString().c_str();
        case SDBasic::Resource: {
            ResourceId rid;
            uint64_t raw = o->AsUInt64();
            memcpy(&rid, &raw, sizeof(rid));
            std::string nm = resNameLookup(rid);
            if (!nm.empty()) return nm;
            return std::string("Resource ") + std::to_string(raw);
        }
        case SDBasic::Array:
            return std::string("[") + std::to_string(o->NumChildren()) + "]";
        case SDBasic::Struct:
            return std::string("{") + std::to_string(o->NumChildren()) + "}";
        case SDBasic::Buffer:
            return "<buffer>";
        default:
            return "?";
    }
}

// Render the top-level parameters of a chunk as "name=value, name=value" — a
// compact RenderDoc-style summary suitable for the API Inspector row.
static std::string chunkParamsSummary(const SDChunk &chunk) {
    std::string out;
    const size_t n = chunk.NumChildren();
    const size_t maxShow = 6;
    for (size_t i = 0; i < n && i < maxShow; i++) {
        const SDObject *c = chunk.GetChild(i);
        if (!c) continue;
        if (!out.empty()) out += ", ";
        const char *nm = c->name.c_str();
        if (nm && *nm) { out += nm; out += "="; }
        out += sdLeafToStr(c);
    }
    if (n > maxShow) out += ", ...";
    return out;
}

static json handleGetEventChunks(int id, const json &params) {
    if (!g_replay)
        return makeError(id, -1, "No replay active");

    uint32_t eventId = params.value("eventId", (uint32_t)0);

    const rdcarray<ActionDescription> &actions = g_replay->GetRootActions();
    const SDFile &sdfile = g_replay->GetStructuredFile();

    const ActionDescription *action = findActionByEventId(actions, eventId);
    json chunks = json::array();

    auto appendChunk = [&](uint32_t evId, uint32_t chunkIndex) {
        json j;
        j["eventId"] = evId;
        if (chunkIndex < sdfile.chunks.size() && sdfile.chunks[chunkIndex]) {
            const SDChunk *ch = sdfile.chunks[chunkIndex];
            j["name"]   = std::string(ch->name.c_str() ? ch->name.c_str() : "");
            j["params"] = chunkParamsSummary(*ch);
        } else {
            j["name"] = "(unknown)";
            j["params"] = "";
        }
        chunks.push_back(std::move(j));
    };

    if (action) {
        for (size_t i = 0; i < action->events.size(); i++) {
            const APIEvent &ev = action->events[i];
            appendChunk(ev.eventId, ev.chunkIndex);
        }
    }

    json result;
    result["eventId"] = eventId;
    result["chunks"]  = std::move(chunks);
    return makeResult(id, result);
}

// -------- Mesh View --------
// Decode a single component from raw bytes into a JSON number using the
// destination CompType + byte width. Enough for the common vertex formats
// (float32/16, int/uint 8/16/32, snorm/unorm 8/16).
static double decodeScalar(const uint8_t *p, CompType ct, uint32_t byteWidth) {
    switch (ct) {
        case CompType::Float:
            if (byteWidth == 4) { float v; memcpy(&v, p, 4); return (double)v; }
            if (byteWidth == 8) { double v; memcpy(&v, p, 8); return v; }
            if (byteWidth == 2) {
                uint16_t h; memcpy(&h, p, 2);
                uint32_t sign = (h & 0x8000) << 16;
                uint32_t exp  = (h & 0x7C00) >> 10;
                uint32_t mant = (h & 0x03FF);
                uint32_t f;
                if (exp == 0) {
                    if (mant == 0) { f = sign; }
                    else {
                        exp = 1;
                        while (!(mant & 0x0400)) { mant <<= 1; exp--; }
                        mant &= 0x03FF;
                        f = sign | ((exp + 112) << 23) | (mant << 13);
                    }
                } else if (exp == 31) {
                    f = sign | 0x7F800000 | (mant << 13);
                } else {
                    f = sign | ((exp + 112) << 23) | (mant << 13);
                }
                float v; memcpy(&v, &f, 4); return (double)v;
            }
            break;
        case CompType::UInt:
            if (byteWidth == 1) return (double)*p;
            if (byteWidth == 2) { uint16_t v; memcpy(&v, p, 2); return (double)v; }
            if (byteWidth == 4) { uint32_t v; memcpy(&v, p, 4); return (double)v; }
            if (byteWidth == 8) { uint64_t v; memcpy(&v, p, 8); return (double)v; }
            break;
        case CompType::SInt:
            if (byteWidth == 1) return (double)(int8_t)*p;
            if (byteWidth == 2) { int16_t v; memcpy(&v, p, 2); return (double)v; }
            if (byteWidth == 4) { int32_t v; memcpy(&v, p, 4); return (double)v; }
            if (byteWidth == 8) { int64_t v; memcpy(&v, p, 8); return (double)v; }
            break;
        case CompType::UNorm:
        case CompType::UNormSRGB:
            if (byteWidth == 1) return (double)*p / 255.0;
            if (byteWidth == 2) { uint16_t v; memcpy(&v, p, 2); return (double)v / 65535.0; }
            break;
        case CompType::SNorm:
            if (byteWidth == 1) { int8_t v = (int8_t)*p; return v < -127 ? -1.0 : (double)v / 127.0; }
            if (byteWidth == 2) { int16_t v; memcpy(&v, p, 2); return v < -32767 ? -1.0 : (double)v / 32767.0; }
            break;
        case CompType::UScaled:
            if (byteWidth == 1) return (double)*p;
            if (byteWidth == 2) { uint16_t v; memcpy(&v, p, 2); return (double)v; }
            break;
        case CompType::SScaled:
            if (byteWidth == 1) return (double)(int8_t)*p;
            if (byteWidth == 2) { int16_t v; memcpy(&v, p, 2); return (double)v; }
            break;
        default: break;
    }
    return 0.0;
}

// Convert a MeshDataStage string (sent by the webview) to the enum.
static MeshDataStage parseMeshStage(const std::string &s) {
    if (s == "vsout" || s == "VSOut") return MeshDataStage::VSOut;
    if (s == "gsout" || s == "GSOut") return MeshDataStage::GSOut;
    return MeshDataStage::VSIn;
}

// Read `len` bytes from buffer `id` at `offset`. Empty result on failure.
static std::vector<uint8_t> readBuffer(ResourceId resId, uint64_t offset, uint64_t len) {
    if (!g_replay || resId == ResourceId() || len == 0) return {};
    bytebuf raw = g_replay->GetBufferData(resId, offset, len);
    std::vector<uint8_t> v(raw.size());
    if (!raw.empty()) memcpy(v.data(), raw.data(), raw.size());
    return v;
}

// Look up an index from a raw index buffer. byteStride: 1/2/4. baseVertex is added afterwards.
static uint32_t readIndex(const std::vector<uint8_t> &idxBuf, uint32_t byteStride,
                          uint32_t i, uint32_t restartIdx, bool &isRestart) {
    isRestart = false;
    uint64_t off = (uint64_t)i * byteStride;
    if (off + byteStride > idxBuf.size()) { isRestart = true; return 0; }
    const uint8_t *p = idxBuf.data() + off;
    uint32_t v = 0;
    if (byteStride == 1) v = p[0];
    else if (byteStride == 2) { uint16_t t; memcpy(&t, p, 2); v = t; }
    else if (byteStride == 4) memcpy(&v, p, 4);
    if (restartIdx != 0 && v == restartIdx) isRestart = true;
    return v;
}

static json handleGetMeshData(int id, const json &params) {
    if (!g_replay)
        return makeError(id, -1, "No replay active");

    uint32_t eventId = params.value("eventId", (uint32_t)0);
    std::string stageStr = params.value("stage", "vsin");
    uint32_t maxVerts = params.value("maxVertices", (uint32_t)256);
    uint32_t instance = params.value("instance", (uint32_t)0);
    uint32_t view     = params.value("view", (uint32_t)0);
    MeshDataStage stage = parseMeshStage(stageStr);

    g_replay->SetFrameEvent(eventId, true);

    // Pull a single MeshFormat for this stage; it describes how to read the
    // primary (position) stream and where the index buffer lives. For VSIn
    // we prefer the real ActionDescription counts (matches RenderDoc desktop
    // BufferViewer.cpp ~L1791 which uses action->numIndices) because
    // GetPostVSData(VSIn) can return 0 on APIs that don't expose a post-IA
    // stream. For post-VS/GS stages the MeshFormat counts are authoritative.
    MeshFormat mf = g_replay->GetPostVSData(instance, view, stage);

    // For VSIn, override IB/topology/counts from the drawcall itself.
    const ActionDescription *action = nullptr;
    if (stage == MeshDataStage::VSIn) {
        const rdcarray<ActionDescription> &actions = g_replay->GetRootActions();
        action = findActionByEventId(actions, eventId);
        if (action) {
            if (mf.numIndices == 0) mf.numIndices = action->numIndices;
            if (mf.baseVertex == 0)  mf.baseVertex = action->baseVertex;
            // topology: get from per-API IA state
            const auto *gl = g_replay->GetGLPipelineState();
            const auto *vk = g_replay->GetVulkanPipelineState();
            const auto *d11 = g_replay->GetD3D11PipelineState();
            const auto *d12 = g_replay->GetD3D12PipelineState();
            if (gl)       mf.topology = gl->vertexInput.topology;
            else if (vk)  mf.topology = vk->inputAssembly.topology;
            else if (d11) mf.topology = d11->inputAssembly.topology;
            else if (d12) mf.topology = d12->inputAssembly.topology;
            // IB from CurPipelineState + action's indexOffset
            if (action->flags & ActionFlags::Indexed) {
                ResourceId ib; uint64_t ibOffs = 0; uint32_t ibStride = 0;
                if (gl)  { ib = gl->vertexInput.indexBuffer; ibStride = gl->vertexInput.indexByteStride; }
                else if (vk)  { ib = vk->inputAssembly.indexBuffer.resourceId; ibOffs = vk->inputAssembly.indexBuffer.byteOffset; ibStride = vk->inputAssembly.indexBuffer.byteStride; }
                else if (d11) { ib = d11->inputAssembly.indexBuffer.resourceId; ibOffs = d11->inputAssembly.indexBuffer.byteOffset; ibStride = d11->inputAssembly.indexBuffer.byteStride; }
                else if (d12) { ib = d12->inputAssembly.indexBuffer.resourceId; ibOffs = d12->inputAssembly.indexBuffer.byteOffset; ibStride = d12->inputAssembly.indexBuffer.byteStride; }
                mf.indexResourceId = ib;
                mf.indexByteOffset = ibOffs + (uint64_t)action->indexOffset * ibStride;
                mf.indexByteStride = ibStride;
            } else {
                // Non-indexed: produce a synthetic vertexOffset-based mapping via baseVertex.
                mf.indexResourceId = ResourceId();
                mf.indexByteStride = 0;
                if (mf.baseVertex == 0) mf.baseVertex = action->vertexOffset;
            }
        }
    }

    json result;
    result["eventId"] = eventId;
    result["stage"] = stageStr;
    result["topology"] = (uint32_t)mf.topology;
    result["numIndices"] = mf.numIndices;
    result["baseVertex"] = mf.baseVertex;
    result["indexByteStride"] = mf.indexByteStride;
    result["vertexByteStride"] = mf.vertexByteStride;
    result["instance"] = instance;
    result["view"] = view;
    result["indexBufferId"] = resIdToU64(mf.indexResourceId);
    result["vertexBufferId"] = resIdToU64(mf.vertexResourceId);

    // Cap how many vertices we actually decode on this round-trip.
    uint32_t total = mf.numIndices;
    if (total == 0) {
        result["rows"] = json::array();
        result["attributes"] = json::array();
        return makeResult(id, result);
    }
    uint32_t count = std::min(total, maxVerts);
    result["totalIndices"] = total;
    result["returnedIndices"] = count;

    // For VSIn: enumerate user-bound vertex attributes so we can decode every
    // one of them, not just the position that MeshFormat describes. Mirrors
    // RenderDoc desktop PipeState::GetVertexInputs() in pipestate.inl so
    // behaviour matches exactly (APPEND_ALIGNED sentinel for D3D, reflection
    // based names, generic values on GL).
    struct AttrRead {
        std::string name;
        ResourceId vb;
        uint64_t vbOffset;
        uint32_t vbStride;
        uint32_t attrOffset;
        ResourceFormat fmt;
        bool perInstance;
        uint32_t instanceRate;
        bool used;               // shader reflection says this attr is read
        bool genericEnabled;     // GL generic (glVertexAttrib4f) - no VB read
        float genericF[4];
        uint32_t genericU[4];
        int32_t  genericI[4];
        int      genericKind;    // 0=float 1=uint 2=sint
    };
    std::vector<AttrRead> attrs;

    auto striequal = [](const rdcstr &a, const rdcstr &b) {
        if (a.length() != b.length()) return false;
        for (size_t i = 0; i < a.length(); i++)
            if (std::toupper((unsigned char)a[i]) != std::toupper((unsigned char)b[i])) return false;
        return true;
    };

    if (stage == MeshDataStage::VSIn) {
        const auto *gl = g_replay->GetGLPipelineState();
        const auto *vk = g_replay->GetVulkanPipelineState();
        const auto *d11 = g_replay->GetD3D11PipelineState();
        const auto *d12 = g_replay->GetD3D12PipelineState();

        if (d11 || d12) {
            // Common D3D path: 128 per-inputSlot running offsets for
            // APPEND_ALIGNED (byteOffset == UINT32_MAX). Match pipestate.inl.
            uint32_t byteOffs[128] = {};
            const ShaderReflection *refl =
                d11 ? (d11->inputAssembly.bytecode ? (const ShaderReflection*)d11->inputAssembly.bytecode : nullptr)
                    : (d12->vertexShader.reflection);
            size_t nLayouts = d11 ? d11->inputAssembly.layouts.size()
                                  : d12->inputAssembly.layouts.size();
            for (size_t i = 0; i < nLayouts; i++) {
                rdcstr semName;
                uint32_t semIdx, inputSlot, rawOffs;
                ResourceFormat fmt;
                bool perInst;
                uint32_t instRate;
                if (d11) {
                    const auto &L = d11->inputAssembly.layouts[i];
                    semName = L.semanticName; semIdx = L.semanticIndex;
                    inputSlot = L.inputSlot; rawOffs = L.byteOffset; fmt = L.format;
                    perInst = L.perInstance; instRate = L.instanceDataStepRate;
                } else {
                    const auto &L = d12->inputAssembly.layouts[i];
                    semName = L.semanticName; semIdx = L.semanticIndex;
                    inputSlot = L.inputSlot; rawOffs = L.byteOffset; fmt = L.format;
                    perInst = L.perInstance; instRate = L.instanceDataStepRate;
                }

                // Disambiguate semantic names if duplicates exist.
                bool needsSemIdx = false;
                for (size_t j = 0; j < nLayouts; j++) {
                    if (i == j) continue;
                    rdcstr other = d11 ? d11->inputAssembly.layouts[j].semanticName
                                       : d12->inputAssembly.layouts[j].semanticName;
                    if (striequal(semName, other)) { needsSemIdx = true; break; }
                }

                uint32_t offs = rawOffs;
                if (inputSlot < 128) {
                    if (offs == UINT32_MAX)
                        offs = byteOffs[inputSlot];
                    else
                        byteOffs[inputSlot] = offs;
                    byteOffs[inputSlot] += (uint32_t)fmt.compByteWidth * (uint32_t)fmt.compCount;
                }

                AttrRead r{};
                r.name = rdcToStr(semName) + (needsSemIdx ? std::to_string(semIdx) : "");
                r.attrOffset = offs;
                r.fmt = fmt;
                r.perInstance = perInst;
                r.instanceRate = instRate;
                r.used = false;

                size_t nVB = d11 ? d11->inputAssembly.vertexBuffers.size()
                                 : d12->inputAssembly.vertexBuffers.size();
                if ((size_t)inputSlot < nVB) {
                    if (d11) {
                        const auto &vb = d11->inputAssembly.vertexBuffers[inputSlot];
                        r.vb = vb.resourceId; r.vbOffset = vb.byteOffset; r.vbStride = vb.byteStride;
                    } else {
                        const auto &vb = d12->inputAssembly.vertexBuffers[inputSlot];
                        r.vb = vb.resourceId; r.vbOffset = vb.byteOffset; r.vbStride = vb.byteStride;
                    }
                }
                if (refl) {
                    const auto &sig = refl->inputSignature;
                    for (size_t ia = 0; ia < sig.size(); ia++) {
                        if (striequal(semName, sig[ia].semanticName) &&
                            sig[ia].semanticIndex == semIdx) {
                            r.used = true;
                            break;
                        }
                    }
                }
                attrs.push_back(r);
            }
        } else if (gl) {
            const auto &glAttrs = gl->vertexInput.attributes;
            const ShaderReflection *refl = gl->vertexShader.reflection;
            for (size_t i = 0; i < glAttrs.size(); i++) {
                const auto &a = glAttrs[i];
                AttrRead r{};
                char nameBuf[32]; snprintf(nameBuf, sizeof(nameBuf), "attr%zu", i);
                r.name = nameBuf;
                r.attrOffset = a.byteOffset;
                r.fmt = a.format;
                r.used = true;
                r.perInstance = false;
                r.instanceRate = 0;
                uint32_t vbIdx = a.vertexBufferSlot;
                if ((size_t)vbIdx < gl->vertexInput.vertexBuffers.size()) {
                    const auto &vb = gl->vertexInput.vertexBuffers[vbIdx];
                    r.vb = vb.resourceId;
                    r.vbOffset = vb.byteOffset;
                    r.vbStride = vb.byteStride;
                    r.perInstance = vb.instanceDivisor > 0;
                    r.instanceRate = vb.instanceDivisor;
                }
                // Reflection: replace synthetic name with real shader input
                // variable name, detect generic (disabled) attributes.
                if (refl) {
                    int attrib = a.boundShaderInput;
                    if (attrib >= 0 && (size_t)attrib < refl->inputSignature.size()) {
                        const auto &sig = refl->inputSignature[attrib];
                        r.name = rdcToStr(sig.varName);
                        if (!a.enabled) {
                            // Generic (not backed by a VB). Store the
                            // constant value the app last set.
                            r.genericEnabled = true;
                            r.perInstance = false;
                            r.instanceRate = 0;
                            uint32_t cc = sig.compCount;
                            VarType vt = sig.varType;
                            if (vt == VarType::Float || vt == VarType::Double) {
                                r.genericKind = 0;
                                for (uint32_t c = 0; c < cc && c < 4; c++)
                                    r.genericF[c] = a.genericValue.floatValue[c];
                                r.fmt.compType = CompType::Float;
                            } else if (vt == VarType::UInt || vt == VarType::Bool) {
                                r.genericKind = 1;
                                for (uint32_t c = 0; c < cc && c < 4; c++)
                                    r.genericU[c] = a.genericValue.uintValue[c];
                                r.fmt.compType = CompType::UInt;
                            } else if (vt == VarType::SInt) {
                                r.genericKind = 2;
                                for (uint32_t c = 0; c < cc && c < 4; c++)
                                    r.genericI[c] = a.genericValue.intValue[c];
                                r.fmt.compType = CompType::SInt;
                            }
                            r.fmt.compByteWidth = 4;
                            r.fmt.compCount = (uint8_t)cc;
                            r.fmt.type = ResourceFormatType::Regular;
                        }
                    }
                }
                attrs.push_back(r);
            }
        } else if (vk) {
            const auto &vkAttrs = vk->vertexInput.attributes;
            const ShaderReflection *refl = vk->vertexShader.reflection;
            for (size_t i = 0; i < vkAttrs.size(); i++) {
                const auto &a = vkAttrs[i];
                AttrRead r{};
                char nameBuf[32]; snprintf(nameBuf, sizeof(nameBuf), "attr%zu", i);
                r.name = nameBuf;
                r.attrOffset = a.byteOffset;
                r.fmt = a.format;
                r.used = true;
                // Defaults per RenderDoc: perInstance=false, instanceRate=1
                r.perInstance = false;
                r.instanceRate = 1;
                if ((size_t)a.binding < vk->vertexInput.bindings.size()) {
                    const auto &bind = vk->vertexInput.bindings[a.binding];
                    r.perInstance = bind.perInstance;
                    r.instanceRate = bind.instanceDivisor;
                }
                // RenderDoc indexes vertexBuffers[] directly with attr.binding.
                if ((size_t)a.binding < vk->vertexInput.vertexBuffers.size()) {
                    const auto &vb = vk->vertexInput.vertexBuffers[a.binding];
                    r.vb = vb.resourceId;
                    r.vbOffset = vb.byteOffset;
                    r.vbStride = vb.byteStride;
                }
                if (refl) {
                    for (const auto &sig : refl->inputSignature) {
                        if (sig.regIndex == a.location &&
                            sig.systemValue == ShaderBuiltin::Undefined) {
                            r.name = rdcToStr(sig.varName);
                            break;
                        }
                    }
                }
                attrs.push_back(r);
            }
        }
    }

    // Fallback: if we don't have per-attribute info (post-VS stage, or we
    // failed to enumerate), synthesise a single "POSITION" column from the
    // MeshFormat that GetPostVSData returned.
    if (attrs.empty()) {
        AttrRead r{};
        r.name = (stage == MeshDataStage::VSIn) ? "POSITION" : "gl_Position";
        r.vb = mf.vertexResourceId;
        r.vbOffset = mf.vertexByteOffset;
        r.vbStride = mf.vertexByteStride;
        r.attrOffset = 0;
        r.fmt = mf.format;
        r.used = true;
        attrs.push_back(r);
    }

    // Report attribute schema.
    json attrMeta = json::array();
    for (const auto &a : attrs) {
        attrMeta.push_back({
            {"name", a.name},
            {"compType", (uint32_t)a.fmt.compType},
            {"compCount", a.fmt.compCount},
            {"compByteWidth", a.fmt.compByteWidth},
            {"bgra", a.fmt.BGRAOrder()},
            {"formatType", (uint32_t)a.fmt.type},
            {"vertexBufferId", resIdToU64(a.vb)},
            {"byteStride", a.vbStride},
            {"relativeOffset", a.attrOffset},
            {"perInstance", a.perInstance},
            {"instanceRate", a.instanceRate},
            {"used", a.used},
            {"genericEnabled", a.genericEnabled},
        });
    }
    result["attributes"] = attrMeta;

    // Read the index buffer covering at least the requested indices.
    std::vector<uint8_t> idxBuf;
    if (mf.indexResourceId != ResourceId() && mf.indexByteStride > 0) {
        uint64_t need = (uint64_t)count * mf.indexByteStride;
        idxBuf = readBuffer(mf.indexResourceId, mf.indexByteOffset, need);
    }
    // Use PipeState-style unified restart logic: IsRestartEnabled() +
    // GetRestartIndex(). Emulate locally per API.
    uint32_t restartIdx = 0;
    bool restartEnabled = false;
    {
        const auto *gl = g_replay->GetGLPipelineState();
        const auto *vk = g_replay->GetVulkanPipelineState();
        const auto *d11 = g_replay->GetD3D11PipelineState();
        const auto *d12 = g_replay->GetD3D12PipelineState();
        if (gl && gl->vertexInput.primitiveRestart) {
            restartEnabled = true;
            restartIdx = gl->vertexInput.restartIndex;
            if (mf.indexByteStride == 1)      restartIdx &= 0xFFu;
            else if (mf.indexByteStride == 2) restartIdx &= 0xFFFFu;
        } else if (vk && vk->inputAssembly.primitiveRestartEnable) {
            restartEnabled = true;
            restartIdx = (mf.indexByteStride == 2) ? 0xFFFFu : 0xFFFFFFFFu;
        } else if (d11 && d11->inputAssembly.indexBuffer.byteStride > 0) {
            // D3D11 uses topology cut-value; only strip topologies use it.
            Topology t = d11->inputAssembly.topology;
            if (t == Topology::LineStrip || t == Topology::TriangleStrip ||
                t == Topology::LineStrip_Adj || t == Topology::TriangleStrip_Adj) {
                restartEnabled = true;
                restartIdx = (mf.indexByteStride == 2) ? 0xFFFFu : 0xFFFFFFFFu;
            }
        } else if (d12) {
            // D3D12 has an explicit strip cut value (0 disables).
            uint32_t cut = d12->inputAssembly.indexStripCutValue;
            if (cut != 0) {
                restartEnabled = true;
                restartIdx = cut;
            }
        }
    }
    if (!restartEnabled) restartIdx = ~0u; // Sentinel readIndex won't match.

    // Pre-read each attribute's VB into memory once (capped to the range we need).
    struct AttrBuf { std::vector<uint8_t> data; uint32_t stride; uint32_t offset; };
    std::vector<AttrBuf> vbufs(attrs.size());
    for (size_t k = 0; k < attrs.size(); k++) {
        const auto &a = attrs[k];
        vbufs[k].stride = a.vbStride;
        vbufs[k].offset = a.attrOffset;
        if (a.vb == ResourceId() || a.vbStride == 0) continue;
        // Over-read conservatively: we don't know max index value yet, so read
        // a reasonable chunk. For indexed draws with small caps we still cover
        // most meshes up to ~64k verts. If an index exceeds the buffer we'll
        // gracefully fill zeros.
        uint64_t readLen = (uint64_t)a.vbStride * 65536;
        vbufs[k].data = readBuffer(a.vb, a.vbOffset, readLen);
    }

    // Build rows.
    json rows = json::array();
    for (uint32_t i = 0; i < count; i++) {
        json row;
        row["vtx"] = i;
        uint32_t idx = i;
        bool isRestart = false;
        if (!idxBuf.empty()) {
            uint32_t raw = readIndex(idxBuf, mf.indexByteStride, i, restartIdx, isRestart);
            row["idx"] = raw;
            row["restart"] = isRestart;
            idx = isRestart ? 0 : (raw + (uint32_t)mf.baseVertex);
        }

        json cols = json::array();
        for (size_t k = 0; k < attrs.size(); k++) {
            const auto &a = attrs[k];
            const auto &vb = vbufs[k];
            json vals = json::array();
            if (a.genericEnabled) {
                // Constant per-attribute value (GL glVertexAttrib4f etc).
                for (uint32_t c = 0; c < a.fmt.compCount; c++) {
                    if (a.genericKind == 1)      vals.push_back((double)a.genericU[c]);
                    else if (a.genericKind == 2) vals.push_back((double)a.genericI[c]);
                    else                         vals.push_back((double)a.genericF[c]);
                }
            } else if (isRestart || vb.data.empty() || vb.stride == 0 ||
                       a.fmt.type != ResourceFormatType::Regular) {
                for (uint32_t c = 0; c < a.fmt.compCount; c++) vals.push_back(0.0);
            } else {
                uint32_t useIdx = a.perInstance
                    ? (a.instanceRate ? (instance / a.instanceRate) : instance)
                    : idx;
                uint64_t base = (uint64_t)useIdx * vb.stride + vb.offset;
                for (uint32_t c = 0; c < a.fmt.compCount; c++) {
                    uint32_t srcC = (a.fmt.BGRAOrder() && a.fmt.compCount >= 3 && c < 3) ? (2u - c) : c;
                    uint64_t off = base + (uint64_t)srcC * a.fmt.compByteWidth;
                    if (off + a.fmt.compByteWidth > vb.data.size()) {
                        vals.push_back(0.0);
                    } else {
                        vals.push_back(decodeScalar(vb.data.data() + off, a.fmt.compType,
                                                    a.fmt.compByteWidth));
                    }
                }
            }
            cols.push_back(vals);
        }
        row["cols"] = cols;
        rows.push_back(row);
    }
    result["rows"] = rows;

    return makeResult(id, result);
}

static json handleShutdown(int id) {
    g_overlayOut = nullptr; g_overlayW = 0; g_overlayH = 0;
    if (g_replay) { g_replay->Shutdown(); g_replay = nullptr; }
    if (g_capFile) { g_capFile->Shutdown(); g_capFile = nullptr; }
    if (g_replayInit && g_dll.isLoaded()) {
        g_dll.ShutdownReplay();
        g_replayInit = false;
    }
    g_dll.unload();
    return makeResult(id, {{"shutdown", true}});
}

// ── Main loop ───────────────────────────────────────────────────────────────

static json dispatch(const json &req) {
    int id = req.value("id", 0);
    std::string method = req.value("method", "");
    json params = req.value("params", json::object());

    try {
        if (method == "init")               return handleInit(id, params);
        if (method == "getVersion")         return handleGetVersion(id);
        if (method == "openCapture")        return handleOpenCapture(id, params);
        if (method == "closeCapture")       return handleCloseCapture(id);
        if (method == "tryReplay")          return handleTryReplay(id);
        if (method == "setFrameEvent")      return handleSetFrameEvent(id, params);
        if (method == "getRootActions")     return handleGetRootActions(id);
        if (method == "getResources")       return handleGetResources(id);
        if (method == "getTextures")        return handleGetTextures(id);
        if (method == "getDisassemblyTargets") return handleGetDisassemblyTargets(id);
        if (method == "getShaderEntryPoints") return handleGetShaderEntryPoints(id, params);
        if (method == "getShaderSource")    return handleGetShaderSource(id, params);
        if (method == "getShaderSourceForEvent") return handleGetShaderSourceForEvent(id, params);
        if (method == "getTexturePreview") return handleGetTexturePreview(id, params);
        if (method == "saveTexture")        return handleSaveTexture(id, params);
        if (method == "getPipelineState")   return handleGetPipelineState(id, params);
        if (method == "getDrawcallOverlay") return handleGetDrawcallOverlay(id, params);
        if (method == "getEventChunks")     return handleGetEventChunks(id, params);
        if (method == "getMeshData")        return handleGetMeshData(id, params);
        if (method == "shutdown")           return handleShutdown(id);
        return makeError(id, -100, "Unknown method: " + method);
    } catch (const std::exception &e) {
        return makeError(id, -999, std::string("Exception: ") + e.what());
    }
}

int main(int argc, char *argv[]) {
    // Disable sync for faster I/O
    std::ios_base::sync_with_stdio(false);
    std::cin.tie(nullptr);

    // Signal readiness
    json ready = {{"ready", true}, {"protocol", "renderdoc-bridge/1.0"}};
    writeJsonLine(ready);

    // Read JSON lines from stdin
    std::string line;
    while (std::getline(std::cin, line)) {
        if (line.empty()) continue;

        json req;
        try {
            req = json::parse(line);
        } catch (const json::parse_error &e) {
            json err = makeError(0, -1000, std::string("JSON parse error: ") + e.what());
            writeJsonLine(err);
            continue;
        }

        json response = dispatch(req);
        writeJsonLine(response);

        // Exit after shutdown command
        if (req.value("method", "") == "shutdown")
            break;
    }

    // Cleanup
    if (g_replay) { g_replay->Shutdown(); g_replay = nullptr; }
    if (g_capFile) { g_capFile->Shutdown(); g_capFile = nullptr; }
    if (g_replayInit && g_dll.isLoaded()) {
        g_dll.ShutdownReplay();
    }
    g_dll.unload();

    return 0;
}
