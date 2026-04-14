cmake_minimum_required(VERSION 3.16)
project(renderdoc_bridge LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# We dynamically load renderdoc.dll — no link-time dependency
add_executable(renderdoc_bridge
    src/main.cpp
    src/dll_loader.cpp
)

target_include_directories(renderdoc_bridge PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/include
    ${CMAKE_CURRENT_SOURCE_DIR}/src
)

# Windows-specific settings
if(WIN32)
    target_compile_definitions(renderdoc_bridge PRIVATE
        _CRT_SECURE_NO_WARNINGS
        WIN32_LEAN_AND_MEAN
        NOMINMAX
    )
    # Suppress warnings from RenderDoc and nlohmann headers
    target_compile_options(renderdoc_bridge PRIVATE /W3 /wd4267 /wd4244 /wd4996 /bigobj)
endif()

# Release optimizations
if(CMAKE_BUILD_TYPE STREQUAL "Release")
    if(MSVC)
        target_compile_options(renderdoc_bridge PRIVATE /O2 /GL)
        target_link_options(renderdoc_bridge PRIVATE /LTCG)
    endif()
endif()
