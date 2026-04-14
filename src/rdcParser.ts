import * as fs from 'fs';
import { CaptureInfo, SectionInfo } from './types';

/**
 * RDC binary header parser.
 * Reads capture metadata directly from .rdc files without external dependencies.
 *
 * RDC file layout:
 *   [0..7]   uint64  magic ("RDOC" = 0x434F4452)
 *   [8..11]  uint32  version (e.g. 0x102)
 *   [12..15] uint32  headerLength
 *   [16..31] char[16] progVersion
 *   -- BinaryThumbnail --
 *   [32..33] uint16  thumbWidth
 *   [34..35] uint16  thumbHeight
 *   [36..39] uint32  thumbDataLen
 *   [40..40+thumbDataLen-1] thumbData (JPG)
 *   -- CaptureMetaData --
 *   uint64  machineIdent
 *   uint32  driverID
 *   uint8   driverNameLength (incl. null)
 *   char[]  driverName
 *   -- (v0x102+) CaptureTimeBase --
 *   uint64  timeBase
 *   float64 timeFreq
 *   -- Sections follow at offset headerLength --
 */

const RDC_MAGIC = 0x434F4452; // "RDOC" as uint32 LE (first 4 bytes)
const SECTION_FLAG_LZ4  = 0x2;
const SECTION_FLAG_ZSTD = 0x4;
const SECTION_FLAG_ASCII = 0x1;

/** RDCDriver enum values → human-readable API names */
const DRIVER_NAMES: Record<number, string> = {
    1:  'D3D11',
    2:  'D3D12',
    3:  'OpenGL',
    4:  'Vulkan',
    5:  'D3D10',
    6:  'D3D9',
    7:  'OpenGL',
    8:  'Vulkan',
    9:  'OpenGLES',
    10: 'Metal',
};

export interface RdcHeader {
    magic: number;
    version: number;
    headerLength: number;
    progVersion: string;
    thumbWidth: number;
    thumbHeight: number;
    thumbDataLength: number;
    thumbDataOffset: number;
    machineIdent: number;
    driverID: number;
    driverName: string;
    api: string;
    timeBase?: bigint;
    timeFreq?: number;
}

/**
 * Parse RDC file header + sections into CaptureInfo.
 * Only reads the header portion (first headerLength bytes) plus section headers.
 */
export async function parseRdcFile(filePath: string): Promise<CaptureInfo> {
    const fd = await fs.promises.open(filePath, 'r');
    try {
        // Read enough for the file header (36 bytes)
        const headerBuf = Buffer.alloc(48);
        await fd.read(headerBuf, 0, 48, 0);

        // Validate magic
        const magic = headerBuf.readUInt32LE(0);
        if (magic !== RDC_MAGIC) {
            throw new Error(`Not a valid RDC file (magic: 0x${magic.toString(16)})`);
        }

        const version = headerBuf.readUInt32LE(8);
        const headerLength = headerBuf.readUInt32LE(12);
        const progVersion = headerBuf.subarray(16, 32).toString('ascii').replace(/\0+$/, '');

        // Thumbnail
        const thumbWidth = headerBuf.readUInt16LE(32);
        const thumbHeight = headerBuf.readUInt16LE(34);
        const thumbDataLength = headerBuf.readUInt32LE(36);
        const thumbDataOffset = 40;

        // Capture metadata follows thumbnail data
        let metaOffset = 40 + thumbDataLength;
        const metaBuf = Buffer.alloc(256);
        await fd.read(metaBuf, 0, 256, metaOffset);

        // machineIdent: uint64 (read as Number — OK for reasonable values)
        const machineIdent = Number(metaBuf.readBigUInt64LE(0));
        const driverID = metaBuf.readUInt32LE(8);
        const driverNameLen = metaBuf.readUInt8(12);
        const driverName = metaBuf.subarray(13, 13 + Math.max(0, driverNameLen - 1)).toString('ascii');

        // Determine API from driverID or driverName
        let api = DRIVER_NAMES[driverID] || 'Unknown';
        const driverLower = driverName.toLowerCase();
        if (driverLower.includes('vulkan')) { api = 'Vulkan'; }
        else if (driverLower.includes('d3d12') || driverLower.includes('direct3d 12')) { api = 'D3D12'; }
        else if (driverLower.includes('d3d11') || driverLower.includes('direct3d 11')) { api = 'D3D11'; }
        else if (driverLower.includes('opengles')) { api = 'OpenGL ES'; }
        else if (driverLower.includes('opengl')) { api = 'OpenGL'; }

        // Time base (v0x102+)
        let timeBase: bigint | undefined;
        let timeFreq: number | undefined;
        if (version >= 0x102) {
            const timeOffset = metaOffset + 13 + Math.max(0, driverNameLen);
            if (timeOffset + 16 <= headerLength) {
                const timeBuf = Buffer.alloc(16);
                await fd.read(timeBuf, 0, 16, timeOffset);
                timeBase = timeBuf.readBigUInt64LE(0);
                timeFreq = timeBuf.readDoubleLE(8);
            }
        }

        // Parse sections (start at headerLength)
        const sections = await parseSections(fd, headerLength);

        return {
            filePath,
            api,
            driver: driverName,
            machineIdent: String(machineIdent),
            rdocVersion: progVersion,
            timestamp: timeBase !== undefined ? String(timeBase) : '',
            frameCount: 1,
            sectionCount: sections.length,
            sections,
        };
    } finally {
        await fd.close();
    }
}

/** Parse section headers starting at the given offset until EOF. */
async function parseSections(fd: fs.promises.FileHandle, offset: number): Promise<SectionInfo[]> {
    const stat = await fd.stat();
    const fileSize = stat.size;
    const sections: SectionInfo[] = [];

    let pos = offset;
    while (pos < fileSize) {
        // Read section header (at least 40 bytes for binary)
        const hdrBuf = Buffer.alloc(44);
        const { bytesRead } = await fd.read(hdrBuf, 0, 44, pos);
        if (bytesRead < 4) { break; }

        const isASCII = hdrBuf.readUInt8(0) === 0x41; // 'A'

        if (isASCII) {
            // ASCII sections are harder to parse; skip for now
            break;
        }

        // Binary section header:
        // [0]    byte isASCII (0x00)
        // [1..3] byte[3] zero
        // [4..7] uint32 sectionType
        // [8..15]  uint64 compressedLength
        // [16..23] uint64 uncompressedLength
        // [24..31] uint64 sectionVersion
        // [32..35] uint32 sectionFlags
        // [36..39] uint32 sectionNameLength
        // [40..40+nameLen-1] name
        // [40+nameLen..] data[compressedLength]

        const sectionType = hdrBuf.readUInt32LE(4);
        const compressedLength = Number(hdrBuf.readBigUInt64LE(8));
        const uncompressedLength = Number(hdrBuf.readBigUInt64LE(16));
        const sectionVersion = Number(hdrBuf.readBigUInt64LE(24));
        const sectionFlags = hdrBuf.readUInt32LE(32);
        const sectionNameLength = hdrBuf.readUInt32LE(36);

        // Read section name
        let sectionName = '';
        if (sectionNameLength > 0 && sectionNameLength < 4096) {
            const nameBuf = Buffer.alloc(sectionNameLength);
            await fd.read(nameBuf, 0, sectionNameLength, pos + 40);
            sectionName = nameBuf.toString('ascii').replace(/\0+$/, '');
        }

        const flagStrs: string[] = [];
        if (sectionFlags & SECTION_FLAG_ASCII) { flagStrs.push('ASCII'); }
        if (sectionFlags & SECTION_FLAG_LZ4)   { flagStrs.push('LZ4'); }
        if (sectionFlags & SECTION_FLAG_ZSTD)  { flagStrs.push('Zstd'); }

        sections.push({
            name: sectionName || sectionTypeName(sectionType),
            type: sectionTypeName(sectionType),
            size: uncompressedLength,
            compressedSize: compressedLength,
            version: sectionVersion,
            flags: flagStrs.join(', ') || 'None',
        });

        // Advance past header + name + data
        pos += 40 + sectionNameLength + compressedLength;
    }

    return sections;
}

const SECTION_TYPE_NAMES: Record<number, string> = {
    1: 'FrameCapture',
    2: 'ResolveDatabase',
    3: 'Bookmarks',
    4: 'Notes',
    5: 'ResourceRenames',
    6: 'AMDRGPProfile',
    7: 'ExtendedThumbnail',
    8: 'EmbeddedLogfile',
    9: 'EditedShaders',
    10: 'D3D12Core',
    11: 'D3D12SDKLayers',
};

function sectionTypeName(type: number): string {
    return SECTION_TYPE_NAMES[type] || `Unknown(${type})`;
}
