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
static json actionToJson(const ActionDescription &a) {
    json j;
    j["eventId"]  = a.eventId;
    j["actionId"] = a.actionId;
    j["name"]     = rdcToStr(a.customName);
    j["flags"]    = (uint32_t)a.flags;

    if (a.numIndices > 0)    j["numIndices"]   = a.numIndices;
    if (a.numInstances > 1)  j["numInstances"] = a.numInstances;

    if (!a.children.empty()) {
        json kids = json::array();
        for (size_t i = 0; i < a.children.size(); i++)
            kids.push_back(actionToJson(a.children[i]));
        j["children"] = std::move(kids);
    }
    return j;
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

    // Open replay (localSupport == Supported)
    ReplayOptions opts;
    opts.apiValidation = false;
    fprintf(stderr, "[bridge] Opening replay...\n");

    rdcpair<ResultDetails, IReplayController *> replayResult =
        g_capFile->OpenCapture(opts, nullptr);

    if (replayResult.first.code != ResultCode::Succeeded) {
        fprintf(stderr, "[bridge] OpenCapture failed: code=%d\n", (int)replayResult.first.code);
        g_replay = nullptr;
        json result;
        result["path"]   = path;
        result["driver"] = rdcToStr(g_capFile->DriverName());
        result["replay"] = false;
        result["replayError"] = "OpenCapture failed with code " + std::to_string((int)replayResult.first.code);
        return makeResult(id, result);
    }

    g_replay = replayResult.second;

    // Gather basic info
    json result;
    result["path"]   = path;
    result["driver"] = rdcToStr(g_capFile->DriverName());
    result["replay"] = true;
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
    json arr = json::array();
    for (size_t i = 0; i < actions.size(); i++)
        arr.push_back(actionToJson(actions[i]));

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
        if (gl->vertexShader.shaderResourceId != ResourceId())
            stages.push_back({"vertex", gl->vertexShader.shaderResourceId, ShaderStage::Vertex});
        if (gl->fragmentShader.shaderResourceId != ResourceId())
            stages.push_back({"fragment", gl->fragmentShader.shaderResourceId, ShaderStage::Pixel});
        if (gl->geometryShader.shaderResourceId != ResourceId())
            stages.push_back({"geometry", gl->geometryShader.shaderResourceId, ShaderStage::Geometry});
        if (gl->tessControlShader.shaderResourceId != ResourceId())
            stages.push_back({"tessControl", gl->tessControlShader.shaderResourceId, ShaderStage::Hull});
        if (gl->tessEvalShader.shaderResourceId != ResourceId())
            stages.push_back({"tessEval", gl->tessEvalShader.shaderResourceId, ShaderStage::Domain});
        if (gl->computeShader.shaderResourceId != ResourceId())
            stages.push_back({"compute", gl->computeShader.shaderResourceId, ShaderStage::Compute});
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

// High-level: Save texture to temp file and return base64-encoded image data
static json handleGetTexturePreview(int id, const json &params) {
    if (!g_replay)
        return makeError(id, -1, "No replay active");

    uint64_t rid = params.value("resourceId", (uint64_t)0);
    uint32_t mip = params.value("mip", (uint32_t)0);

    ResourceId resId = u64ToResId(rid);
    fprintf(stderr, "[bridge] getTexturePreview: resourceId=%llu mip=%u\n", rid, mip);

    // Get texture info for dimensions
    const rdcarray<TextureDescription> &textures = g_replay->GetTextures();
    uint32_t width = 0, height = 0;
    std::string format;
    for (size_t i = 0; i < textures.size(); i++) {
        if (textures[i].resourceId == resId) {
            width = textures[i].width;
            height = textures[i].height;
            format = formatToStr(textures[i].format);
            break;
        }
    }

    // Save to temp PNG file
    std::string tmpPath = std::filesystem::temp_directory_path().string() + "/rdctex_" + std::to_string(rid) + ".png";

    TextureSave save;
    save.resourceId = resId;
    save.destType = FileType::PNG;
    save.mip = mip;
    save.slice.sliceIndex = 0;
    save.comp.blackPoint = 0.0f;
    save.comp.whitePoint = 1.0f;

    rdcstr outPath(tmpPath.c_str());
    ResultDetails saveResult = g_replay->SaveTexture(save, outPath);

    if (saveResult.code != ResultCode::Succeeded)
        return makeError(id, -3, "SaveTexture failed: " + resultMessage(saveResult));

    // Read the PNG file and base64 encode it
    std::ifstream file(tmpPath, std::ios::binary);
    if (!file.is_open())
        return makeError(id, -4, "Failed to open temp texture file");

    std::vector<uint8_t> data((std::istreambuf_iterator<char>(file)),
                               std::istreambuf_iterator<char>());
    file.close();

    // Clean up temp file
    std::filesystem::remove(tmpPath);

    if (data.empty())
        return makeError(id, -5, "Texture file is empty");

    // Base64 encode
    static const char b64chars[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string base64;
    base64.reserve((data.size() + 2) / 3 * 4);
    for (size_t i = 0; i < data.size(); i += 3) {
        uint32_t n = (uint32_t)data[i] << 16;
        if (i + 1 < data.size()) n |= (uint32_t)data[i+1] << 8;
        if (i + 2 < data.size()) n |= (uint32_t)data[i+2];
        base64 += b64chars[(n >> 18) & 0x3F];
        base64 += b64chars[(n >> 12) & 0x3F];
        base64 += (i + 1 < data.size()) ? b64chars[(n >> 6) & 0x3F] : '=';
        base64 += (i + 2 < data.size()) ? b64chars[n & 0x3F] : '=';
    }

    json result;
    result["base64"] = base64;
    result["format"] = "png";
    result["width"] = width;
    result["height"] = height;
    result["texFormat"] = format;
    result["size"] = data.size();
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

static json handleGetPipelineState(int id) {
    if (!g_replay)
        return makeError(id, -1, "No replay active");

    json result;
    json shaders = json::object();

    // Use API-specific pipeline state getters to avoid PipeState helper methods
    // (those are implemented in the DLL and we can't link to them)
    auto addShader = [&](const char *name, ResourceId resId, ShaderStage stage) {
        if (resId != ResourceId()) {
            shaders[name] = {
                {"resourceId", resIdToU64(resId)},
                {"stage", (uint32_t)stage}
            };
        }
    };

    // Try each API
    const auto *gl = g_replay->GetGLPipelineState();
    if (gl) {
        result["api"] = "OpenGL";
        addShader("vertex",   gl->vertexShader.shaderResourceId,   ShaderStage::Vertex);
        addShader("tessCtrl", gl->tessControlShader.shaderResourceId, ShaderStage::Hull);
        addShader("tessEval", gl->tessEvalShader.shaderResourceId,  ShaderStage::Domain);
        addShader("geometry", gl->geometryShader.shaderResourceId,  ShaderStage::Geometry);
        addShader("fragment", gl->fragmentShader.shaderResourceId,  ShaderStage::Pixel);
        addShader("compute",  gl->computeShader.shaderResourceId,   ShaderStage::Compute);
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
    }

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
        if (method == "getPipelineState")   return handleGetPipelineState(id);
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
