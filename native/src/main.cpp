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

    // Close previous capture if any
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

    rdcpair<ResultDetails, IReplayController *> replayResult =
        g_capFile->OpenCapture(opts, nullptr);

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

        // Get source from debug info files
        if (!refl->debugInfo.files.empty()) {
            std::string combinedSource;
            json files = json::array();
            for (size_t i = 0; i < refl->debugInfo.files.size(); i++) {
                files.push_back({
                    {"filename", rdcToStr(refl->debugInfo.files[i].filename)},
                    {"contents", rdcToStr(refl->debugInfo.files[i].contents)}
                });
                if (!combinedSource.empty()) combinedSource += "\n\n";
                combinedSource += rdcToStr(refl->debugInfo.files[i].contents);
            }
            stageResult["sourceFiles"] = files;
            stageResult["source"] = combinedSource;
        }

        // Also try disassembly if no source files available or if target requested
        if (refl->debugInfo.files.empty() || !targetDisasm.empty()) {
            rdcarray<rdcstr> targets = g_replay->GetDisassemblyTargets(true);
            rdcstr tgt;
            if (!targetDisasm.empty()) {
                tgt = targetDisasm.c_str();
            } else if (!targets.empty()) {
                tgt = targets[0];
            }
            if (!tgt.empty()) {
                rdcstr disasm = g_replay->DisassembleShader(si.resourceId, refl, tgt);
                std::string disasmStr = rdcToStr(disasm);
                if (!disasmStr.empty()) {
                    stageResult["disassembly"] = disasmStr;
                    if (!stageResult.contains("source") || stageResult["source"].get<std::string>().empty()) {
                        stageResult["source"] = disasmStr;
                    }
                }
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

static json handleShutdown(int id) {
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
    std::cout << ready.dump() << "\n" << std::flush;

    // Read JSON lines from stdin
    std::string line;
    while (std::getline(std::cin, line)) {
        if (line.empty()) continue;

        json req;
        try {
            req = json::parse(line);
        } catch (const json::parse_error &e) {
            json err = makeError(0, -1000, std::string("JSON parse error: ") + e.what());
            std::cout << err.dump() << "\n" << std::flush;
            continue;
        }

        json response = dispatch(req);
        std::cout << response.dump() << "\n" << std::flush;

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
