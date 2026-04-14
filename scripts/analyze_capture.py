"""
analyze_capture.py - Extract capture metadata from an .rdc file.
Outputs JSON to stdout.

Usage: python analyze_capture.py <path_to_rdc_file>
"""
import sys
import json
import os


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: analyze_capture.py <rdc_file_path>"}))
        sys.exit(1)

    rdc_path = sys.argv[1]
    if not os.path.isfile(rdc_path):
        print(json.dumps({"error": f"File not found: {rdc_path}"}))
        sys.exit(1)

    try:
        import renderdoc as rd
    except ImportError:
        print(json.dumps({"error": "Cannot import renderdoc module. Ensure RenderDoc is installed and PYTHONPATH includes pymodules."}))
        sys.exit(1)

    cap = rd.OpenCaptureFile()

    status = cap.OpenFile(rdc_path, '', None)
    if status != rd.ResultCode.Succeeded:
        print(json.dumps({"error": f"Failed to open capture: {str(status)}"}))
        sys.exit(1)

    try:
        # Basic info
        driver_name = cap.DriverName()
        machine_ident = str(cap.RecordedMachineIdent())
        timestamp_base = cap.TimestampBase()
        timestamp_freq = cap.TimestampFrequency()

        # Sections
        section_count = cap.GetSectionCount()
        sections = []
        for i in range(section_count):
            props = cap.GetSectionProperties(i)
            sections.append({
                "name": props.name if hasattr(props, 'name') else str(i),
                "type": str(props.type) if hasattr(props, 'type') else "Unknown",
                "size": props.uncompressedBytesAvailable if hasattr(props, 'uncompressedBytesAvailable') else 0,
                "compressedSize": props.compressedBytesAvailable if hasattr(props, 'compressedBytesAvailable') else 0,
                "version": props.version if hasattr(props, 'version') else 0,
                "flags": str(props.flags) if hasattr(props, 'flags') else "",
            })

        # Determine API from driver name
        api = "Unknown"
        driver_lower = driver_name.lower()
        if "vulkan" in driver_lower:
            api = "Vulkan"
        elif "d3d12" in driver_lower or "direct3d 12" in driver_lower:
            api = "D3D12"
        elif "d3d11" in driver_lower or "direct3d 11" in driver_lower:
            api = "D3D11"
        elif "opengl" in driver_lower:
            if "es" in driver_lower:
                api = "OpenGL ES"
            else:
                api = "OpenGL"

        result = {
            "filePath": rdc_path,
            "api": api,
            "driver": driver_name,
            "machineIdent": machine_ident,
            "rdocVersion": "",  # Extracted from header if available
            "timestamp": str(timestamp_base) if timestamp_base else "",
            "frameCount": 1,
            "sectionCount": section_count,
            "sections": sections,
        }

        print(json.dumps(result))

    finally:
        cap.Shutdown()


if __name__ == "__main__":
    main()
