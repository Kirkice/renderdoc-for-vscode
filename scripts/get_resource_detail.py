"""
get_resource_detail.py - Get detailed info for a specific resource.
Outputs JSON to stdout.

Usage: python get_resource_detail.py <path_to_rdc_file> <resource_id>
"""
import sys
import json
import os


def main():
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Usage: get_resource_detail.py <rdc_file_path> <resource_id>"}))
        sys.exit(1)

    rdc_path = sys.argv[1]
    target_id = sys.argv[2]

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
        print(json.dumps({"error": "Local replay not supported."}))
        cap.Shutdown()
        sys.exit(1)

    try:
        status, controller = cap.OpenCapture(rd.ReplayOptions(), None)
        if status != rd.ResultCode.Succeeded:
            print(json.dumps({"error": f"Failed to open replay: {str(status)}"}))
            sys.exit(1)

        try:
            # Search in textures
            for tex in controller.GetTextures():
                if str(tex.resourceId) == target_id:
                    result = {
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
                        "dimension": str(tex.dimension) if hasattr(tex, 'dimension') else "",
                        "creationType": str(tex.creationFlags) if hasattr(tex, 'creationFlags') else "",
                        "msQual": tex.msQual if hasattr(tex, 'msQual') else 0,
                        "msSamp": tex.msSamp if hasattr(tex, 'msSamp') else 0,
                    }
                    print(json.dumps(result))
                    return

            # Search in buffers
            for buf in controller.GetBuffers():
                if str(buf.resourceId) == target_id:
                    result = {
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
                        "creationType": str(buf.creationFlags) if hasattr(buf, 'creationFlags') else "",
                    }
                    print(json.dumps(result))
                    return

            print(json.dumps({"error": f"Resource {target_id} not found."}))

        finally:
            controller.Shutdown()
    finally:
        cap.Shutdown()


if __name__ == "__main__":
    main()
