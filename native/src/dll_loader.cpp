#include "dll_loader.h"

#ifdef _WIN32
#include <windows.h>
#else
#include <dlfcn.h>
#endif

#include <filesystem>
#include <cstdio>
#include <cstdlib>

// ── Allocator forwarders ────────────────────────────────────────────────────
// rdcstr and rdcarray call RENDERDOC_FreeArrayMem / RENDERDOC_AllocArrayMem
// at runtime. Since we load the DLL dynamically, we provide implementations
// that forward to the DLL's actual allocators (or fall back to CRT).
static pfn_FreeArrayMem  s_freeImpl  = nullptr;
static pfn_AllocArrayMem s_allocImpl = nullptr;

extern "C" void RENDERDOC_CC RENDERDOC_FreeArrayMem(void *mem) {
    if (s_freeImpl) s_freeImpl(mem);
    else free(mem);
}

extern "C" void *RENDERDOC_CC RENDERDOC_AllocArrayMem(uint64_t sz) {
    if (s_allocImpl) return s_allocImpl(sz);
    return malloc((size_t)sz);
}

// ── DllLoader ───────────────────────────────────────────────────────────────

bool DllLoader::load(const std::string &renderdocPath) {
    if (m_loaded) return true;

#ifdef _WIN32
    std::filesystem::path dllPath = std::filesystem::path(renderdocPath) / "renderdoc.dll";
    if (!std::filesystem::exists(dllPath)) {
        fprintf(stderr, "renderdoc.dll not found at: %s\n", dllPath.string().c_str());
        return false;
    }

    SetDllDirectoryA(renderdocPath.c_str());

    HMODULE hDll = LoadLibraryA(dllPath.string().c_str());
    if (!hDll) {
        fprintf(stderr, "Failed to load renderdoc.dll (error %lu)\n", GetLastError());
        return false;
    }
    m_handle = (void *)hDll;

    // Resolve allocators first — rdcstr/rdcarray need them immediately
    s_allocImpl = (pfn_AllocArrayMem)GetProcAddress(hDll, "RENDERDOC_AllocArrayMem");
    s_freeImpl  = (pfn_FreeArrayMem)GetProcAddress(hDll, "RENDERDOC_FreeArrayMem");

    if (!s_allocImpl || !s_freeImpl) {
        fprintf(stderr, "Failed to resolve RENDERDOC_AllocArrayMem/FreeArrayMem\n");
        FreeLibrary(hDll);
        m_handle = nullptr;
        return false;
    }

    // Resolve replay API functions
    InitialiseReplay = (pfn_InitialiseReplay)GetProcAddress(hDll, "RENDERDOC_InitialiseReplay");
    ShutdownReplay   = (pfn_ShutdownReplay)GetProcAddress(hDll, "RENDERDOC_ShutdownReplay");
    OpenCaptureFile  = (pfn_OpenCaptureFile)GetProcAddress(hDll, "RENDERDOC_OpenCaptureFile");
    GetVersionString = (pfn_GetVersionString)GetProcAddress(hDll, "RENDERDOC_GetVersionString");
    GetCommitHash    = (pfn_GetCommitHash)GetProcAddress(hDll, "RENDERDOC_GetCommitHash");
    GetDefaultCaptureOptions = (pfn_GetDefaultCaptureOptions)GetProcAddress(hDll, "RENDERDOC_GetDefaultCaptureOptions");
    ExecuteAndInject = (pfn_ExecuteAndInject)GetProcAddress(hDll, "RENDERDOC_ExecuteAndInject");
    InjectIntoProcess = (pfn_InjectIntoProcess)GetProcAddress(hDll, "RENDERDOC_InjectIntoProcess");
    CreateTargetControl = (pfn_CreateTargetControl)GetProcAddress(hDll, "RENDERDOC_CreateTargetControl");
    EnumerateRemoteTargets = (pfn_EnumerateRemoteTargets)GetProcAddress(hDll, "RENDERDOC_EnumerateRemoteTargets");
    CreateRemoteServerConnection = (pfn_CreateRemoteServerConnection)GetProcAddress(hDll, "RENDERDOC_CreateRemoteServerConnection");
    GetSupportedDeviceProtocols = (pfn_GetSupportedDeviceProtocols)GetProcAddress(hDll, "RENDERDOC_GetSupportedDeviceProtocols");
    GetDeviceProtocolController = (pfn_GetDeviceProtocolController)GetProcAddress(hDll, "RENDERDOC_GetDeviceProtocolController");

    if (!InitialiseReplay || !ShutdownReplay || !OpenCaptureFile || !GetVersionString) {
        fprintf(stderr, "Failed to resolve one or more RENDERDOC_* functions\n");
        FreeLibrary(hDll);
        m_handle = nullptr;
        return false;
    }

#else
    std::filesystem::path soPath = std::filesystem::path(renderdocPath) / "librenderdoc.so";
    if (!std::filesystem::exists(soPath)) {
        fprintf(stderr, "librenderdoc.so not found at: %s\n", soPath.string().c_str());
        return false;
    }

    void *handle = dlopen(soPath.string().c_str(), RTLD_NOW | RTLD_LOCAL);
    if (!handle) {
        fprintf(stderr, "Failed to load librenderdoc.so: %s\n", dlerror());
        return false;
    }
    m_handle = handle;

    s_allocImpl = (pfn_AllocArrayMem)dlsym(handle, "RENDERDOC_AllocArrayMem");
    s_freeImpl  = (pfn_FreeArrayMem)dlsym(handle, "RENDERDOC_FreeArrayMem");

    InitialiseReplay = (pfn_InitialiseReplay)dlsym(handle, "RENDERDOC_InitialiseReplay");
    ShutdownReplay   = (pfn_ShutdownReplay)dlsym(handle, "RENDERDOC_ShutdownReplay");
    OpenCaptureFile  = (pfn_OpenCaptureFile)dlsym(handle, "RENDERDOC_OpenCaptureFile");
    GetVersionString = (pfn_GetVersionString)dlsym(handle, "RENDERDOC_GetVersionString");
    GetCommitHash    = (pfn_GetCommitHash)dlsym(handle, "RENDERDOC_GetCommitHash");
    GetDefaultCaptureOptions = (pfn_GetDefaultCaptureOptions)dlsym(handle, "RENDERDOC_GetDefaultCaptureOptions");
    ExecuteAndInject = (pfn_ExecuteAndInject)dlsym(handle, "RENDERDOC_ExecuteAndInject");
    InjectIntoProcess = (pfn_InjectIntoProcess)dlsym(handle, "RENDERDOC_InjectIntoProcess");
    CreateTargetControl = (pfn_CreateTargetControl)dlsym(handle, "RENDERDOC_CreateTargetControl");
    EnumerateRemoteTargets = (pfn_EnumerateRemoteTargets)dlsym(handle, "RENDERDOC_EnumerateRemoteTargets");
    CreateRemoteServerConnection = (pfn_CreateRemoteServerConnection)dlsym(handle, "RENDERDOC_CreateRemoteServerConnection");
    GetSupportedDeviceProtocols = (pfn_GetSupportedDeviceProtocols)dlsym(handle, "RENDERDOC_GetSupportedDeviceProtocols");
    GetDeviceProtocolController = (pfn_GetDeviceProtocolController)dlsym(handle, "RENDERDOC_GetDeviceProtocolController");

    if (!s_allocImpl || !s_freeImpl || !InitialiseReplay ||
        !ShutdownReplay || !OpenCaptureFile || !GetVersionString) {
        fprintf(stderr, "Failed to resolve RENDERDOC symbols\n");
        dlclose(handle);
        m_handle = nullptr;
        return false;
    }
#endif

    m_loaded = true;
    return true;
}

void DllLoader::unload() {
    if (!m_loaded || !m_handle) return;

#ifdef _WIN32
    FreeLibrary((HMODULE)m_handle);
#else
    dlclose(m_handle);
#endif

    m_handle = nullptr;
    m_loaded = false;
    s_allocImpl = nullptr;
    s_freeImpl  = nullptr;
    InitialiseReplay = nullptr;
    ShutdownReplay   = nullptr;
    OpenCaptureFile  = nullptr;
    GetVersionString = nullptr;
    GetCommitHash    = nullptr;
    GetDefaultCaptureOptions = nullptr;
    ExecuteAndInject = nullptr;
    InjectIntoProcess = nullptr;
    CreateTargetControl = nullptr;
    EnumerateRemoteTargets = nullptr;
    CreateRemoteServerConnection = nullptr;
    GetSupportedDeviceProtocols = nullptr;
    GetDeviceProtocolController = nullptr;
}
