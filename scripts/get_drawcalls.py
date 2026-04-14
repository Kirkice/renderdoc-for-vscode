"""
get_drawcalls.py - Extract draw call tree from an .rdc file.
Outputs JSON to stdout.

Usage: python get_drawcalls.py <path_to_rdc_file>
"""
import sys
import json
import os


def action_to_dict(action):
    """Recursively convert an ActionDescription to a dict."""
    flags_str = str(action.flags) if hasattr(action, 'flags') else ""

    result = {
        "eventId": action.eventId,
        "drawIndex": action.drawIndex if hasattr(action, 'drawIndex') else 0,
        "name": action.GetName(None) if hasattr(action, 'GetName') else str(action.customName),
        "flags": flags_str,
        "numIndices": action.numIndices if hasattr(action, 'numIndices') else 0,
        "numInstances": action.numInstances if hasattr(action, 'numInstances') else 0,
        "children": [],
    }

    if hasattr(action, 'children'):
        for child in action.children:
            result["children"].append(action_to_dict(child))

    return result


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: get_drawcalls.py <rdc_file_path>"}))
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
            root_actions = controller.GetRootActions()
            draw_calls = [action_to_dict(a) for a in root_actions]
            print(json.dumps(draw_calls))
        finally:
            controller.Shutdown()
    finally:
        cap.Shutdown()


if __name__ == "__main__":
    main()
