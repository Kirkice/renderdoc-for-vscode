"""
get_resources.py - Extract resource list from an .rdc file.
Outputs JSON to stdout.

Usage: python get_resources.py <path_to_rdc_file>
"""
import sys
import json
import os


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: get_resources.py <rdc_file_path>"}))
        sys.exit(1)

    rdc_path = sys.argv[1]
    if not os.path.isfile(rdc_path):
        print(json.dumps({"error": f"File not found: {rdc_path}"}))
        sys.exit(1)

    try:
        import renderdoc as rd
    except ImportError:
        print(json.dumps({"error": "Cannot import renderdoc module."}))
        sys.exit(1)

    cap = rd.OpenCaptureFile()
    status = cap.OpenFile(rdc_path, '', None)
    if status != rd.ResultCode.Succeeded:
        print(json.dumps({"error": f"Failed to open capture: {str(status)}"}))
        sys.exit(1)

    if not cap.LocalReplaySupport():
        print(json.dumps({"error": "Local replay not supported for this capture."}))
        cap.Shutdown()
        sys.exit(1)

    try:
        status, controller = cap.OpenCapture(rd.ReplayOptions(), None)
        if status != rd.ResultCode.Succeeded:
            print(json.dumps({"error": f"Failed to open replay: {str(status)}"}))
            sys.exit(1)

        try:
            resources = []

            # Textures
            for tex in controller.GetTextures():
                resources.append({
                    "resourceId": str(tex.resourceId),
                    "name": tex.name if hasattr(tex, 'name') else "",
                    "type": "Texture",
                    "format": str(tex.format.Name()) if hasattr(tex.format, 'Name') else str(tex.format),
                    "width": tex.width,
                    "height": tex.height,
                    "depth": tex.depth,
                    "arraySize": tex.arraysize if hasattr(tex, 'arraysize') else 1,
                    "mipLevels": tex.mips if hasattr(tex, 'mips') else 1,
                    "byteSize": tex.byteSize if hasattr(tex, 'byteSize') else 0,
                })

            # Buffers
            for buf in controller.GetBuffers():
                resources.append({
                    "resourceId": str(buf.resourceId),
                    "name": buf.name if hasattr(buf, 'name') else "",
                    "type": "Buffer",
                    "format": "",
                    "width": 0,
                    "height": 0,
                    "depth": 0,
                    "arraySize": 0,
                    "mipLevels": 0,
                    "byteSize": buf.length,
                })

            print(json.dumps(resources))
        finally:
            controller.Shutdown()
    finally:
        cap.Shutdown()


if __name__ == "__main__":
    main()
