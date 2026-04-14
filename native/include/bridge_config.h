/**
 * Bridge configuration header.
 *
 * Must be included BEFORE any RenderDoc header. Sets up platform defines and
 * overrides RENDERDOC_API to empty so that extern "C" function declarations
 * don't use __declspec(dllimport) — we load renderdoc.dll at runtime via
 * LoadLibrary/GetProcAddress.
 */
#pragma once

// ── Platform selection ──────────────────────────────────────────────────────
#if defined(_WIN32)
#define RENDERDOC_PLATFORM_WIN32
#elif defined(__linux__)
#define RENDERDOC_PLATFORM_LINUX
#elif defined(__APPLE__)
#define RENDERDOC_PLATFORM_APPLE
#endif

// ── Step 1: Include apidefs.h to get enum helpers, BITMASK_OPERATORS, etc. ─
#include "renderdoc/apidefs.h"

// ── Step 2: Override RENDERDOC_API to empty (we load DLL dynamically) ──────
// apidefs.h defined RENDERDOC_API as __declspec(dllimport). We clear that
// so the extern "C" functions become plain declarations we can implement
// ourselves (the allocators) or ignore (the API entry points we call via
// function pointers from GetProcAddress).
#undef RENDERDOC_API
#define RENDERDOC_API

#undef RENDERDOC_IMPORT_API
#define RENDERDOC_IMPORT_API

#undef RENDERDOC_EXPORT_API
#define RENDERDOC_EXPORT_API

// ── Step 3: Pull in the full replay API ────────────────────────────────────
// Thanks to #pragma once, apidefs.h won't be re-included — our overrides
// of RENDERDOC_API will be in effect for all subsequent declarations.
#include "renderdoc/renderdoc_replay.h"
