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

static uint32_t findMaxEventId(const rdcarray<ActionDescription> &actions);
static std::string resultMessage(const ResultDetails &r);

// Cached headless replay output for drawcall-overlay rendering.
// Reused across events as long as the backing dimensions don't change.
static IReplayOutput    *g_overlayOut  = nullptr;
static int32_t           g_overlayW    = 0;
static int32_t           g_overlayH    = 0;

// Track the last SetFrameEvent position so we can skip redundant full replays.
// All handlers that advance the frame must go through ensureEvent().
// UINT32_MAX means "unknown / just opened capture".
static uint32_t          g_currentEventId = UINT32_MAX;
static void ensureEvent(uint32_t eid) {
    if (eid == g_currentEventId) return;  // already there — no replay needed
    g_replay->SetFrameEvent(eid, false);
    g_currentEventId = eid;
}
static void resetEventCache() { g_currentEventId = UINT32_MAX; }

// Persistent 256×256 headless output used for fast GPU-rendered thumbnails.
// SetTextureDisplay + Display + ReadbackOutputTexture is much faster than
// SaveTexture-to-file for small preview images (no temp-file I/O, GPU-scaled).
static IReplayOutput    *g_thumbOut    = nullptr;
static const int32_t     THUMB_DIM     = 256;
// Live target-control session used for launch/attach workflows where the
// user starts a program now and decides later when to trigger a capture.
static IRemoteServer    *g_liveRemote = nullptr;
static ITargetControl   *g_liveTarget = nullptr;
static std::atomic<bool> g_liveRemoteKeepAlive{false};
static std::thread       g_liveRemotePingThread;
static std::string       g_liveTargetUrl;
static std::string       g_liveTargetName;
static std::string       g_liveTargetAPI;
static uint32_t          g_liveTargetPID = 0;
static uint32_t          g_liveTargetIdent = 0;
static bool              g_liveTargetLocal = true;

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

static void emitStatusNote(const std::string &message) {
    writeJsonLine({
        {"method", "launchCaptureStatus"},
        {"params", {{"message", message}}},
    });
}

static CaptureOptions getDefaultCaptureOptions() {
    CaptureOptions opts = {};
    if (g_dll.GetDefaultCaptureOptions) {
        g_dll.GetDefaultCaptureOptions(&opts);
    }
    return opts;
}

static std::string protocolFromUrl(const std::string &url) {
    const size_t split = url.find("://");
    if (split == std::string::npos) return "";
    return url.substr(0, split);
}

static bool ensureParentDirectory(const std::string &filePath, std::string &errorMessage) {
    if (filePath.empty()) return true;
    try {
        const std::filesystem::path outPath(filePath);
        const std::filesystem::path parent = outPath.parent_path();
        if (!parent.empty()) {
            std::filesystem::create_directories(parent);
        }
        return true;
    } catch (const std::exception &e) {
        errorMessage = e.what();
        return false;
    }
}

static bool connectRemoteServer(const std::string &url, IRemoteServer **remote, std::string &errorMessage) {
    if (!g_dll.CreateRemoteServerConnection) {
        errorMessage = "RenderDoc remote server APIs are unavailable in the loaded DLL.";
        return false;
    }

    ResultDetails result = g_dll.CreateRemoteServerConnection(rdcstr(url.c_str()), remote);
    if (result.code == ResultCode::Succeeded && *remote) {
        return true;
    }

    const std::string protocol = protocolFromUrl(url);
    if (!protocol.empty() && g_dll.GetDeviceProtocolController) {
        if (IDeviceProtocolController *controller = g_dll.GetDeviceProtocolController(rdcstr(protocol.c_str()))) {
            emitStatusNote("Starting remote server on device...");
            ResultDetails startResult = controller->StartRemoteServer(rdcstr(url.c_str()));
            if (startResult.code == ResultCode::Succeeded) {
                result = g_dll.CreateRemoteServerConnection(rdcstr(url.c_str()), remote);
                if (result.code == ResultCode::Succeeded && *remote) {
                    return true;
                }
            } else {
                errorMessage = resultMessage(startResult);
                return false;
            }
        }
    }

    errorMessage = resultMessage(result);
    return false;
}

static ITargetControl *waitForTargetControl(const std::string &url, uint32_t ident, int timeoutMs) {
    if (!g_dll.CreateTargetControl) return nullptr;

    const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeoutMs);
    while (std::chrono::steady_clock::now() < deadline) {
        ITargetControl *target = g_dll.CreateTargetControl(
            rdcstr(url.c_str()), ident, rdcstr("renderdoc-for-vscode"), true);
        if (target) {
            return target;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(200));
    }

    return nullptr;
}

static void startRemoteKeepAlive(IRemoteServer *remote,
                                 std::atomic<bool> &keepRemoteAlive,
                                 std::thread &remotePingThread) {
    if (!remote) return;
    keepRemoteAlive.store(true, std::memory_order_release);
    remotePingThread = std::thread([remote, &keepRemoteAlive]() {
        while (keepRemoteAlive.load(std::memory_order_acquire)) {
            if (remote->Ping().code != ResultCode::Succeeded) {
                break;
            }
            std::this_thread::sleep_for(std::chrono::seconds(1));
        }
    });
}

static void stopRemoteKeepAlive(std::atomic<bool> &keepRemoteAlive,
                                std::thread &remotePingThread) {
    keepRemoteAlive.store(false, std::memory_order_release);
    if (remotePingThread.joinable()) {
        remotePingThread.join();
    }
}

static void clearLiveTargetSession() {
    if (g_liveTarget) {
        g_liveTarget->Shutdown();
        g_liveTarget = nullptr;
    }
    stopRemoteKeepAlive(g_liveRemoteKeepAlive, g_liveRemotePingThread);
    if (g_liveRemote) {
        g_liveRemote->ShutdownConnection();
        g_liveRemote = nullptr;
    }

    g_liveTargetUrl.clear();
    g_liveTargetName.clear();
    g_liveTargetAPI.clear();
    g_liveTargetPID = 0;
    g_liveTargetIdent = 0;
    g_liveTargetLocal = true;
}

static json currentLiveTargetJson() {
    if (!g_liveTarget) {
        return nullptr;
    }

    std::string targetName = rdcToStr(g_liveTarget->GetTarget());
    if (targetName.empty()) {
        targetName = g_liveTargetName;
    }
    std::string apiName = rdcToStr(g_liveTarget->GetAPI());
    if (apiName.empty()) {
        apiName = g_liveTargetAPI;
    }

    json result = {
        {"target", targetName},
        {"local", g_liveTargetLocal},
        {"pid", g_liveTarget->GetPID() ? g_liveTarget->GetPID() : g_liveTargetPID},
        {"ident", g_liveTargetIdent},
    };
    if (!apiName.empty()) {
        result["api"] = apiName;
    }
    if (!g_liveTargetUrl.empty()) {
        result["url"] = g_liveTargetUrl;
    }
    return result;
}

static json buildTriggerCaptureResponse(const TargetControlMessage &captureMessage,
                                       const std::string &finalCapturePath) {
    json result = currentLiveTargetJson();
    if (result.is_null()) {
        result = json::object();
    }
    result["capturePath"] = finalCapturePath;
    result["frameNumber"] = captureMessage.newCapture.frameNumber;
    const std::string apiName = rdcToStr(captureMessage.newCapture.api);
    if (!apiName.empty()) {
        result["api"] = apiName;
    }
    result["local"] = captureMessage.newCapture.local;
    return result;
}

static bool waitForCaptureMessage(ITargetControl *target,
                                  int timeoutSeconds,
                                  TargetControlMessage &captureMessage,
                                  std::string &errorMessage) {
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(timeoutSeconds);
    while (std::chrono::steady_clock::now() < deadline && target && target->Connected()) {
        TargetControlMessage message = target->ReceiveMessage(nullptr);
        if (message.type == TargetControlMessageType::NewCapture) {
            captureMessage = message;
            return true;
        }
        if (message.type == TargetControlMessageType::RegisterAPI && !rdcToStr(message.apiUse.name).empty()) {
            emitStatusNote("Target initialised API: " + rdcToStr(message.apiUse.name));
        }
        if (message.type == TargetControlMessageType::Busy) {
            emitStatusNote("Target is busy: " + rdcToStr(message.busy.clientName));
        }
    }

    errorMessage = "Timed out waiting for the target to produce a capture.";
    return false;
}

static bool copyCaptureToLocal(IRemoteServer *remote,
                               const TargetControlMessage &captureMessage,
                               const std::string &localCopyPath,
                               std::string &finalCapturePath,
                               std::string &errorMessage) {
    finalCapturePath = rdcToStr(captureMessage.newCapture.path);
    if (captureMessage.newCapture.local) {
        return true;
    }
    if (!remote) {
        errorMessage = "Remote capture completed but no remote server connection is available for file copy.";
        return false;
    }
    if (localCopyPath.empty()) {
        errorMessage = "localCopyPath is required for remote captures.";
        return false;
    }

    emitStatusNote("Copying capture back to the local machine...");
    remote->CopyCaptureFromRemote(captureMessage.newCapture.path, rdcstr(localCopyPath.c_str()), nullptr);
    finalCapturePath = localCopyPath;
    return true;
}

static json buildCaptureResponse(int id,
                                 const std::string &fallbackTarget,
                                 ITargetControl *target,
                                 const TargetControlMessage &captureMessage,
                                 const std::string &finalCapturePath) {
    std::string targetName = fallbackTarget;
    if (target) {
        const std::string liveTarget = rdcToStr(target->GetTarget());
        if (!liveTarget.empty()) {
            targetName = liveTarget;
        }
    }

    json result = {
        {"capturePath", finalCapturePath},
        {"target", targetName},
        {"local", captureMessage.newCapture.local},
        {"frameNumber", captureMessage.newCapture.frameNumber},
    };
    const std::string apiName = rdcToStr(captureMessage.newCapture.api);
    if (!apiName.empty()) {
        result["api"] = apiName;
    }
    return makeResult(id, result);
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
    // Special / packed / block-compressed types
    switch(f.type) {
        case ResourceFormatType::BC1:         return f.compType == CompType::UNormSRGB ? "BC1_SRGB" : "BC1_UNORM";
        case ResourceFormatType::BC2:         return f.compType == CompType::UNormSRGB ? "BC2_SRGB" : "BC2_UNORM";
        case ResourceFormatType::BC3:         return f.compType == CompType::UNormSRGB ? "BC3_SRGB" : "BC3_UNORM";
        case ResourceFormatType::BC4:         return f.compType == CompType::SNorm  ? "BC4_SNORM" : "BC4_UNORM";
        case ResourceFormatType::BC5:         return f.compType == CompType::SNorm  ? "BC5_SNORM" : "BC5_UNORM";
        case ResourceFormatType::BC6:         return f.compType == CompType::Float  ? "BC6H_SF16" : "BC6H_UF16";
        case ResourceFormatType::BC7:         return f.compType == CompType::UNormSRGB ? "BC7_SRGB" : "BC7_UNORM";
        case ResourceFormatType::ETC2:        return f.compType == CompType::UNormSRGB ? "ETC2_SRGB" : "ETC2_UNORM";
        case ResourceFormatType::EAC:         return f.compCount == 1 ? "EAC_R11_UNORM" : "EAC_RG11_UNORM";
        case ResourceFormatType::ASTC:        return f.compType == CompType::UNormSRGB ? "ASTC_SRGB" : "ASTC_UNORM";
        case ResourceFormatType::PVRTC:       return "PVRTC";
        case ResourceFormatType::R10G10B10A2: return f.compType == CompType::UNorm ? "R10G10B10A2_UNORM" : "R10G10B10A2_UINT";
        case ResourceFormatType::R11G11B10:   return "R11G11B10_FLOAT";
        case ResourceFormatType::R9G9B9E5:    return "R9G9B9E5_FLOAT";
        case ResourceFormatType::R5G6B5:      return "R5G6B5_UNORM";
        case ResourceFormatType::R5G5B5A1:    return "R5G5B5A1_UNORM";
        case ResourceFormatType::R4G4B4A4:    return "R4G4B4A4_UNORM";
        case ResourceFormatType::R4G4:        return "R4G4_UNORM";
        case ResourceFormatType::D16S8:       return "D16S8";
        case ResourceFormatType::D24S8:       return "D24S8";
        case ResourceFormatType::D32S8:       return "D32S8";
        case ResourceFormatType::S8:          return "S8_UINT";
        case ResourceFormatType::A8:          return "A8_UNORM";
        case ResourceFormatType::YUV8:        return "YUV8";
        case ResourceFormatType::YUV10:       return "YUV10";
        case ResourceFormatType::YUV12:       return "YUV12";
        case ResourceFormatType::YUV16:       return "YUV16";
        case ResourceFormatType::Undefined:   return "Undefined";
        default: break;
    }
    // Regular multi-component types
    std::string s;
    if (f.compCount > 0) s += "R";
    if (f.compCount > 1) s += "G";
    if (f.compCount > 2) s += "B";
    if (f.compCount > 3) s += "A";
    s += std::to_string(f.compByteWidth * 8);
    switch(f.compType) {
        case CompType::Float:    s += "_FLOAT";  break;
        case CompType::UNorm:    s += "_UNORM";  break;
        case CompType::UNormSRGB:s += "_SRGB";   break;
        case CompType::SNorm:    s += "_SNORM";  break;
        case CompType::UInt:     s += "_UINT";   break;
        case CompType::SInt:     s += "_SINT";   break;
        case CompType::Depth:    s += "_DEPTH";  break;
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
static const char *texTypeStr(TextureType tt) {
    switch(tt) {
        case TextureType::Buffer:          return "Buffer";
        case TextureType::Texture1D:       return "Texture1D";
        case TextureType::Texture1DArray:  return "Texture1DArray";
        case TextureType::Texture2D:       return "Texture2D";
        case TextureType::TextureRect:     return "TextureRect";
        case TextureType::Texture2DArray:  return "Texture2DArray";
        case TextureType::Texture2DMS:     return "Texture2DMS";
        case TextureType::Texture2DMSArray:return "Texture2DMSArray";
        case TextureType::Texture3D:       return "Texture3D";
        case TextureType::TextureCube:     return "TextureCube";
        case TextureType::TextureCubeArray:return "TextureCubeArray";
        default:                           return "Unknown";
    }
}

static std::string texUsageStr(TextureCategory flags) {
    std::string s;
    if ((flags & TextureCategory::ShaderRead)      != TextureCategory::NoFlags) s += "ShaderRead|";
    if ((flags & TextureCategory::ColorTarget)     != TextureCategory::NoFlags) s += "ColorTarget|";
    if ((flags & TextureCategory::DepthTarget)     != TextureCategory::NoFlags) s += "DepthTarget|";
    if ((flags & TextureCategory::ShaderReadWrite) != TextureCategory::NoFlags) s += "ShaderReadWrite|";
    if ((flags & TextureCategory::SwapBuffer)      != TextureCategory::NoFlags) s += "SwapBuffer|";
    if (!s.empty()) s.pop_back(); // remove trailing '|'
    return s.empty() ? "None" : s;
}

static json textureToJson(const TextureDescription &t) {
    json j;
    j["resourceId"]  = resIdToU64(t.resourceId);
    j["name"]        = resNameLookup(t.resourceId);
    j["format"]      = formatToStr(t.format);
    j["compCount"]   = t.format.compCount;
    j["textureType"] = texTypeStr(t.type);
    j["width"]       = t.width;
    j["height"]      = t.height;
    j["depth"]       = t.depth;
    j["mips"]        = t.mips;
    j["arraySize"]   = t.arraysize;
    j["cubemap"]     = t.cubemap;
    j["msaaSamples"] = t.msSamp > 1 ? t.msSamp : 1;
    j["msaaQuality"] = t.msQual;
    j["byteSize"]    = t.byteSize;
    j["usage"]       = texUsageStr(t.creationFlags);
    j["isSwapBuffer"]= (t.creationFlags & TextureCategory::SwapBuffer) != TextureCategory::NoFlags;
    j["isDepthTarget"]=(t.creationFlags & TextureCategory::DepthTarget) != TextureCategory::NoFlags;
    j["isColorTarget"]=(t.creationFlags & TextureCategory::ColorTarget) != TextureCategory::NoFlags;
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
    if (g_thumbOut) { g_thumbOut->Shutdown(); g_thumbOut = nullptr; }
    g_overlayOut = nullptr; g_overlayW = 0; g_overlayH = 0;
    resetEventCache();
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
    resetEventCache();  // next request sets frame event from clean state
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
    const uint32_t totalTextureCount = (uint32_t)textures.size();
    json arr = json::array();
    for (size_t i = 0; i < textures.size(); i++)
        arr.push_back(textureToJson(textures[i]));

    return makeResult(id, {{"textures", arr}, {"count", textures.size()}});
}

static void countContributingEvents(const ActionDescription &action,
                                    uint32_t &drawCount,
                                    uint32_t &dispatchCount,
                                    uint32_t &diagnosticCount) {
    const ActionFlags diagnosticMask =
        ActionFlags::SetMarker | ActionFlags::PushMarker | ActionFlags::PopMarker;
    ActionFlags diagnosticMasked = action.flags & diagnosticMask;
    if (diagnosticMasked != ActionFlags::NoFlags)
        diagnosticCount += 1;

    if (action.flags & (ActionFlags::MeshDispatch | ActionFlags::Drawcall))
        drawCount += 1;

    if (action.flags & ActionFlags::Dispatch)
        dispatchCount += 1;

    for (size_t i = 0; i < action.children.size(); i++)
        countContributingEvents(action.children[i], drawCount, dispatchCount, diagnosticCount);
}

static ActionFlags workloadActionMask() {
    return ActionFlags::Clear | ActionFlags::Drawcall | ActionFlags::Dispatch |
           ActionFlags::MeshDispatch | ActionFlags::Present | ActionFlags::Copy |
           ActionFlags::Resolve | ActionFlags::GenMips | ActionFlags::DispatchRay |
           ActionFlags::BuildAccStruct;
}

static void collectWorkloadEventIds(const ActionDescription &action, std::set<uint32_t> &eventIds) {
    if ((action.flags & workloadActionMask()) != ActionFlags::NoFlags && action.eventId > 0)
        eventIds.insert(action.eventId);

    for (size_t i = 0; i < action.children.size(); i++)
        collectWorkloadEventIds(action.children[i], eventIds);
}

static std::string buildFramebufferSignature(const ActionDescription &action) {
    std::ostringstream sig;
    bool hasOutputs = false;

    for (size_t i = 0; i < action.outputs.size(); i++) {
        const ResourceId output = action.outputs[i];
        if (output != ResourceId())
            hasOutputs = true;
        sig << resIdToU64(output) << ',';
    }

    if (action.depthOut != ResourceId())
        hasOutputs = true;
    sig << 'd' << resIdToU64(action.depthOut);

    if (!hasOutputs && action.copyDestination != ResourceId()) {
        hasOutputs = true;
        sig << "|copy:" << resIdToU64(action.copyDestination);
    }

    return hasOutputs ? sig.str() : std::string();
}

static void countRenderTargetSwitches(const ActionDescription &action,
                                      std::string &lastSignature,
                                      uint32_t &switchCount) {
    if ((action.flags & workloadActionMask()) != ActionFlags::NoFlags && action.eventId > 0) {
        const std::string currentSignature = buildFramebufferSignature(action);
        if (!currentSignature.empty()) {
            if (!lastSignature.empty() && currentSignature != lastSignature)
                switchCount += 1;
            lastSignature = currentSignature;
        }
    }

    for (size_t i = 0; i < action.children.size(); i++)
        countRenderTargetSwitches(action.children[i], lastSignature, switchCount);
}

static bool estimateGpuFrameTimeUs(const rdcarray<ActionDescription> &actions, double &estimatedGpuTimeUs) {
    if (!g_replay)
        return false;

    rdcarray<GPUCounter> available = g_replay->EnumerateCounters();
    bool found = false;
    for (size_t i = 0; i < available.size(); i++) {
        if (available[i] == GPUCounter::EventGPUDuration) {
            found = true;
            break;
        }
    }
    if (!found)
        return false;

    std::set<uint32_t> workloadEventIds;
    for (size_t i = 0; i < actions.size(); i++)
        collectWorkloadEventIds(actions[i], workloadEventIds);
    if (workloadEventIds.empty())
        return false;

    rdcarray<GPUCounter> counters;
    counters.push_back(GPUCounter::EventGPUDuration);
    rdcarray<CounterResult> results = g_replay->FetchCounters(counters);

    estimatedGpuTimeUs = 0.0;
    for (size_t i = 0; i < results.size(); i++) {
        const CounterResult &r = results[i];
        if (r.counter != GPUCounter::EventGPUDuration)
            continue;
        if (workloadEventIds.find(r.eventId) == workloadEventIds.end())
            continue;

        const double durationUs = r.value.d * 1000000.0;
        if (durationUs >= 0.0)
            estimatedGpuTimeUs += durationUs;
    }

    return estimatedGpuTimeUs > 0.0;
}

static json handleGetCaptureStatistics(int id) {
    if (!g_replay)
        return makeError(id, -1, "No replay active");

    const rdcarray<ActionDescription> &actions = g_replay->GetRootActions();
    uint32_t drawCount = 0;
    uint32_t dispatchCount = 0;
    uint32_t diagnosticCount = 0;
    uint32_t renderTargetSwitches = 0;
    std::string lastFramebufferSignature;
    for (size_t i = 0; i < actions.size(); i++) {
        countContributingEvents(actions[i], drawCount, dispatchCount, diagnosticCount);
        countRenderTargetSwitches(actions[i], lastFramebufferSignature, renderTargetSwitches);
    }
    uint32_t maxEventId = findMaxEventId(actions);

    uint32_t apiCallCount = 0;
    if (maxEventId > (drawCount + dispatchCount + diagnosticCount))
        apiCallCount = maxEventId - (drawCount + dispatchCount + diagnosticCount);

    const rdcarray<TextureDescription> &textures = g_replay->GetTextures();
    const uint32_t totalTextureCount = (uint32_t)textures.size();
    uint64_t renderTargetBytes = 0;
    uint64_t textureBytes = 0;
    uint64_t largeTextureBytes = 0;
    int renderTargetCount = 0;
    float avgTextureWidth = 0.0f, avgTextureHeight = 0.0f;
    float avgLargeTextureWidth = 0.0f, avgLargeTextureHeight = 0.0f;
    int textureCount = 0, largeTextureCount = 0;
    for (size_t i = 0; i < textures.size(); i++) {
        const TextureDescription &t = textures[i];
        if (t.creationFlags & (TextureCategory::ColorTarget | TextureCategory::DepthTarget)) {
            renderTargetCount++;
            renderTargetBytes += t.byteSize;
        } else {
            avgTextureWidth += (float)t.width;
            avgTextureHeight += (float)t.height;
            textureCount++;
            textureBytes += t.byteSize;
            if (t.width > 32 && t.height > 32) {
                avgLargeTextureWidth += (float)t.width;
                avgLargeTextureHeight += (float)t.height;
                largeTextureCount++;
                largeTextureBytes += t.byteSize;
            }
        }
    }
    if (textureCount > 0) {
        avgTextureWidth /= textureCount;
        avgTextureHeight /= textureCount;
    }
    if (largeTextureCount > 0) {
        avgLargeTextureWidth /= largeTextureCount;
        avgLargeTextureHeight /= largeTextureCount;
    }

    const rdcarray<BufferDescription> &buffers = g_replay->GetBuffers();
    uint64_t indexBufferBytes = 0;
    uint64_t vertexBufferBytes = 0;
    uint64_t bufferBytes = 0;
    for (size_t i = 0; i < buffers.size(); i++) {
        const BufferDescription &b = buffers[i];
        bufferBytes += b.length;
        if (b.creationFlags & BufferCategory::Index)
            indexBufferBytes += b.length;
        if (b.creationFlags & BufferCategory::Vertex)
            vertexBufferBytes += b.length;
    }

    const FrameDescription frameInfo = g_replay->GetFrameInfo();
    float drawRatio = 0.0f;
    if (drawCount + dispatchCount > 0)
        drawRatio = (float)apiCallCount / (float)(drawCount + dispatchCount);

    double estimatedGpuTimeUs = 0.0;
    const bool estimatedGpuTimeAvailable = estimateGpuFrameTimeUs(actions, estimatedGpuTimeUs);

    json result = {
        {"compressedFileSize", (double)frameInfo.compressedFileSize},
        {"uncompressedFileSize", (double)frameInfo.uncompressedFileSize},
        {"persistentSize", (double)frameInfo.persistentSize},
        {"initDataSize", (double)frameInfo.initDataSize},
        {"drawCount", drawCount},
        {"dispatchCount", dispatchCount},
        {"apiCallCount", apiCallCount},
        {"apiDrawDispatchRatio", drawRatio},
        {"textureCount", totalTextureCount},
        {"textureBytes", (double)textureBytes},
        {"largeTextureBytes", (double)largeTextureBytes},
        {"renderTargetCount", renderTargetCount},
        {"renderTargetBytes", (double)renderTargetBytes},
        {"avgTextureWidth", avgTextureWidth},
        {"avgTextureHeight", avgTextureHeight},
        {"avgLargeTextureWidth", avgLargeTextureWidth},
        {"avgLargeTextureHeight", avgLargeTextureHeight},
        {"bufferCount", (uint32_t)buffers.size()},
        {"bufferBytes", (double)bufferBytes},
        {"indexBufferBytes", (double)indexBufferBytes},
        {"vertexBufferBytes", (double)vertexBufferBytes},
        {"totalGpuBytes", (double)(textureBytes + renderTargetBytes + bufferBytes)},
        {"renderTargetSwitches", renderTargetSwitches},
        {"estimatedGpuTimeAvailable", estimatedGpuTimeAvailable},
    };

    if (estimatedGpuTimeAvailable)
        result["estimatedGpuTimeUs"] = estimatedGpuTimeUs;

    if (frameInfo.stats.recorded) {
        uint32_t numConstantSets = 0;
        uint32_t numSamplerSets = 0;
        uint32_t numResourceSets = 0;
        uint32_t numShaderSets = 0;
        for (int s = 0; s < (int)frameInfo.stats.constants.size(); s++) {
            numConstantSets += frameInfo.stats.constants[s].calls;
            numSamplerSets += frameInfo.stats.samplers[s].calls;
            numResourceSets += frameInfo.stats.resources[s].calls;
            numShaderSets += frameInfo.stats.shaders[s].calls;
        }
        result["apiSummary"] = {
            {"indexVertexSets", frameInfo.stats.indices.calls + frameInfo.stats.vertices.calls + frameInfo.stats.layouts.calls},
            {"constantSets", numConstantSets},
            {"samplerSets", numSamplerSets},
            {"resourceSets", numResourceSets},
            {"shaderSets", numShaderSets},
            {"blendSets", frameInfo.stats.blends.calls},
            {"depthStencilSets", frameInfo.stats.depths.calls},
            {"rasterizationSets", frameInfo.stats.rasters.calls},
            {"resourceUpdates", frameInfo.stats.updates.calls},
            {"outputSets", frameInfo.stats.outputs.calls},
        };
    }

    return makeResult(id, result);
}

static json handleListCaptureTargets(int id) {
    json targets = json::array();
    if (!g_dll.GetSupportedDeviceProtocols || !g_dll.GetDeviceProtocolController) {
        return makeResult(id, {{"targets", targets}});
    }

    rdcarray<rdcstr> protocols;
    g_dll.GetSupportedDeviceProtocols(&protocols);

    for (size_t protocolIndex = 0; protocolIndex < protocols.size(); protocolIndex++) {
        const std::string requestedProtocol = rdcToStr(protocols[protocolIndex]);
        IDeviceProtocolController *controller =
            g_dll.GetDeviceProtocolController(rdcstr(requestedProtocol.c_str()));
        if (!controller) continue;

        const std::string protocolName = rdcToStr(controller->GetProtocolName());
        const rdcarray<rdcstr> devices = controller->GetDevices();

        for (size_t deviceIndex = 0; deviceIndex < devices.size(); deviceIndex++) {
            const std::string deviceId = rdcToStr(devices[deviceIndex]);
            const std::string url = protocolName + "://" + deviceId;
            std::string friendlyName = rdcToStr(controller->GetFriendlyName(rdcstr(url.c_str())));
            if (friendlyName.empty()) {
                friendlyName = rdcToStr(controller->GetFriendlyName(rdcstr(deviceId.c_str())));
            }

            targets.push_back({
                {"protocol", protocolName},
                {"url", url},
                {"id", deviceId},
                {"name", friendlyName.empty() ? deviceId : friendlyName},
                {"supported", controller->IsSupported(rdcstr(url.c_str()))},
                {"supportsMultiplePrograms", controller->SupportsMultiplePrograms(rdcstr(url.c_str()))},
            });
        }
    }

    return makeResult(id, {{"targets", targets}});
}

static json handleListAttachTargets(int id, const json &params) {
    json targets = json::array();
    if (!g_dll.EnumerateRemoteTargets || !g_dll.CreateTargetControl) {
        return makeResult(id, {{"targets", targets}});
    }

    const std::string url = params.value("url", "");
    uint32_t nextIdent = 0;
    for (;;) {
        const uint32_t prevIdent = nextIdent;
        nextIdent = g_dll.EnumerateRemoteTargets(rdcstr(url.c_str()), nextIdent);
        if (nextIdent == 0 || nextIdent <= prevIdent) {
            break;
        }

        ITargetControl *conn = g_dll.CreateTargetControl(
            rdcstr(url.c_str()), nextIdent, rdcstr("renderdoc-for-vscode"), false);
        if (!conn) {
            continue;
        }

        json entry = {
            {"url", url},
            {"ident", nextIdent},
            {"pid", conn->GetPID()},
            {"target", rdcToStr(conn->GetTarget())},
            {"api", rdcToStr(conn->GetAPI())},
        };
        const std::string busy = rdcToStr(conn->GetBusyClient());
        if (!busy.empty()) {
            entry["busyClient"] = busy;
        }
        targets.push_back(entry);
        conn->Shutdown();
    }

    return makeResult(id, {{"targets", targets}});
}

static json handleLaunchCapture(int id, const json &params) {
    if (!g_dll.isLoaded())
        return makeError(id, -1, "DLL not loaded. Call init first.");
    if (!g_dll.ExecuteAndInject || !g_dll.CreateTargetControl)
        return makeError(id, -2, "Required RenderDoc launch APIs are unavailable.");

    const std::string url = params.value("url", "");
    const std::string executable = params.value("executable", "");
    const std::string workingDir = params.value("workingDir", "");
    const std::string cmdLine = params.value("cmdLine", "");
    const std::string captureFileTemplate = params.value("captureFileTemplate", "");

    if (executable.empty())
        return makeError(id, -3, "executable is required");

    std::string directoryError;
    if (!ensureParentDirectory(captureFileTemplate, directoryError)) {
        return makeError(id, -4, "Failed to create capture output directory: " + directoryError);
    }

    clearLiveTargetSession();

    IRemoteServer *remote = nullptr;
    ITargetControl *target = nullptr;

    auto cleanup = [&]() {
        if (target) {
            target->Shutdown();
            target = nullptr;
        }
        if (remote) {
            remote->ShutdownConnection();
            remote = nullptr;
        }
    };

    try {
        emitStatusNote(url.empty() ? "Launching local program..." : "Connecting to remote device...");

        ExecuteResult executeResult = {};
        rdcarray<EnvironmentModification> env;
        CaptureOptions options = getDefaultCaptureOptions();

        if (!url.empty()) {
            std::string remoteError;
            if (!connectRemoteServer(url, &remote, remoteError)) {
                cleanup();
                return makeError(id, -6, "Failed to connect to remote device: " + remoteError);
            }

            emitStatusNote("Launching remote target for capture...");
            executeResult = remote->ExecuteAndInject(
                rdcstr(executable.c_str()),
                rdcstr(workingDir.c_str()),
                rdcstr(cmdLine.c_str()),
                env,
                options);
        } else {
            emitStatusNote("Launching local target for capture...");
            executeResult = g_dll.ExecuteAndInject(
                rdcstr(executable.c_str()),
                rdcstr(workingDir.c_str()),
                rdcstr(cmdLine.c_str()),
                env,
                rdcstr(captureFileTemplate.c_str()),
                options,
                false);
        }

        if (executeResult.result.code != ResultCode::Succeeded) {
            cleanup();
            return makeError(id, -7, "Launch failed: " + resultMessage(executeResult.result));
        }

        emitStatusNote("Waiting for target control connection...");
        target = waitForTargetControl(url, executeResult.ident, 15000);
        if (!target) {
            cleanup();
            return makeError(id, -8, "Failed to connect to target control for launched process.");
        }

        g_liveRemote = remote;
        g_liveTarget = target;
        g_liveTargetUrl = url;
        g_liveTargetIdent = executeResult.ident;
        g_liveTargetLocal = url.empty();
        g_liveTargetName = rdcToStr(target->GetTarget());
        g_liveTargetAPI = rdcToStr(target->GetAPI());
        g_liveTargetPID = target->GetPID();
        startRemoteKeepAlive(g_liveRemote, g_liveRemoteKeepAlive, g_liveRemotePingThread);

        remote = nullptr;
        target = nullptr;
        return makeResult(id, currentLiveTargetJson());
    } catch (const std::exception &e) {
        cleanup();
        clearLiveTargetSession();
        return makeError(id, -12, e.what());
    }
}

static json handleAttachCapture(int id, const json &params) {
    if (!g_dll.isLoaded())
        return makeError(id, -1, "DLL not loaded. Call init first.");
    if (!g_dll.CreateTargetControl)
        return makeError(id, -2, "RenderDoc target control APIs are unavailable.");

    const std::string url = params.value("url", "");
    const uint32_t ident = params.value("ident", (uint32_t)0);
    const uint32_t pid = params.value("pid", (uint32_t)0);
    const std::string processName = params.value("processName", "");
    const std::string captureFileTemplate = params.value("captureFileTemplate", "");

    if (url.empty() && (!g_dll.InjectIntoProcess || pid == 0))
        return makeError(id, -3, "pid is required for local attach capture.");
    if (!url.empty() && ident == 0)
        return makeError(id, -4, "ident is required for remote attach capture.");

    std::string directoryError;
    if (!ensureParentDirectory(captureFileTemplate, directoryError)) {
        return makeError(id, -5, "Failed to create capture output directory: " + directoryError);
    }

    clearLiveTargetSession();

    IRemoteServer *remote = nullptr;
    ITargetControl *target = nullptr;

    auto cleanup = [&]() {
        if (target) {
            target->Shutdown();
            target = nullptr;
        }
        if (remote) {
            remote->ShutdownConnection();
            remote = nullptr;
        }
    };

    try {
        if (!url.empty()) {
            emitStatusNote("Connecting to remote device...");
            std::string remoteError;
            if (!connectRemoteServer(url, &remote, remoteError)) {
                cleanup();
                return makeError(id, -7, "Failed to connect to remote device: " + remoteError);
            }
            emitStatusNote("Connecting to remote target...");
            target = waitForTargetControl(url, ident, 15000);
            if (!target) {
                cleanup();
                return makeError(id, -8, "Failed to connect to the selected remote target.");
            }
        } else {
            emitStatusNote("Injecting into local process...");
            rdcarray<EnvironmentModification> env;
            CaptureOptions options = getDefaultCaptureOptions();
            ExecuteResult injectResult = g_dll.InjectIntoProcess(
                pid,
                env,
                rdcstr(captureFileTemplate.c_str()),
                options,
                false);
            if (injectResult.result.code != ResultCode::Succeeded) {
                cleanup();
                return makeError(id, -9, "Attach failed: " + resultMessage(injectResult.result));
            }

            emitStatusNote("Waiting for target control connection...");
            target = waitForTargetControl("", injectResult.ident, 15000);
            if (!target) {
                cleanup();
                return makeError(id, -10, "Failed to connect to target control for attached process.");
            }
        }

        g_liveRemote = remote;
        g_liveTarget = target;
        g_liveTargetUrl = url;
        g_liveTargetIdent = url.empty() ? 0 : ident;
        g_liveTargetLocal = url.empty();
        g_liveTargetName = rdcToStr(target->GetTarget());
        if (g_liveTargetName.empty()) {
            g_liveTargetName = processName.empty() ? std::to_string(pid) : processName;
        }
        g_liveTargetAPI = rdcToStr(target->GetAPI());
        g_liveTargetPID = target->GetPID() ? target->GetPID() : pid;
        startRemoteKeepAlive(g_liveRemote, g_liveRemoteKeepAlive, g_liveRemotePingThread);

        remote = nullptr;
        target = nullptr;
        return makeResult(id, currentLiveTargetJson());
    } catch (const std::exception &e) {
        cleanup();
        clearLiveTargetSession();
        return makeError(id, -13, e.what());
    }
}

static json handleGetLiveTarget(int id) {
    return makeResult(id, currentLiveTargetJson());
}

static json handleDisconnectLiveTarget(int id) {
    clearLiveTargetSession();
    return makeResult(id, {{"disconnected", true}});
}

static json handleTriggerCapture(int id, const json &params) {
    if (!g_liveTarget) {
        return makeError(id, -1, "No live target is connected. Launch or attach first.");
    }

    const std::string localCopyPath = params.value("localCopyPath", "");
    const std::string trigger = params.value("trigger", "immediate");
    const uint32_t frameNumber = params.value("frameNumber", (uint32_t)1);
    const double delaySeconds = params.value("delaySeconds", 3.0);

    std::string directoryError;
    if (!ensureParentDirectory(localCopyPath, directoryError)) {
        return makeError(id, -2, "Failed to create local copy directory: " + directoryError);
    }

    if (trigger == "delay") {
        emitStatusNote("Waiting before triggering capture...");
        std::this_thread::sleep_for(std::chrono::milliseconds((int)std::round(delaySeconds * 1000.0)));
        emitStatusNote("Triggering capture...");
        g_liveTarget->TriggerCapture(1);
    } else if (trigger == "frame") {
        emitStatusNote("Queueing capture on frame " + std::to_string(frameNumber) + "...");
        g_liveTarget->QueueCapture(frameNumber, 1);
    } else {
        emitStatusNote("Triggering capture...");
        g_liveTarget->TriggerCapture(1);
    }

    emitStatusNote("Waiting for capture to complete...");
    TargetControlMessage captureMessage = {};
    std::string captureError;
    if (!waitForCaptureMessage(g_liveTarget, 90, captureMessage, captureError)) {
        return makeError(id, -3, captureError);
    }

    std::string finalCapturePath;
    if (!copyCaptureToLocal(g_liveRemote, captureMessage, localCopyPath, finalCapturePath, captureError)) {
        return makeError(id, -4, captureError);
    }

    return makeResult(id, buildTriggerCaptureResponse(captureMessage, finalCapturePath));
}

// Returns per-event GPU duration in microseconds.
// Uses GPUCounter::EventGPUDuration (counter=1). This re-replays the frame
// with GPU timer queries; it may take several seconds on large captures.
static json handleGetTimings(int id) {
    if (!g_replay)
        return makeError(id, -1, "No replay active");

    rdcarray<GPUCounter> counters;
    counters.push_back(GPUCounter::EventGPUDuration);

    // Confirm the counter is available (some APIs may not support it)
    rdcarray<GPUCounter> available = g_replay->EnumerateCounters();
    bool found = false;
    for (size_t i = 0; i < available.size(); i++) {
        if (available[i] == GPUCounter::EventGPUDuration) { found = true; break; }
    }
    if (!found)
        return makeError(id, -2, "EventGPUDuration counter not available for this capture");

    rdcarray<CounterResult> results = g_replay->FetchCounters(counters);

    json arr = json::array();
    for (size_t i = 0; i < results.size(); i++) {
        const CounterResult &r = results[i];
        if (r.counter != GPUCounter::EventGPUDuration) continue;
        
        // Native RenderDoc backend always stores duration as double in CounterResult union.
        // Therefore, we can bypass CompType/enum checking here, mirroring qrenderdoc's behavior.
        // NOTE: RenderDoc returns EventGPUDuration natively in SECONDS! We must convert to microseconds.
        double us = r.value.d * 1000000.0;
        
        // RenderDoc backends fallback to -1.0 for invalid/unavailable queries.
        if (us < 0.0) continue;
        
        json entry;
        entry["eventId"]    = r.eventId;
        entry["durationUs"] = us;
        arr.push_back(entry);
    }
    return makeResult(id, {{"timings", arr}, {"count", arr.size()}});
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
    ensureEvent(eventId);

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

// Convert a single RGBA channel into a visible grayscale preview.
// channelExtract: -1=preserve RGBA, 0=R, 1=G, 2=B, 3=A
static void applyChannelExtractToRGBA(std::vector<uint8_t> &rgba, int channelExtract) {
    if (channelExtract < 0 || channelExtract > 3) return;
    const size_t pixelCount = rgba.size() / 4;
    for (size_t i = 0; i < pixelCount; i++) {
        uint8_t *px = &rgba[i * 4];
        const uint8_t value = px[channelExtract];
        px[0] = value;
        px[1] = value;
        px[2] = value;
        px[3] = 255;
    }
}

// GPU-render a texture to PNG via IReplayOutput at its native dimensions.
// Used as a fallback when SaveTexture fails (e.g. backbuffer / GPU-only resources).
// Uses IReplayOutput::DrawThumbnail which manages its own internal headless output windows
// and correctly handles depth textures (renders depth value to R channel).
// channelExtract: -1=all channels, 0=R, 1=G, 2=B, 3=A
// isDepthFmt: when true, converts the R-only depth output to grayscale for better display.
static bool renderTextureGPU(ResourceId resId, uint32_t mip,
                              uint32_t width, uint32_t height, uint32_t samples,
                              int channelExtract, bool isDepthFmt,
                              std::vector<uint8_t> &pngOut) {
    if (!g_replay || width == 0 || height == 0) return false;

    // Keep a persistent headless output at the requested dimensions.
    if (!g_overlayOut) {
        WindowingData win = CreateHeadlessWindowingData((int32_t)width, (int32_t)height);
        g_overlayOut = g_replay->CreateOutput(win, ReplayOutputType::Texture);
        if (!g_overlayOut) return false;
        g_overlayW = (int32_t)width;
        g_overlayH = (int32_t)height;
    }

    if (g_overlayW != (int32_t)width || g_overlayH != (int32_t)height) {
        g_overlayOut->Shutdown();
        WindowingData win = CreateHeadlessWindowingData((int32_t)width, (int32_t)height);
        g_overlayOut = g_replay->CreateOutput(win, ReplayOutputType::Texture);
        if (!g_overlayOut) return false;
        g_overlayW = (int32_t)width;
        g_overlayH = (int32_t)height;
    }

    Subresource sub = {};
    sub.mip    = mip;
    sub.slice  = 0;
    sub.sample = (samples > 1) ? TextureDisplay::ResolveSamples : 0u;

    TextureDisplay disp = {};
    disp.resourceId           = resId;
    disp.typeCast             = CompType::Typeless;
    disp.scale                = 1.0f;
    disp.red                  = (channelExtract < 0 || channelExtract == 0);
    disp.green                = (channelExtract < 0 || channelExtract == 1);
    disp.blue                 = (channelExtract < 0 || channelExtract == 2);
    disp.alpha                = (channelExtract == 3);
    disp.flipY                = false;
    disp.hdrMultiplier        = -1.0f;
    disp.linearDisplayAsGamma = true;
    disp.rangeMin             = 0.0f;
    disp.rangeMax             = 1.0f;
    disp.subresource          = sub;
    disp.overlay              = DebugOverlay::NoOverlay;

    g_overlayOut->SetTextureDisplay(disp);
    g_overlayOut->Display();
    bytebuf pixels = g_overlayOut->ReadbackOutputTexture();
    fprintf(stderr, "[bridge] ReadbackOutputTexture: %ux%u -> %zu bytes (channel=%d)\n",
            width, height, pixels.size(), channelExtract);
    if (pixels.empty()) return false;

    const size_t pixelCount = (size_t)width * height;
    const bool rgbaReadback = pixels.size() >= pixelCount * 4;
    const bool rgbReadback = pixels.size() >= pixelCount * 3;
    if (!rgbaReadback && !rgbReadback) return false;

    std::vector<uint8_t> rgba(pixelCount * 4, 255);
    const uint8_t* src = pixels.data();

    if (rgbaReadback) {
        memcpy(rgba.data(), src, pixelCount * 4);
        if (channelExtract >= 0) {
            applyChannelExtractToRGBA(rgba, channelExtract);
        }
    } else {
        for (size_t i = 0; i < pixelCount; i++) {
            rgba[i * 4 + 0] = src[i * 3 + 0];
            rgba[i * 4 + 1] = src[i * 3 + 1];
            rgba[i * 4 + 2] = src[i * 3 + 2];
            rgba[i * 4 + 3] = 255;
        }
        if (channelExtract >= 0) {
            const int sourceChannel = channelExtract == 3 ? 0 : channelExtract;
            applyChannelExtractToRGBA(rgba, sourceChannel);
        } else if (isDepthFmt) {
            applyChannelExtractToRGBA(rgba, 0);
        }
    }

    return encodePNGToMemory(rgba, width, height, pngOut);
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
        ensureEvent(eventId);
    }

    // Get texture info
    const rdcarray<TextureDescription> &textures = g_replay->GetTextures();
    uint32_t width = 0, height = 0;
    uint32_t compCount = 0;
    uint32_t samples = 1;
    ResourceFormatType fmtType = ResourceFormatType::Undefined;
    CompType compType = CompType::Typeless;
    std::string format;
    for (size_t i = 0; i < textures.size(); i++) {
        if (textures[i].resourceId == resId) {
            width = textures[i].width;
            height = textures[i].height;
            compCount = textures[i].format.compCount;
            samples = textures[i].msSamp > 0 ? textures[i].msSamp : 1;
            fmtType = textures[i].format.type;
            compType = textures[i].format.compType;
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
                    if (channelExtract >= 0) {
                        applyChannelExtractToRGBA(rgba, channelExtract);
                    }
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
        // Depth/depth-stencil formats: SaveTexture can write a transparent PNG on
        // ANGLE D3D11 for depth-only textures (AlphaMapping::Discard ignored).
        // For packed depth-stencil formats (D32S8 etc.) SaveTexture often fails
        // outright. In both cases, prefer the GPU render path.
        bool isDepthFormat = (compType == CompType::Depth) ||
                             (fmtType == ResourceFormatType::D16S8) ||
                             (fmtType == ResourceFormatType::D24S8) ||
                             (fmtType == ResourceFormatType::D32S8) ||
                             (fmtType == ResourceFormatType::S8);

        bool pngReady = false;

        // For depth formats, try GPU render first (SaveTexture often fails for depth).
        if (isDepthFormat && width > 0 && height > 0) {
            fprintf(stderr, "[bridge] Depth format detected (%s), trying GPU render path first\n", format.c_str());
            pngReady = renderTextureGPU(resId, mip, width, height, samples, channelExtract, isDepthFormat, pngData);
            if (!pngReady)
                fprintf(stderr, "[bridge] GPU render failed for depth format, falling back to SaveTexture\n");
        }

        if (!pngReady) {
            std::string tmpPath = std::filesystem::temp_directory_path().string() + "/rdctex_" + std::to_string(rid) + ".png";

            TextureSave save;
            save.resourceId = resId;
            save.destType = FileType::PNG;
            save.mip = mip;
            save.slice.sliceIndex = 0;
            save.comp.blackPoint = 0.0f;
            save.comp.whitePoint = 1.0f;
            // Formats without an alpha channel (compCount < 4) have no alpha data;
            // AlphaMapping::Preserve would output alpha=0 (fully transparent) for
            // those formats. Use Discard to force alpha=1.0 (fully opaque) so that
            // R8, RG16, RGB24 and similar textures are visible in the PNG viewer.
            save.alpha = (compCount >= 4) ? AlphaMapping::Preserve : AlphaMapping::Discard;
            save.channelExtract = channelExtract;

            rdcstr outPath(tmpPath.c_str());
            fprintf(stderr, "[bridge] SaveTexture: %ux%u fmt=%s -> %s\n", width, height, format.c_str(), tmpPath.c_str());
            ResultDetails saveResult = g_replay->SaveTexture(save, outPath);

            if (saveResult.code != ResultCode::Succeeded) {
                // SaveTexture can fail for GPU-only resources like the backbuffer.
                // For depth formats we already tried GPU render above; for others try now.
                fprintf(stderr, "[bridge] SaveTexture failed (%s) — falling back to GPU render path\n",
                        resultMessage(saveResult).c_str());
                // For all formats (depth and non-depth), try GPU render as fallback.
                if (!renderTextureGPU(resId, mip, width, height, samples, channelExtract, isDepthFormat, pngData)) {
                    return makeError(id, -3, "SaveTexture failed: " + resultMessage(saveResult)
                                            + "; GPU fallback also failed");
                }
            } else {
                pngData = readFileBytes(tmpPath);
                std::filesystem::remove(tmpPath);
            }
        }
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
        ensureEvent(eventId);
    }

    json result;
    json shaders = json::object();

    // Use API-specific pipeline state getters to avoid PipeState helper methods
    // (those are implemented in the DLL and we can't link to them)
    auto addShader = [&](const char *name, ResourceId resId, ShaderStage stage,
                         ResourceId programId = ResourceId()) {
        if (resId != ResourceId()) {
            std::string shaderName = resNameLookup(resId);
            std::string programName = (programId != ResourceId()) ? resNameLookup(programId) : "";
            // Prefer the program label (set by glObjectLabel on the program object) when the
            // shader itself only has an autogenerated name — mirrors RenderDoc desktop behaviour
            // where "Universal Render Pipeline/Lit(LTC) > Shader 516" is shown.
            std::string displayName = (!programName.empty()) ? programName : shaderName;
            shaders[name] = {
                {"resourceId",  resIdToU64(resId)},
                {"name",        displayName},
                {"programName", programName},
                {"shaderName",  shaderName},
                {"stage",       (uint32_t)stage}
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
    json vertexAttributes = json::array();
    uint64_t indexBuffer = 0;
    uint32_t indexByteStride = 0;
    std::string topologyName;
    bool primitiveRestartEnabled = false;
    uint32_t primitiveRestartIndex = 0;

    auto topologyStr = [](Topology t) -> const char * {
        switch(t) {
            case Topology::Unknown: return "Unknown";
            case Topology::PointList: return "PointList";
            case Topology::LineList: return "LineList";
            case Topology::LineStrip: return "LineStrip";
            case Topology::TriangleList: return "TriangleList";
            case Topology::TriangleStrip: return "TriangleStrip";
            case Topology::LineList_Adj: return "LineListAdj";
            case Topology::LineStrip_Adj: return "LineStripAdj";
            case Topology::TriangleList_Adj: return "TriangleListAdj";
            case Topology::TriangleStrip_Adj: return "TriangleStripAdj";
            case Topology::PatchList: return "PatchList";
            default: return "Other";
        }
    };

    // Try each API
    const auto *gl = g_replay->GetGLPipelineState();
    if (gl) {
        result["api"] = "OpenGL";
        // On GLES, program-only pipelines may leave shaderResourceId empty;
        // fall back to programResourceId so the stage is reported as bound.
        auto pickGL = [](const GLPipe::Shader &s) -> ResourceId {
            return s.shaderResourceId != ResourceId() ? s.shaderResourceId : s.programResourceId;
        };
        addShader("vertex",   pickGL(gl->vertexShader),   ShaderStage::Vertex,   gl->vertexShader.programResourceId);
        addShader("tessCtrl", pickGL(gl->tessControlShader), ShaderStage::Hull,  gl->tessControlShader.programResourceId);
        addShader("tessEval", pickGL(gl->tessEvalShader),  ShaderStage::Domain,  gl->tessEvalShader.programResourceId);
        addShader("geometry", pickGL(gl->geometryShader),  ShaderStage::Geometry,gl->geometryShader.programResourceId);
        addShader("fragment", pickGL(gl->fragmentShader),  ShaderStage::Pixel,   gl->fragmentShader.programResourceId);
        addShader("compute",  pickGL(gl->computeShader),   ShaderStage::Compute, gl->computeShader.programResourceId);

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
        indexByteStride = gl->vertexInput.indexByteStride;
        topologyName = topologyStr(gl->vertexInput.topology);
        primitiveRestartEnabled = gl->vertexInput.primitiveRestart;
        primitiveRestartIndex = gl->vertexInput.restartIndex;
        for (const auto &vb : gl->vertexInput.vertexBuffers) {
            if (vb.resourceId != ResourceId()) {
                vertexBuffers.push_back({
                    {"resourceId", resIdToU64(vb.resourceId)},
                    {"stride", vb.byteStride},
                    {"offset", (uint64_t)vb.byteOffset},
                });
            }
        }
        const ShaderReflection *refl = gl->vertexShader.reflection;
        for (size_t i = 0; i < gl->vertexInput.attributes.size(); i++) {
            const auto &attr = gl->vertexInput.attributes[i];
            std::string attrName = "attr" + std::to_string(i);
            if (refl && attr.boundShaderInput >= 0 && (size_t)attr.boundShaderInput < refl->inputSignature.size()) {
                attrName = rdcToStr(refl->inputSignature[attr.boundShaderInput].varName);
            }
            vertexAttributes.push_back({
                {"name", attrName},
                {"location", attr.boundShaderInput},
                {"slot", attr.vertexBufferSlot},
                {"format", formatToStr(attr.format)},
                {"offset", attr.byteOffset},
                {"enabled", attr.enabled},
                {"perInstance", (size_t)attr.vertexBufferSlot < gl->vertexInput.vertexBuffers.size() ? gl->vertexInput.vertexBuffers[attr.vertexBufferSlot].instanceDivisor > 0 : false},
                {"instanceRate", (size_t)attr.vertexBufferSlot < gl->vertexInput.vertexBuffers.size() ? gl->vertexInput.vertexBuffers[attr.vertexBufferSlot].instanceDivisor : 0},
                {"used", true},
            });
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
        indexByteStride = vk->inputAssembly.indexBuffer.byteStride;
        topologyName = topologyStr(vk->inputAssembly.topology);
        primitiveRestartEnabled = vk->inputAssembly.primitiveRestartEnable;
        primitiveRestartIndex = primitiveRestartEnabled ? (indexByteStride == 2 ? 0xFFFFu : 0xFFFFFFFFu) : 0;
        for (const auto &vb : vk->vertexInput.vertexBuffers) {
            if (vb.resourceId != ResourceId()) {
                vertexBuffers.push_back({
                    {"resourceId", resIdToU64(vb.resourceId)},
                    {"stride", vb.byteStride},
                    {"offset", (uint64_t)vb.byteOffset},
                });
            }
        }
        const ShaderReflection *refl = vk->vertexShader.reflection;
        for (size_t i = 0; i < vk->vertexInput.attributes.size(); i++) {
            const auto &attr = vk->vertexInput.attributes[i];
            std::string attrName = "attr" + std::to_string(i);
            bool used = true;
            if (refl) {
                used = false;
                for (const auto &sig : refl->inputSignature) {
                    if (sig.regIndex == attr.location && sig.systemValue == ShaderBuiltin::Undefined) {
                        attrName = rdcToStr(sig.varName);
                        used = true;
                        break;
                    }
                }
            }
            bool perInstance = false;
            uint32_t instanceRate = 1;
            if ((size_t)attr.binding < vk->vertexInput.bindings.size()) {
                const auto &binding = vk->vertexInput.bindings[attr.binding];
                perInstance = binding.perInstance;
                instanceRate = binding.instanceDivisor;
            }
            vertexAttributes.push_back({
                {"name", attrName},
                {"location", attr.location},
                {"slot", attr.binding},
                {"format", formatToStr(attr.format)},
                {"offset", attr.byteOffset},
                {"enabled", true},
                {"perInstance", perInstance},
                {"instanceRate", instanceRate},
                {"used", used},
            });
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
        indexByteStride = d11->inputAssembly.indexBuffer.byteStride;
        topologyName = topologyStr(d11->inputAssembly.topology);
        for (const auto &vb : d11->inputAssembly.vertexBuffers) {
            if (vb.resourceId != ResourceId()) {
                vertexBuffers.push_back({
                    {"resourceId", resIdToU64(vb.resourceId)},
                    {"stride", vb.byteStride},
                    {"offset", (uint64_t)vb.byteOffset},
                });
            }
        }
        const ShaderReflection *refl = d11->inputAssembly.bytecode ? (const ShaderReflection *)d11->inputAssembly.bytecode : nullptr;
        uint32_t byteOffs[128] = {};
        for (size_t i = 0; i < d11->inputAssembly.layouts.size(); i++) {
            const auto &layout = d11->inputAssembly.layouts[i];
            uint32_t offset = layout.byteOffset;
            if (offset == UINT32_MAX) {
                offset = byteOffs[layout.inputSlot];
            } else {
                byteOffs[layout.inputSlot] = offset;
            }
            byteOffs[layout.inputSlot] += (uint32_t)layout.format.compByteWidth * (uint32_t)layout.format.compCount;
            bool used = false;
            if (refl) {
                for (const auto &sig : refl->inputSignature) {
                    if (sig.semanticName == layout.semanticName && sig.semanticIndex == layout.semanticIndex) {
                        used = true;
                        break;
                    }
                }
            }
            std::string attrName = rdcToStr(layout.semanticName) + (layout.semanticIndex > 0 ? std::to_string(layout.semanticIndex) : "");
            vertexAttributes.push_back({
                {"name", attrName},
                {"location", layout.semanticIndex},
                {"slot", layout.inputSlot},
                {"format", formatToStr(layout.format)},
                {"offset", offset},
                {"enabled", true},
                {"perInstance", layout.perInstance},
                {"instanceRate", layout.instanceDataStepRate},
                {"used", used},
            });
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
        indexByteStride = d12->inputAssembly.indexBuffer.byteStride;
        topologyName = topologyStr(d12->inputAssembly.topology);
        primitiveRestartEnabled = d12->inputAssembly.indexStripCutValue != 0;
        primitiveRestartIndex = d12->inputAssembly.indexStripCutValue;
        for (const auto &vb : d12->inputAssembly.vertexBuffers) {
            if (vb.resourceId != ResourceId()) {
                vertexBuffers.push_back({
                    {"resourceId", resIdToU64(vb.resourceId)},
                    {"stride", vb.byteStride},
                    {"offset", (uint64_t)vb.byteOffset},
                });
            }
        }
        const ShaderReflection *refl = d12->vertexShader.reflection;
        uint32_t byteOffs[128] = {};
        for (size_t i = 0; i < d12->inputAssembly.layouts.size(); i++) {
            const auto &layout = d12->inputAssembly.layouts[i];
            uint32_t offset = layout.byteOffset;
            if (offset == UINT32_MAX) {
                offset = byteOffs[layout.inputSlot];
            } else {
                byteOffs[layout.inputSlot] = offset;
            }
            byteOffs[layout.inputSlot] += (uint32_t)layout.format.compByteWidth * (uint32_t)layout.format.compCount;
            bool used = false;
            if (refl) {
                for (const auto &sig : refl->inputSignature) {
                    if (sig.semanticName == layout.semanticName && sig.semanticIndex == layout.semanticIndex) {
                        used = true;
                        break;
                    }
                }
            }
            std::string attrName = rdcToStr(layout.semanticName) + (layout.semanticIndex > 0 ? std::to_string(layout.semanticIndex) : "");
            vertexAttributes.push_back({
                {"name", attrName},
                {"location", layout.semanticIndex},
                {"slot", layout.inputSlot},
                {"format", formatToStr(layout.format)},
                {"offset", offset},
                {"enabled", true},
                {"perInstance", layout.perInstance},
                {"instanceRate", layout.instanceDataStepRate},
                {"used", used},
            });
        }
    }

    // When no color targets are reported (e.g. Present draws or depth-only passes),
    // fall back to textures marked as SwapBuffer — this is the same logic RenderDoc's
    // TextureViewer uses in Following::GetOutputTargets() for Present actions.
    if (colorTargets.empty()) {
        const rdcarray<TextureDescription> &allTextures = g_replay->GetTextures();
        for (size_t i = 0; i < allTextures.size(); i++) {
            if ((allTextures[i].creationFlags & TextureCategory::SwapBuffer) != TextureCategory::NoFlags) {
                colorTargets.push_back(resIdToU64(allTextures[i].resourceId));
                fprintf(stderr, "[bridge] getPipelineState: colorTargets empty, using SwapBuffer tex %llu (%s)\n",
                        resIdToU64(allTextures[i].resourceId),
                        resNameLookup(allTextures[i].resourceId).c_str());
            }
        }
    }

    framebuffer["colorTargets"] = colorTargets;
    if (depthTarget != 0)   framebuffer["depthTarget"]   = depthTarget;
    if (stencilTarget != 0) framebuffer["stencilTarget"] = stencilTarget;
    result["framebuffer"] = framebuffer;

    vertexInput["vertexBuffers"] = vertexBuffers;
    if (indexBuffer != 0) vertexInput["indexBuffer"] = indexBuffer;
    if (indexByteStride != 0) vertexInput["indexStride"] = indexByteStride;
    if (!topologyName.empty()) vertexInput["topology"] = topologyName;
    vertexInput["primitiveRestart"] = primitiveRestartEnabled;
    if (primitiveRestartEnabled)
        vertexInput["restartIndex"] = primitiveRestartIndex;
    vertexInput["attributes"] = vertexAttributes;
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

    // ── Enum helpers (local lambdas) ────────────────────────────────────────
    auto fillModeStr = [](FillMode m) -> const char* {
        switch(m) { case FillMode::Solid: return "Solid"; case FillMode::Wireframe: return "Wireframe"; case FillMode::Point: return "Point"; default: return "Unknown"; }
    };
    auto cullModeStr = [](CullMode m) -> const char* {
        switch(m) { case CullMode::NoCull: return "NoCull"; case CullMode::Front: return "Front"; case CullMode::Back: return "Back"; case CullMode::FrontAndBack: return "FrontAndBack"; default: return "Unknown"; }
    };
    auto cmpFnStr = [](CompareFunction f) -> const char* {
        switch(f) { case CompareFunction::Never: return "Never"; case CompareFunction::AlwaysTrue: return "Always"; case CompareFunction::Less: return "Less"; case CompareFunction::LessEqual: return "LessEqual"; case CompareFunction::Greater: return "Greater"; case CompareFunction::GreaterEqual: return "GreaterEqual"; case CompareFunction::Equal: return "Equal"; case CompareFunction::NotEqual: return "NotEqual"; default: return "Unknown"; }
    };
    auto stencilOpStr = [](StencilOperation op) -> const char* {
        switch(op) { case StencilOperation::Keep: return "Keep"; case StencilOperation::Zero: return "Zero"; case StencilOperation::Replace: return "Replace"; case StencilOperation::IncSat: return "IncSat"; case StencilOperation::DecSat: return "DecSat"; case StencilOperation::IncWrap: return "IncWrap"; case StencilOperation::DecWrap: return "DecWrap"; case StencilOperation::Invert: return "Invert"; default: return "Unknown"; }
    };
    auto blendMulStr = [](BlendMultiplier m) -> const char* {
        switch(m) { case BlendMultiplier::Zero: return "Zero"; case BlendMultiplier::One: return "One"; case BlendMultiplier::SrcCol: return "SrcColor"; case BlendMultiplier::InvSrcCol: return "InvSrcColor"; case BlendMultiplier::DstCol: return "DstColor"; case BlendMultiplier::InvDstCol: return "InvDstColor"; case BlendMultiplier::SrcAlpha: return "SrcAlpha"; case BlendMultiplier::InvSrcAlpha: return "InvSrcAlpha"; case BlendMultiplier::DstAlpha: return "DstAlpha"; case BlendMultiplier::InvDstAlpha: return "InvDstAlpha"; case BlendMultiplier::SrcAlphaSat: return "SrcAlphaSat"; case BlendMultiplier::FactorRGB: return "BlendFactor"; case BlendMultiplier::InvFactorRGB: return "InvBlendFactor"; case BlendMultiplier::FactorAlpha: return "BlendFactorAlpha"; case BlendMultiplier::InvFactorAlpha: return "InvBlendFactorAlpha"; default: return "Unknown"; }
    };
    auto blendOpStr = [](BlendOperation op) -> const char* {
        switch(op) { case BlendOperation::Add: return "Add"; case BlendOperation::Subtract: return "Subtract"; case BlendOperation::ReversedSubtract: return "RevSubtract"; case BlendOperation::Minimum: return "Min"; case BlendOperation::Maximum: return "Max"; default: return "Unknown"; }
    };
    auto filterModeStr = [](FilterMode m) -> const char* {
        switch(m) { case FilterMode::NoFilter: return "None"; case FilterMode::Point: return "Point"; case FilterMode::Linear: return "Linear"; case FilterMode::Cubic: return "Cubic"; case FilterMode::Anisotropic: return "Anisotropic"; default: return "Unknown"; }
    };
    auto addressModeStr = [](AddressMode m) -> const char* {
        switch(m) { case AddressMode::Wrap: return "Wrap"; case AddressMode::Mirror: return "Mirror"; case AddressMode::MirrorOnce: return "MirrorOnce"; case AddressMode::ClampEdge: return "ClampEdge"; case AddressMode::ClampBorder: return "ClampBorder"; default: return "Unknown"; }
    };

    auto serializeStencilFace = [&](const StencilFace &f) -> json {
        return {
            {"failOp",      stencilOpStr(f.failOperation)},
            {"depthFailOp", stencilOpStr(f.depthFailOperation)},
            {"passOp",      stencilOpStr(f.passOperation)},
            {"compareFunc", cmpFnStr(f.function)},
            {"reference",   f.reference},
            {"compareMask", f.compareMask},
            {"writeMask",   f.writeMask},
        };
    };
    auto serializeColorBlend = [&](const ColorBlend &b, int idx) -> json {
        return {
            {"index",    idx},
            {"enabled",  b.enabled},
            {"writeMask", b.writeMask},
            {"colorBlend", {
                {"src", blendMulStr(b.colorBlend.source)},
                {"dst", blendMulStr(b.colorBlend.destination)},
                {"op",  blendOpStr(b.colorBlend.operation)},
            }},
            {"alphaBlend", {
                {"src", blendMulStr(b.alphaBlend.source)},
                {"dst", blendMulStr(b.alphaBlend.destination)},
                {"op",  blendOpStr(b.alphaBlend.operation)},
            }},
            {"logicOpEnabled", b.logicOperationEnabled},
        };
    };

    // ── Rasterizer state ────────────────────────────────────────────────────
    json rasterizer = json::object();
    if (gl) {
        const auto &rs = gl->rasterizer.state;
        rasterizer = {
            {"fillMode",            fillModeStr(rs.fillMode)},
            {"cullMode",            cullModeStr(rs.cullMode)},
            {"frontCCW",            rs.frontCCW},
            {"depthBias",           rs.depthBias},
            {"slopeScaledDepthBias",rs.slopeScaledDepthBias},
            {"depthClamp",          rs.depthClamp},
            {"multisampleEnable",   rs.multisampleEnable},
            {"alphaToCoverage",     rs.alphaToCoverage},
            {"pointSize",           rs.pointSize},
            {"lineWidth",           rs.lineWidth},
        };
    } else if (vk) {
        const auto &rs = vk->rasterizer;
        rasterizer = {
            {"fillMode",            fillModeStr(rs.fillMode)},
            {"cullMode",            cullModeStr(rs.cullMode)},
            {"frontCCW",            rs.frontCCW},
            {"depthBias",           rs.depthBias},
            {"depthBiasClamp",      rs.depthBiasClamp},
            {"slopeScaledDepthBias",rs.slopeScaledDepthBias},
            {"depthClampEnable",    rs.depthClampEnable},
            {"depthClipEnable",     rs.depthClipEnable},
            {"rasterizerDiscard",   rs.rasterizerDiscardEnable},
            {"lineWidth",           rs.lineWidth},
        };
    } else if (d11) {
        const auto &rs = d11->rasterizer.state;
        rasterizer = {
            {"fillMode",            fillModeStr(rs.fillMode)},
            {"cullMode",            cullModeStr(rs.cullMode)},
            {"frontCCW",            rs.frontCCW},
            {"depthBias",           rs.depthBias},
            {"depthBiasClamp",      rs.depthBiasClamp},
            {"slopeScaledDepthBias",rs.slopeScaledDepthBias},
            {"depthClip",           rs.depthClip},
            {"scissorEnable",       rs.scissorEnable},
            {"multisampleEnable",   rs.multisampleEnable},
            {"antialiasedLineEnable",rs.antialiasedLines},
        };
    } else if (d12) {
        const auto &rs = d12->rasterizer.state;
        rasterizer = {
            {"fillMode",            fillModeStr(rs.fillMode)},
            {"cullMode",            cullModeStr(rs.cullMode)},
            {"frontCCW",            rs.frontCCW},
            {"depthBias",           rs.depthBias},
            {"depthBiasClamp",      rs.depthBiasClamp},
            {"slopeScaledDepthBias",rs.slopeScaledDepthBias},
            {"depthClip",           rs.depthClip},
        };
    }
    result["rasterizer"] = rasterizer;

    // ── Depth / Stencil state ───────────────────────────────────────────────
    json depthStencil = json::object();
    if (gl) {
        depthStencil = {
            {"depthEnable",   gl->depthState.depthEnable},
            {"depthFunc",     cmpFnStr(gl->depthState.depthFunction)},
            {"depthWrites",   gl->depthState.depthWrites},
            {"stencilEnable", gl->stencilState.stencilEnable},
            {"frontFace",     serializeStencilFace(gl->stencilState.frontFace)},
            {"backFace",      serializeStencilFace(gl->stencilState.backFace)},
        };
    } else if (vk) {
        depthStencil = {
            {"depthEnable",   vk->depthStencil.depthTestEnable},
            {"depthFunc",     cmpFnStr(vk->depthStencil.depthFunction)},
            {"depthWrites",   vk->depthStencil.depthWriteEnable},
            {"stencilEnable", vk->depthStencil.stencilTestEnable},
            {"frontFace",     serializeStencilFace(vk->depthStencil.frontFace)},
            {"backFace",      serializeStencilFace(vk->depthStencil.backFace)},
        };
    } else if (d11) {
        const auto &ds = d11->outputMerger.depthStencilState;
        depthStencil = {
            {"depthEnable",   ds.depthEnable},
            {"depthFunc",     cmpFnStr(ds.depthFunction)},
            {"depthWrites",   ds.depthWrites},
            {"stencilEnable", ds.stencilEnable},
            {"frontFace",     serializeStencilFace(ds.frontFace)},
            {"backFace",      serializeStencilFace(ds.backFace)},
        };
    } else if (d12) {
        const auto &ds = d12->outputMerger.depthStencilState;
        depthStencil = {
            {"depthEnable",   ds.depthEnable},
            {"depthFunc",     cmpFnStr(ds.depthFunction)},
            {"depthWrites",   ds.depthWrites},
            {"stencilEnable", ds.stencilEnable},
            {"frontFace",     serializeStencilFace(ds.frontFace)},
            {"backFace",      serializeStencilFace(ds.backFace)},
        };
    }
    result["depthStencil"] = depthStencil;

    // ── Blend state ─────────────────────────────────────────────────────────
    {
        json blendState = json::object();
        json blendTargets = json::array();
        json blendFactor = json::array();

        auto fillFactor = [&](const rdcfixedarray<float, 4> &f) {
            blendFactor = {f[0], f[1], f[2], f[3]};
        };

        if (gl) {
            blendState["alphaToCoverage"] = gl->rasterizer.state.alphaToCoverage;
            fillFactor(gl->framebuffer.blendState.blendFactor);
            int idx = 0;
            for (const auto &b : gl->framebuffer.blendState.blends)
                blendTargets.push_back(serializeColorBlend(b, idx++));
        } else if (vk) {
            blendState["alphaToCoverage"] = vk->colorBlend.alphaToCoverageEnable;
            fillFactor(vk->colorBlend.blendFactor);
            int idx = 0;
            for (const auto &b : vk->colorBlend.blends)
                blendTargets.push_back(serializeColorBlend(b, idx++));
        } else if (d11) {
            blendState["alphaToCoverage"]  = d11->outputMerger.blendState.alphaToCoverage;
            blendState["independentBlend"] = d11->outputMerger.blendState.independentBlend;
            fillFactor(d11->outputMerger.blendState.blendFactor);
            int idx = 0;
            for (const auto &b : d11->outputMerger.blendState.blends)
                blendTargets.push_back(serializeColorBlend(b, idx++));
        } else if (d12) {
            blendState["alphaToCoverage"]  = d12->outputMerger.blendState.alphaToCoverage;
            blendState["independentBlend"] = d12->outputMerger.blendState.independentBlend;
            fillFactor(d12->outputMerger.blendState.blendFactor);
            int idx = 0;
            for (const auto &b : d12->outputMerger.blendState.blends)
                blendTargets.push_back(serializeColorBlend(b, idx++));
        }

        blendState["blendFactor"] = blendFactor;
        blendState["targets"]     = blendTargets;
        result["blendState"] = blendState;
    }

    // ── Sampler descriptors ─────────────────────────────────────────────────
    {
        json samplers = json::array();
        const rdcarray<DescriptorAccess> &accesses = g_replay->GetDescriptorAccess();
        std::map<ResourceId, rdcarray<DescriptorRange>> storeRanges;
        std::map<ResourceId, std::vector<const DescriptorAccess *>> storeAccesses;
        for (size_t i = 0; i < accesses.size(); i++) {
            const DescriptorAccess &acc = accesses[i];
            if (acc.descriptorStore == ResourceId()) continue;
            if (!IsSamplerDescriptor(acc.type)) continue;
            storeRanges[acc.descriptorStore].push_back(DescriptorRange(acc));
            storeAccesses[acc.descriptorStore].push_back(&acc);
        }
        std::set<uint64_t> seenSamplers;
        for (auto &kv : storeRanges) {
            rdcarray<SamplerDescriptor> descs = g_replay->GetSamplerDescriptors(kv.first, kv.second);
            const auto &accs = storeAccesses[kv.first];
            for (size_t i = 0; i < descs.size() && i < accs.size(); i++) {
                const SamplerDescriptor &sd = descs[i];
                uint64_t objId = resIdToU64(sd.object);
                // deduplicate by object ResourceId (0 = inline sampler, always include)
                if (objId != 0) {
                    if (seenSamplers.count(objId)) continue;
                    seenSamplers.insert(objId);
                }
                json sj = {
                    {"resourceId",    objId},
                    {"name",          objId != 0 ? resNameLookup(sd.object) : ""},
                    {"minFilter",     filterModeStr(sd.filter.minify)},
                    {"magFilter",     filterModeStr(sd.filter.magnify)},
                    {"mipFilter",     filterModeStr(sd.filter.mip)},
                    {"addressU",      addressModeStr(sd.addressU)},
                    {"addressV",      addressModeStr(sd.addressV)},
                    {"addressW",      addressModeStr(sd.addressW)},
                    {"compareEnable", sd.compareFunction != CompareFunction::AlwaysTrue},
                    {"compareFunc",   cmpFnStr(sd.compareFunction)},
                    {"maxAnisotropy", sd.maxAnisotropy},
                    {"minLOD",        sd.minLOD},
                    {"maxLOD",        sd.maxLOD},
                    {"mipBias",       sd.mipBias},
                };
                samplers.push_back(sj);
            }
        }
        result["samplers"] = samplers;
    }

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
    // maxVertices == 0 means "all" - mirrors RenderDoc desktop's BufferViewer
    // which uses the full action->numIndices. A safety cap prevents OOM on
    // pathological captures.
    uint32_t maxVerts = params.value("maxVertices", (uint32_t)0);
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
    // maxVerts==0 -> all rows. Apply hard safety cap of ~4M to avoid OOM.
    constexpr uint32_t kHardCap = 4u * 1024u * 1024u;
    uint32_t effectiveMax = (maxVerts == 0) ? kHardCap : std::min(maxVerts, kHardCap);
    uint32_t count = std::min(total, effectiveMax);
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
    // (bufferIndex is filled in below after we dedupe VB reads.)
    json attrMeta = json::array();
    for (const auto &a : attrs) {
        json meta = {
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
            {"bufferIndex", -1},
        };
        if (a.genericEnabled) {
            json gv = json::array();
            for (uint32_t c = 0; c < a.fmt.compCount && c < 4; c++) {
                if (a.genericKind == 1)      gv.push_back((double)a.genericU[c]);
                else if (a.genericKind == 2) gv.push_back((double)a.genericI[c]);
                else                         gv.push_back((double)a.genericF[c]);
            }
            meta["genericValues"] = gv;
            meta["genericKind"] = a.genericKind;
        }
        attrMeta.push_back(meta);
    }

    // Read the index buffer covering at least the requested indices.
    std::vector<uint8_t> idxBuf;
    if (mf.indexResourceId != ResourceId() && mf.indexByteStride > 0) {
        uint64_t need = (uint64_t)count * mf.indexByteStride;
        idxBuf = readBuffer(mf.indexResourceId, mf.indexByteOffset, need);
        // Trim to exactly the bytes we report (avoid sending over-read tail).
        if (idxBuf.size() > need) idxBuf.resize((size_t)need);
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
    uint32_t restartIdxForScan = restartEnabled ? restartIdx : ~0u;

    // Determine the highest vertex index we will actually reference so we can
    // tightly size each VB read. (Mirrors RenderDoc desktop BufferViewer,
    // which only reads the bytes required for the visible rows.)
    uint32_t maxVertexIdx = 0;
    if (!idxBuf.empty()) {
        for (uint32_t i = 0; i < count; i++) {
            bool isR = false;
            uint32_t raw = readIndex(idxBuf, mf.indexByteStride, i, restartIdxForScan, isR);
            if (!isR && raw > maxVertexIdx) maxVertexIdx = raw;
        }
    } else {
        maxVertexIdx = count ? count - 1 : 0;
    }
    uint32_t vertsToRead = maxVertexIdx + 1;

    // Dedupe VB reads: group attributes that share (resId, vbOffset, stride)
    // into a single buffer. Saves lots of bandwidth when multiple attributes
    // live in the same interleaved vertex buffer.
    struct BufGroup {
        ResourceId resId;
        uint64_t   vbOffset;
        uint32_t   stride;
        uint32_t   maxAttrEnd;   // max(attrOffset + attrSize) across members
    };
    std::vector<BufGroup> groups;
    std::vector<int> attrToGroup(attrs.size(), -1);
    for (size_t k = 0; k < attrs.size(); k++) {
        const auto &a = attrs[k];
        if (a.genericEnabled || a.vb == ResourceId() || a.vbStride == 0) continue;
        uint32_t attrSize = (uint32_t)a.fmt.compByteWidth * (uint32_t)a.fmt.compCount;
        uint32_t attrEnd  = a.attrOffset + attrSize;
        int found = -1;
        for (size_t g = 0; g < groups.size(); g++) {
            if (groups[g].resId == a.vb && groups[g].vbOffset == a.vbOffset &&
                groups[g].stride == a.vbStride) { found = (int)g; break; }
        }
        if (found < 0) {
            groups.push_back({a.vb, a.vbOffset, a.vbStride, attrEnd});
            found = (int)groups.size() - 1;
        } else if (attrEnd > groups[found].maxAttrEnd) {
            groups[found].maxAttrEnd = attrEnd;
        }
        attrToGroup[k] = found;
    }

    // Read each group once.
    json bufArr = json::array();
    for (const auto &g : groups) {
        uint64_t readLen = 0;
        if (vertsToRead > 0) {
            readLen = (uint64_t)(vertsToRead - 1) * g.stride + g.maxAttrEnd;
        }
        std::vector<uint8_t> data = readBuffer(g.resId, g.vbOffset, readLen);
        if (data.size() > readLen) data.resize((size_t)readLen);
        bufArr.push_back(base64Encode(data));
    }

    // Patch bufferIndex into the attribute metadata.
    for (size_t k = 0; k < attrs.size(); k++) {
        attrMeta[k]["bufferIndex"] = attrToGroup[k];
    }
    result["attributes"] = attrMeta;
    result["buffers"]    = bufArr;

    // Index buffer + restart info.
    if (!idxBuf.empty()) {
        result["indexData"] = base64Encode(idxBuf);
    }
    result["restartEnabled"] = restartEnabled;
    result["restartIndex"]   = restartIdx;
    result["maxVertexIndex"] = maxVertexIdx;

    return makeResult(id, result);
}

static json handleShutdown(int id) {
    clearLiveTargetSession();
    if (g_thumbOut) { g_thumbOut->Shutdown(); g_thumbOut = nullptr; }
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

// ── GPU thumbnail batch ─────────────────────────────────────────────────────
// Renders multiple textures at THUMB_DIM×THUMB_DIM using a persistent
// IReplayOutput. Much faster than SaveTexture-to-file for small previews:
//   • No temp-file I/O
//   • GPU scales to thumbnail size (256×256) instead of full resolution
//   • Reuses the same output window → no re-creation overhead per texture
//   • Only one ensureEvent() call for the whole batch
// ────────────────────────────────────────────────────────────────────────────

static IReplayOutput* ensureThumbOut() {
    if (g_thumbOut) return g_thumbOut;
    if (!g_replay)  return nullptr;
    WindowingData win = CreateHeadlessWindowingData(THUMB_DIM, THUMB_DIM);
    g_thumbOut = g_replay->CreateOutput(win, ReplayOutputType::Texture);
    return g_thumbOut;
}

static json renderOneThumbnail(ResourceId resId, uint32_t mip,
                                const rdcarray<TextureDescription> &textures) {
    json r;
    r["resourceId"] = resIdToU64(resId);

    uint32_t width = 0, height = 0, compCount = 0;
    std::string format;
    for (size_t i = 0; i < textures.size(); i++) {
        if (textures[i].resourceId == resId) {
            width    = textures[i].width;
            height   = textures[i].height;
            compCount= textures[i].format.compCount;
            format   = formatToStr(textures[i].format);
            break;
        }
    }
    if (width == 0 || height == 0) { r["error"] = "texture not found"; return r; }

    IReplayOutput *out = ensureThumbOut();
    if (!out) { r["error"] = "thumbnail output unavailable"; return r; }

    // scale=-1.0 is RenderDoc's own "auto-fit to viewport" value (same as SaveTexture path)
    TextureDisplay disp = {};
    disp.resourceId           = resId;
    disp.typeCast             = CompType::Typeless;
    disp.scale                = -1.0f;
    disp.red = disp.green = disp.blue = true;
    disp.alpha                = false;
    disp.flipY                = false;
    disp.hdrMultiplier        = -1.0f;
    disp.linearDisplayAsGamma = true;
    disp.rangeMin             = 0.0f;
    disp.rangeMax             = 1.0f;
    disp.subresource          = {mip, 0, 0};
    disp.overlay              = DebugOverlay::NoOverlay;

    out->SetTextureDisplay(disp);
    out->Display();
    bytebuf pixels = out->ReadbackOutputTexture();

    if (pixels.empty()) { r["error"] = "readback empty"; return r; }

    // All drivers compact to 3 bytes/pixel (RGB) per ReadbackOutputTexture contract
    int comp = 3;
    if (pixels.size() == (size_t)THUMB_DIM * THUMB_DIM * 4) comp = 4;
    if (pixels.size() < (size_t)THUMB_DIM * THUMB_DIM * (size_t)comp) {
        r["error"] = "readback size mismatch"; return r;
    }

    std::vector<uint8_t> pngData;
    if (!stbi_write_png_to_func(stbiWriteToVector, &pngData,
                                THUMB_DIM, THUMB_DIM, comp,
                                pixels.data(), THUMB_DIM * comp)) {
        r["error"] = "png encode failed"; return r;
    }

    r["base64"]    = base64Encode(pngData);
    r["format"]    = "png";
    r["width"]     = THUMB_DIM;
    r["height"]    = THUMB_DIM;
    r["texFormat"] = format;
    r["compCount"] = compCount;
    return r;
}

static json handleGetTextureThumbBatch(int id, const json &params) {
    if (!g_replay)
        return makeError(id, -1, "No replay active");

    uint32_t eventId = params.value("eventId", (uint32_t)0);
    const json &texList = params.value("textures", json::array());

    if (eventId == 0) {
        const rdcarray<ActionDescription> &actions = g_replay->GetRootActions();
        eventId = findMaxEventId(actions);
    }
    ensureEvent(eventId);

    const rdcarray<TextureDescription> &textures = g_replay->GetTextures();
    json results = json::array();
    for (const auto &entry : texList) {
        uint64_t rid = entry.value("resourceId", (uint64_t)0);
        uint32_t mip = entry.value("mip", (uint32_t)0);
        results.push_back(renderOneThumbnail(u64ToResId(rid), mip, textures));
    }
    return makeResult(id, {{"results", results}, {"eventId", eventId}});
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
        if (method == "getCaptureStatistics") return handleGetCaptureStatistics(id);
        if (method == "listCaptureTargets") return handleListCaptureTargets(id);
        if (method == "listAttachTargets")  return handleListAttachTargets(id, params);
        if (method == "launchCapture")      return handleLaunchCapture(id, params);
        if (method == "attachCapture")      return handleAttachCapture(id, params);
        if (method == "getLiveTarget")      return handleGetLiveTarget(id);
        if (method == "triggerCapture")     return handleTriggerCapture(id, params);
        if (method == "disconnectLiveTarget") return handleDisconnectLiveTarget(id);
        if (method == "getTimings")          return handleGetTimings(id);
        if (method == "getDisassemblyTargets") return handleGetDisassemblyTargets(id);
        if (method == "getShaderEntryPoints") return handleGetShaderEntryPoints(id, params);
        if (method == "getShaderSource")    return handleGetShaderSource(id, params);
        if (method == "getShaderSourceForEvent") return handleGetShaderSourceForEvent(id, params);
        if (method == "getTexturePreview") return handleGetTexturePreview(id, params);
        if (method == "getTextureThumbBatch") return handleGetTextureThumbBatch(id, params);
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
