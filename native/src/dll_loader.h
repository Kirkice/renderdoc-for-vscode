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
typedef void  (RENDERDOC_CC *pfn_GetDefaultCaptureOptions)(CaptureOptions *defaultOpts);
typedef ExecuteResult (RENDERDOC_CC *pfn_ExecuteAndInject)(
    const rdcstr &app,
    const rdcstr &workingDir,
    const rdcstr &cmdLine,
    const rdcarray<EnvironmentModification> &env,
    const rdcstr &capturefile,
    const CaptureOptions &opts,
    bool waitForExit);
typedef ExecuteResult (RENDERDOC_CC *pfn_InjectIntoProcess)(
    uint32_t pid,
    const rdcarray<EnvironmentModification> &env,
    const rdcstr &capturefile,
    const CaptureOptions &opts,
    bool waitForExit);
typedef ITargetControl *(RENDERDOC_CC *pfn_CreateTargetControl)(
    const rdcstr &URL,
    uint32_t ident,
    const rdcstr &clientName,
    bool forceConnection);
typedef uint32_t (RENDERDOC_CC *pfn_EnumerateRemoteTargets)(const rdcstr &URL, uint32_t nextIdent);
typedef ResultDetails (RENDERDOC_CC *pfn_CreateRemoteServerConnection)(
    const rdcstr &URL,
    IRemoteServer **rend);
typedef void (RENDERDOC_CC *pfn_GetSupportedDeviceProtocols)(rdcarray<rdcstr> *supportedProtocols);
typedef IDeviceProtocolController *(RENDERDOC_CC *pfn_GetDeviceProtocolController)(const rdcstr &protocol);

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
    pfn_GetDefaultCaptureOptions GetDefaultCaptureOptions = nullptr;
    pfn_ExecuteAndInject    ExecuteAndInject = nullptr;
    pfn_InjectIntoProcess   InjectIntoProcess = nullptr;
    pfn_CreateTargetControl CreateTargetControl = nullptr;
    pfn_EnumerateRemoteTargets EnumerateRemoteTargets = nullptr;
    pfn_CreateRemoteServerConnection CreateRemoteServerConnection = nullptr;
    pfn_GetSupportedDeviceProtocols GetSupportedDeviceProtocols = nullptr;
    pfn_GetDeviceProtocolController GetDeviceProtocolController = nullptr;

private:
    bool m_loaded = false;
    void *m_handle = nullptr; // HMODULE on Windows
};
