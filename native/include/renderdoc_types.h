/**
 * Minimal ABI-compatible type definitions for RenderDoc replay API.
 *
 * These types MUST match the binary layout of types in renderdoc.dll.
 * Based on RenderDoc v1.x (MIT License, Copyright (c) 2015-2026 Baldur Karlsson).
 *
 * We only define what we actually call — not the full API surface.
 * Virtual function indices are counted from the class declaration in renderdoc_replay.h.
 */

#pragma once

#include <cstdint>
#include <cstring>
#include <cstdlib>

// ── Calling convention ──────────────────────────────────────────────────────
#ifdef _WIN32
#define RENDERDOC_CC __cdecl
#else
#define RENDERDOC_CC
#endif

// ── Forward declarations ────────────────────────────────────────────────────
// DLL allocation functions — MUST be loaded from renderdoc.dll before using rdcstr/rdcarray
typedef void  (RENDERDOC_CC *pfn_FreeArrayMem)(void *mem);
typedef void* (RENDERDOC_CC *pfn_AllocArrayMem)(uint64_t sz);

extern pfn_FreeArrayMem  g_FreeArrayMem;
extern pfn_AllocArrayMem g_AllocArrayMem;

// These get called from rdcstr / rdcarray when running outside the DLL
extern "C" {
    inline void RENDERDOC_CC RENDERDOC_FreeArrayMem(void *mem) {
        if (g_FreeArrayMem) g_FreeArrayMem(mem);
        else free(mem);
    }
    inline void* RENDERDOC_CC RENDERDOC_AllocArrayMem(uint64_t sz) {
        if (g_AllocArrayMem) return g_AllocArrayMem(sz);
        return malloc((size_t)sz);
    }
}

// ── rdcstr ──────────────────────────────────────────────────────────────────
// Binary layout: 24 bytes on x64 (3 * sizeof(size_t))
// This is a simplified version that can READ strings returned by the DLL.
// For passing strings TO the DLL, we use the simple constructor.
class rdcstr {
    static constexpr size_t ALLOC_STATE = size_t(1) << ((sizeof(size_t) * 8) - 2);
    static constexpr size_t FIXED_STATE = size_t(1) << ((sizeof(size_t) * 8) - 1);

    struct alloc_ptr_rep {
        static constexpr size_t CAPACITY_MASK = (~size_t(0)) >> 2;
        char *str;
        size_t size;
        size_t _capacity;
        size_t get_capacity() const { return _capacity & CAPACITY_MASK; }
    };

    struct fixed_ptr_rep {
        const char *str;
        size_t size;
        size_t flags;
    };

    struct arr_rep {
        char str[sizeof(size_t) * 3 - 1];
        static const size_t capacity = sizeof(arr_rep::str) - 1;
        size_t get_size() const { return _size; }
        void set_size(size_t s) { _size = (unsigned char)s; }
    private:
        unsigned char _size;
    };

    union string_data {
        alloc_ptr_rep alloc;
        fixed_ptr_rep fixed;
        arr_rep arr;
    } d;

    bool is_alloc() const { return !!(d.fixed.flags & ALLOC_STATE); }
    bool is_fixed() const { return !!(d.fixed.flags & FIXED_STATE); }

public:
    rdcstr() { memset(&d, 0, sizeof(d)); }

    rdcstr(const char *s) {
        memset(&d, 0, sizeof(d));
        if (!s) return;
        size_t len = strlen(s);
        if (len <= d.arr.capacity) {
            memcpy(d.arr.str, s, len + 1);
            d.arr.set_size(len);
        } else {
            d.alloc.str = (char *)RENDERDOC_AllocArrayMem(len + 1);
            memcpy(d.alloc.str, s, len + 1);
            d.alloc.size = len;
            d.alloc._capacity = ALLOC_STATE | len;
        }
    }

    rdcstr(const rdcstr &o) {
        memset(&d, 0, sizeof(d));
        const char *s = o.c_str();
        size_t len = o.size();
        if (len <= d.arr.capacity) {
            memcpy(d.arr.str, s, len + 1);
            d.arr.set_size(len);
        } else {
            d.alloc.str = (char *)RENDERDOC_AllocArrayMem(len + 1);
            memcpy(d.alloc.str, s, len + 1);
            d.alloc.size = len;
            d.alloc._capacity = ALLOC_STATE | len;
        }
    }

    ~rdcstr() {
        if (is_alloc() && d.alloc.str)
            RENDERDOC_FreeArrayMem(d.alloc.str);
    }

    const char *c_str() const {
        if (is_alloc() || is_fixed()) return d.alloc.str;
        return d.arr.str;
    }

    size_t size() const {
        if (is_alloc() || is_fixed()) return d.fixed.size;
        return d.arr.get_size();
    }

    bool empty() const { return size() == 0; }
};

// ── rdcarray<T> ─────────────────────────────────────────────────────────────
// Binary layout: 24 bytes on x64 (T* elems, size_t allocatedCount, size_t usedCount)
template <typename T>
struct rdcarray {
    T *elems = nullptr;
    size_t allocatedCount = 0;
    size_t usedCount = 0;

    rdcarray() = default;
    ~rdcarray() {
        if (elems) {
            for (size_t i = 0; i < usedCount; i++)
                elems[i].~T();
            RENDERDOC_FreeArrayMem(elems);
        }
    }

    size_t size() const { return usedCount; }
    bool empty() const { return usedCount == 0; }
    const T &operator[](size_t i) const { return elems[i]; }
    T &operator[](size_t i) { return elems[i]; }
    const T *data() const { return elems; }
    const T *begin() const { return elems; }
    const T *end() const { return elems ? elems + usedCount : nullptr; }
};

// Specialization for trivial types (byte, uint32_t, etc.)
typedef uint8_t byte;
struct bytebuf : public rdcarray<byte> {};

// ── rdcpair<A,B> ───────────────────────────────────────────────────────────
template <typename A, typename B>
struct rdcpair {
    A first;
    B second;
};

// ── ResourceId ──────────────────────────────────────────────────────────────
struct ResourceId {
    uint64_t id = 0;
    bool operator==(const ResourceId &o) const { return id == o.id; }
    bool operator!=(const ResourceId &o) const { return id != o.id; }
    bool operator<(const ResourceId &o) const { return id < o.id; }
    static ResourceId Null() { return ResourceId{0}; }
};

// ── ResultCode / ResultDetails ──────────────────────────────────────────────
enum class ResultCode : uint32_t {
    Succeeded = 0,
    // We don't need all codes — just check != Succeeded
};

struct ResultDetails {
    ResultCode code;
    rdcstr message;

    bool OK() const { return code == ResultCode::Succeeded; }
};

// ── Enums we need ───────────────────────────────────────────────────────────
enum class FileType : uint32_t {
    DDS = 0,
    PNG,
    JPG,
    BMP,
    TGA,
    HDR,
    EXR,
    Raw,
    Count,
};

enum class WindowingSystem : uint32_t {
    Unknown = 0,
    Headless,
    Win32,
    Xlib,
    XCB,
    Android,
    Wayland,
    MacOS,
    GGP,
};

enum class ReplayOutputType : uint32_t {
    Texture = 0,
    Mesh,
    Count,
};

enum class ShaderStage : uint32_t {
    Vertex = 0,
    Hull,
    Domain,
    Geometry,
    Pixel,
    Compute,
    Task,
    Mesh,
    RayGen,
    Intersection,
    AnyHit,
    ClosestHit,
    Miss,
    Callable,
    Count,
};

enum class CameraType : uint32_t {
    Arcball = 0,
    FPSLook,
};

enum class CompType : uint32_t {
    Typeless = 0,
    Float,
    UNorm,
    SNorm,
    UInt,
    SInt,
    UScaled,
    SScaled,
    Depth,
    Double,
    A8,
};

// ── Thumbnail ───────────────────────────────────────────────────────────────
struct Thumbnail {
    FileType type = FileType::JPG;
    uint32_t width = 0;
    uint32_t height = 0;
    bytebuf data;
};

// ── Subresource ─────────────────────────────────────────────────────────────
struct Subresource {
    uint32_t mip = 0;
    uint32_t slice = 0;
    uint32_t sample = 0;
};

// ── SectionProperties ───────────────────────────────────────────────────────
enum class SectionType : uint32_t {
    Unknown = 0,
    FrameCapture,
    ResolveDatabase,
    Bookmarks,
    Notes,
    ResourceRenames,
    AMDRGPProfile,
    ExtendedThumbnail,
    EmbeddedLogfile,
    EditedShaders,
    D3D12Core,
    D3D12SDKLayers,
    Count,
};

enum class SectionFlags : uint32_t {
    NoFlags = 0x0,
    ASCIIStored = 0x1,
    LZ4Compressed = 0x2,
    ZstdCompressed = 0x4,
};

struct SectionProperties {
    rdcstr name;
    SectionType type;
    SectionFlags flags;
    uint64_t version;
    uint64_t uncompressedSize;
    uint64_t compressedSize;
};

// ── GlobalEnvironment (needed for InitialiseReplay) ──────────────────────────
struct GlobalEnvironment {
    rdcstr enumerateGPUs_unused; // not used but must be present for ABI
    bool enumerateGPUs = false;
    uint32_t padding = 0;
};

// ── ReplayOptions ───────────────────────────────────────────────────────────
struct ReplayOptions {
    uint32_t apiValidation = 0;
    uint32_t forceGPUVendor = 0;
    uint32_t forceGPUDeviceID = 0;
    uint32_t forceGPUDriverName_unused = 0;
    // Enough to pass a default zeroed struct
};

// ── Callback types ──────────────────────────────────────────────────────────
typedef void (RENDERDOC_CC *RENDERDOC_ProgressCallback)(float progress);

// ── Forward-declare interfaces (we access via vtable) ───────────────────────
struct ICaptureFile;
struct IReplayController;
struct IReplayOutput;

// ── DLL function pointer types ──────────────────────────────────────────────
typedef void (RENDERDOC_CC *pfn_InitialiseReplay)(GlobalEnvironment env, const rdcarray<rdcstr> &args);
typedef void (RENDERDOC_CC *pfn_ShutdownReplay)();
typedef ICaptureFile* (RENDERDOC_CC *pfn_OpenCaptureFile)();
typedef const char* (RENDERDOC_CC *pfn_GetVersionString)();
typedef const char* (RENDERDOC_CC *pfn_GetCommitHash)();

// ═══════════════════════════════════════════════════════════════════════════
//  VTABLE INTERFACES
//
//  We don't need the full class definition. We define the vtable as an array
//  of function pointers and call by index. This matches MSVC x64 ABI where
//  virtual functions are in declaration order.
//
//  The vtable indices are counted from renderdoc_replay.h (v1.x branch).
// ═══════════════════════════════════════════════════════════════════════════

// ICaptureFile vtable indices (inherits from ICaptureAccess which has virtual methods first)
//
// ICaptureAccess virtual methods (base class):
//   0: GetAvailableGPUs
//   1: GetSectionCount
//   2: FindSectionByName
//   3: FindSectionByType
//   4: GetSectionProperties
//   5: GetSectionContents
//   6: WriteSection
//   7: HasCallstacks
//   8: InitResolver
//   9: GetResolve
//  10: DriverName
//  11: EmbedDependenciesIntoCapture
//  12: RemoveDependenciesFromCapture
//  13: HasEmbeddedDependencies
//  14: HasPendingDependencies
//  15: GetPendingDependenciesNicknames
//
// ICaptureFile own methods:
//  16: Shutdown
//  17: OpenFile
//  18: OpenBuffer
//  19: CopyFileTo
//  20: Convert
//  21: GetCaptureFileFormats
//  22: LocalReplaySupport
//  23: RecordedMachineIdent
//  24: TimestampBase
//  25: TimestampFrequency
//  26: SetMetadata
//  27: OpenCapture
//  28: GetStructuredData
//  29: SetStructuredData
//  30: GetThumbnail

namespace VT_CaptureFile {
    constexpr int GetSectionCount       = 1;
    constexpr int GetSectionProperties  = 4;
    constexpr int DriverName            = 10;
    constexpr int Shutdown              = 16;
    constexpr int OpenFile              = 17;
    constexpr int RecordedMachineIdent  = 23;
    constexpr int TimestampBase         = 24;
    constexpr int TimestampFrequency    = 25;
    constexpr int OpenCapture           = 27;
    constexpr int GetThumbnail          = 30;
}

// IReplayController vtable indices:
//   0: GetAPIProperties
//   1: GetSupportedWindowSystems
//   2: CreateOutput
//   3: Shutdown
//   4: ReplayLoop
//   5: CreateRGPProfile
//   6: CancelReplayLoop
//   7: FileChanged
//   8: SetFrameEvent
//   9: GetD3D11PipelineState
//  10: GetD3D12PipelineState
//  11: GetGLPipelineState
//  12: GetVulkanPipelineState
//  13: GetPipelineState
//  14: GetDescriptors
//  15: GetSamplerDescriptors
//  16: GetDescriptorAccess
//  17: GetDescriptorLocations
//  18: GetDisassemblyTargets
//  19: DisassembleShader
//  20: SetCustomShaderIncludes
//  21: BuildCustomShader
//  22: FreeCustomShader
//  23: BuildTargetShader
//  24: GetTargetShaderEncodings
//  25: GetCustomShaderEncodings
//  26: GetCustomShaderSourcePrefixes
//  27: ReplaceResource
//  28: ClearReplayCache
//  29: ReloadShaderDebugInformation
//  30: RemoveReplacement
//  31: FreeTargetResource
//  32: GetFrameInfo
//  33: GetStructuredFile
//  34: AddFakeMarkers
//  35: GetRootActions
//  36: FetchCounters
//  37: EnumerateCounters
//  38: DescribeCounter
//  39: GetResources
//  40: GetTextures
//  41: GetBuffers
//  42: GetDescriptorStores
//  43: GetDebugMessages
//  44: GetFatalErrorStatus
//  45: GetShaderEntryPoints
//  46: GetShader
//  47: PickPixel
//  48: GetMinMax
//  49: GetHistogram
//  50: PixelHistory
//  51: DebugVertex
//  52: DebugPixel
//  53: DebugThread
//  54: DebugMeshThread
//  55: ContinueDebug
//  56: FreeTrace
//  57: GetUsage
//  58: GetCBufferVariableContents
//  59: SaveTexture
//  60: GetPostVSData
//  61: GetBufferData
//  62: GetTextureData

namespace VT_Replay {
    constexpr int Shutdown           = 3;
    constexpr int SetFrameEvent      = 8;
    constexpr int GetRootActions     = 35;
    constexpr int GetResources       = 39;
    constexpr int GetTextures        = 40;
    constexpr int GetBuffers         = 41;
    constexpr int GetShaderEntryPoints = 45;
    constexpr int GetShader          = 46;
    constexpr int SaveTexture        = 59;
    constexpr int GetBufferData      = 61;
    constexpr int GetTextureData     = 62;
}

// ── Helper to call virtual functions by vtable index ────────────────────────
// MSVC x64: vtable is at *(void**)obj, functions are at vtable[index]
template <typename Ret, typename... Args>
Ret vtable_call(void *obj, int index, Args... args) {
    void **vtable = *(void ***)obj;
    typedef Ret (RENDERDOC_CC *FnPtr)(void *, Args...);
    FnPtr fn = (FnPtr)vtable[index];
    return fn(obj, args...);
}
