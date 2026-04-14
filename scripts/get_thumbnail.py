"""
get_thumbnail.py - Extract thumbnail image from an .rdc file.
Outputs JSON with base64-encoded image to stdout.

Usage: python get_thumbnail.py <path_to_rdc_file>
"""
import sys
import json
import os
import base64


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: get_thumbnail.py <rdc_file_path>"}))
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

    try:
        thumb = cap.GetThumbnail(rd.FileType.JPG, 0)

        if thumb is None or (hasattr(thumb, 'data') and len(thumb.data) == 0):
            # No thumbnail available
            print(json.dumps(None))
            return

        # thumb is a Thumbnail object with .data (bytes), .width, .height
        thumb_data = bytes(thumb.data)
        if len(thumb_data) == 0:
            print(json.dumps(None))
            return

        b64 = base64.b64encode(thumb_data).decode('ascii')

        result = {
            "width": thumb.width,
            "height": thumb.height,
            "base64": b64,
            "format": "jpg",
        }
        print(json.dumps(result))

    finally:
        cap.Shutdown()


if __name__ == "__main__":
    main()
