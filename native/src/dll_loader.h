#pragma once

#include "bridge_config.h"
#include <string>

// Function pointer types matching the DLL exports
typedef void  (RENDERDOC_CC *pfn_FreeArrayMem)(void *mem);
typedef void *(RENDERDOC_CC *pfn_AllocArrayMem)(uint64_t sz);
typedef void  (RENDERDOC_CC *pfn_InitialiseReplay)(GlobalEnvironment env, const rdcarray<rdcstr> &args);
typedef void  (RENDERDOC_CC *pfn_ShutdownReplay)();
typedef ICaptureFile *(RENDERDOC_CC *pfn_OpenCaptureFile)();
typedef const char  *(RENDERDOC_CC *pfn_GetVersionString)();
typedef const char  *(RENDERDOC_CC *pfn_GetCommitHash)();

/**
 * Dynamically loads renderdoc.dll and resolves all needed function pointers.
 * Also hooks up the allocator functions needed by rdcstr/rdcarray.
 */
class DllLoader {
public:
    bool load(const std::string &renderdocPath);
    void unload();
    bool isLoaded() const { return m_loaded; }

    // Resolved API function pointers
    pfn_InitialiseReplay    InitialiseReplay = nullptr;
    pfn_ShutdownReplay      ShutdownReplay   = nullptr;
    pfn_OpenCaptureFile     OpenCaptureFile  = nullptr;
    pfn_GetVersionString    GetVersionString = nullptr;
    pfn_GetCommitHash       GetCommitHash    = nullptr;

private:
    bool m_loaded = false;
    void *m_handle = nullptr; // HMODULE on Windows
};
