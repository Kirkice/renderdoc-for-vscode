import * as fs from 'fs';
import { CaptureInfo, SectionInfo, ThumbnailData } from './types';

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
const SUPPORTED_RDC_VERSIONS = new Set([0x100, 0x101, 0x102]);
const SECTION_FLAG_LZ4  = 0x2;
const SECTION_FLAG_ZSTD = 0x4;
const SECTION_FLAG_ASCII = 0x1;
const SECTION_TYPE_EXTENDED_THUMBNAIL = 7;
const MAX_THUMBNAIL_BYTES = 10 * 1024 * 1024;
const MAX_SECTION_NAME_BYTES = 2 * 1024;
const MIN_HEADER_BYTES = 40;
const EXTENDED_THUMBNAIL_HEADER_BYTES = 12;
const FILE_TYPE_COUNT = 8;

type ThumbnailFormat = 'jpg' | 'png' | 'bmp';

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
    9:  'OpenGL ES',
    10: 'Metal',
};

interface ParsedSection {
    info: SectionInfo;
    rawType: number;
    rawFlags: number;
    dataOffset: number;
    diskLength: number;
}

interface ParsedRdcContainer {
    fileSize: number;
    header: RdcHeader;
    sections: ParsedSection[];
}

export interface RdcHeader {
    magic: number;
    version: number;
    headerLength: number;
    progVersion: string;
    thumbWidth: number;
    thumbHeight: number;
    thumbDataLength: number;
    thumbDataOffset: number;
    machineIdent: bigint;
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
        const parsed = await parseRdcContainer(fd);
        const { header, sections } = parsed;

        return {
            filePath,
            api: header.api,
            driver: header.driverName,
            machineIdent: String(header.machineIdent),
            rdocVersion: header.progVersion,
            timestamp: header.timeBase !== undefined ? String(header.timeBase) : '',
            frameCount: 1,
            sectionCount: sections.length,
            sections: sections.map((section) => section.info),
        };
    } finally {
        await fd.close();
    }
}

/**
 * Parse the embedded RDC thumbnail.
 * Prefers ExtendedThumbnail when it is directly readable, otherwise falls back
 * to the primary header JPG thumbnail.
 */
export async function parseRdcThumbnail(filePath: string): Promise<ThumbnailData | null> {
    const fd = await fs.promises.open(filePath, 'r');
    try {
        const parsed = await parseRdcContainer(fd);
        const extendedThumbnail = await readExtendedThumbnail(fd, parsed);
        if (extendedThumbnail !== undefined) {
            return extendedThumbnail;
        }

        return readPrimaryThumbnail(fd, parsed.header);
    } finally {
        await fd.close();
    }
}

async function parseRdcContainer(fd: fs.promises.FileHandle): Promise<ParsedRdcContainer> {
    const stat = await fd.stat();
    const fileSize = stat.size;
    if (fileSize < MIN_HEADER_BYTES) {
        throw new Error(`RDC file is truncated before the thumbnail header (${fileSize} bytes)`);
    }

    const header = await parseRdcHeader(fd, fileSize);
    const sections = await parseSections(fd, header.headerLength, fileSize);

    return {
        fileSize,
        header,
        sections,
    };
}

async function parseRdcHeader(fd: fs.promises.FileHandle, fileSize: number): Promise<RdcHeader> {
    const headerBuf = Buffer.alloc(MIN_HEADER_BYTES);
    await readExactly(fd, headerBuf, 0, 'RDC file header');

    const magic = headerBuf.readUInt32LE(0);
    if (magic !== RDC_MAGIC) {
        throw new Error(`Not a valid RDC file (magic: 0x${magic.toString(16)})`);
    }

    const version = headerBuf.readUInt32LE(8);
    if (!SUPPORTED_RDC_VERSIONS.has(version)) {
        throw new Error(`Unsupported RDC version 0x${version.toString(16)}`);
    }

    const headerLength = headerBuf.readUInt32LE(12);
    const progVersion = headerBuf.subarray(16, 32).toString('ascii').replace(/\0+$/, '');
    if (headerLength < MIN_HEADER_BYTES) {
        throw new Error(`Invalid RDC header length ${headerLength}`);
    }
    if (headerLength > fileSize) {
        throw new Error(`RDC header length ${headerLength} exceeds file size ${fileSize}`);
    }

    const thumbWidth = headerBuf.readUInt16LE(32);
    const thumbHeight = headerBuf.readUInt16LE(34);
    const thumbDataLength = headerBuf.readUInt32LE(36);
    const thumbDataOffset = 40;
    if (thumbDataLength > MAX_THUMBNAIL_BYTES) {
        throw new Error(`Thumbnail byte length is invalid: ${thumbDataLength}`);
    }

    const metaOffset = thumbDataOffset + thumbDataLength;
    if (metaOffset + 13 > headerLength || metaOffset + 13 > fileSize) {
        throw new Error('RDC header is truncated before capture metadata');
    }

    const metaBuf = Buffer.alloc(13);
    await readExactly(fd, metaBuf, metaOffset, 'capture metadata');

    const machineIdent = metaBuf.readBigUInt64LE(0);
    const driverID = metaBuf.readUInt32LE(8);
    const driverNameLen = metaBuf.readUInt8(12);
    if (driverNameLen < 1) {
        throw new Error('Driver name length is invalid; expected at least the null terminator');
    }
    if (metaOffset + 13 + driverNameLen > headerLength || metaOffset + 13 + driverNameLen > fileSize) {
        throw new Error('RDC header is truncated while reading the driver name');
    }

    const driverNameBuf = Buffer.alloc(driverNameLen);
    await readExactly(fd, driverNameBuf, metaOffset + 13, 'driver name');
    const driverName = decodeNullTerminatedString(driverNameBuf);

    let api = DRIVER_NAMES[driverID] || 'Unknown';
    const driverLower = driverName.toLowerCase();
    if (driverLower.includes('vulkan')) { api = 'Vulkan'; }
    else if (driverLower.includes('d3d12') || driverLower.includes('direct3d 12')) { api = 'D3D12'; }
    else if (driverLower.includes('d3d11') || driverLower.includes('direct3d 11')) { api = 'D3D11'; }
    else if (driverLower.includes('opengles') || driverLower.includes('opengl es') || driverLower.includes('gles')) { api = 'OpenGL ES'; }
    else if (driverLower.includes('opengl')) { api = 'OpenGL'; }

    let timeBase: bigint | undefined;
    let timeFreq: number | undefined;
    let cursor = metaOffset + 13 + driverNameLen;
    if (version >= 0x102) {
        if (cursor + 16 > headerLength || cursor + 16 > fileSize) {
            throw new Error('RDC header is truncated while reading the capture time base');
        }

        const timeBuf = Buffer.alloc(16);
        await readExactly(fd, timeBuf, cursor, 'capture time base');
        timeBase = timeBuf.readBigUInt64LE(0);
        timeFreq = timeBuf.readDoubleLE(8);
        cursor += 16;
    }

    if (cursor > headerLength) {
        throw new Error(`RDC header overran the declared header length (${cursor} > ${headerLength})`);
    }

    return {
        magic,
        version,
        headerLength,
        progVersion,
        thumbWidth,
        thumbHeight,
        thumbDataLength,
        thumbDataOffset,
        machineIdent,
        driverID,
        driverName,
        api,
        timeBase,
        timeFreq,
    };
}

async function readPrimaryThumbnail(fd: fs.promises.FileHandle, header: RdcHeader): Promise<ThumbnailData | null> {
    if (header.thumbWidth === 0 || header.thumbHeight === 0 || header.thumbDataLength === 0) {
        return null;
    }

    const thumbData = Buffer.alloc(header.thumbDataLength);
    await readExactly(fd, thumbData, header.thumbDataOffset, 'primary thumbnail data');

    return {
        width: header.thumbWidth,
        height: header.thumbHeight,
        base64: thumbData.toString('base64'),
        format: 'jpg',
    };
}

async function readExtendedThumbnail(
    fd: fs.promises.FileHandle,
    parsed: ParsedRdcContainer,
): Promise<ThumbnailData | null | undefined> {
    const section = parsed.sections.find((candidate) => candidate.rawType === SECTION_TYPE_EXTENDED_THUMBNAIL);
    if (!section) {
        return undefined;
    }

    if (section.rawFlags & (SECTION_FLAG_ASCII | SECTION_FLAG_LZ4 | SECTION_FLAG_ZSTD)) {
        return null;
    }
    if (section.diskLength < EXTENDED_THUMBNAIL_HEADER_BYTES) {
        return null;
    }

    const extHeader = Buffer.alloc(EXTENDED_THUMBNAIL_HEADER_BYTES);
    await readExactly(fd, extHeader, section.dataOffset, 'extended thumbnail header');

    const width = extHeader.readUInt16LE(0);
    const height = extHeader.readUInt16LE(2);
    const dataLength = extHeader.readUInt32LE(4);
    const formatId = extHeader.readUInt32LE(8);

    if (width === 0 || height === 0 || dataLength === 0) {
        return null;
    }
    if (dataLength > MAX_THUMBNAIL_BYTES) {
        return null;
    }
    if (formatId >= FILE_TYPE_COUNT) {
        return null;
    }

    const format = thumbnailFormatName(formatId);
    if (!format) {
        return null;
    }
    if (EXTENDED_THUMBNAIL_HEADER_BYTES + dataLength > section.diskLength) {
        return null;
    }

    const data = Buffer.alloc(dataLength);
    await readExactly(fd, data, section.dataOffset + EXTENDED_THUMBNAIL_HEADER_BYTES, 'extended thumbnail data');

    return {
        width,
        height,
        base64: data.toString('base64'),
        format,
    };
}

/** Parse section headers starting at the given offset until EOF. */
async function parseSections(fd: fs.promises.FileHandle, offset: number, fileSize: number): Promise<ParsedSection[]> {
    const sections: ParsedSection[] = [];

    let pos = offset;
    while (pos < fileSize) {
        const markerBuf = Buffer.alloc(1);
        const { bytesRead } = await fd.read(markerBuf, 0, 1, pos);
        if (bytesRead === 0) {
            break;
        }

        const marker = markerBuf.readUInt8(0);
        if (marker === 0x41) {
            const parsed = await parseAsciiSection(fd, pos, fileSize);
            sections.push(parsed.section);
            pos = parsed.nextOffset;
            continue;
        }

        if (marker !== 0x00) {
            throw new Error(`Unrecognised section marker 0x${marker.toString(16)} at offset ${pos}`);
        }

        const parsed = await parseBinarySection(fd, pos, fileSize);
        sections.push(parsed.section);
        pos = parsed.nextOffset;
    }

    if (sections.length === 0) {
        throw new Error('RDC file does not contain any sections');
    }
    if (sections[0].info.type !== 'FrameCapture') {
        throw new Error('RDC file is missing FrameCapture as the first section');
    }
    if (!sections.some((section) => section.info.type === 'FrameCapture')) {
        throw new Error('RDC file does not contain a FrameCapture section');
    }

    return sections;
}

async function parseBinarySection(
    fd: fs.promises.FileHandle,
    offset: number,
    fileSize: number,
): Promise<{ section: ParsedSection; nextOffset: number }> {
    const headerBuf = Buffer.alloc(40);
    await readExactly(fd, headerBuf, offset, `binary section header at ${offset}`);

    const sectionType = headerBuf.readUInt32LE(4);
    const compressedLength = Number(headerBuf.readBigUInt64LE(8));
    const uncompressedLength = Number(headerBuf.readBigUInt64LE(16));
    const sectionVersion = Number(headerBuf.readBigUInt64LE(24));
    const sectionFlags = headerBuf.readUInt32LE(32);
    const sectionNameLength = headerBuf.readUInt32LE(36);

    if (sectionNameLength < 1 || sectionNameLength > MAX_SECTION_NAME_BYTES) {
        throw new Error(`Invalid binary section name length ${sectionNameLength} at offset ${offset}`);
    }

    const nextOffset = offset + 40 + sectionNameLength + compressedLength;
    if (nextOffset > fileSize) {
        throw new Error(`Binary section at offset ${offset} extends past end of file`);
    }

    const nameBuf = Buffer.alloc(sectionNameLength);
    await readExactly(fd, nameBuf, offset + 40, `binary section name at ${offset}`);
    const sectionName = decodeNullTerminatedString(nameBuf);
    const dataOffset = offset + 40 + sectionNameLength;

    return {
        section: {
            info: {
                name: sectionName || sectionTypeName(sectionType),
                type: sectionTypeName(sectionType),
                size: uncompressedLength,
                compressedSize: compressedLength,
                version: sectionVersion,
                flags: formatSectionFlags(sectionFlags),
            },
            rawType: sectionType,
            rawFlags: sectionFlags,
            dataOffset,
            diskLength: compressedLength,
        },
        nextOffset,
    };
}

async function parseAsciiSection(
    fd: fs.promises.FileHandle,
    offset: number,
    fileSize: number,
): Promise<{ section: ParsedSection; nextOffset: number }> {
    const newlineBuf = Buffer.alloc(1);
    await readExactly(fd, newlineBuf, offset + 1, `ASCII section newline at ${offset}`);
    if (newlineBuf.readUInt8(0) !== 0x0A) {
        throw new Error(`Invalid ASCII section header at offset ${offset}`);
    }

    let cursor = offset + 2;
    const lengthLine = await readAsciiLine(fd, cursor, fileSize, `ASCII section length at ${offset}`);
    cursor = lengthLine.nextOffset;
    const typeLine = await readAsciiLine(fd, cursor, fileSize, `ASCII section type at ${offset}`);
    cursor = typeLine.nextOffset;
    const versionLine = await readAsciiLine(fd, cursor, fileSize, `ASCII section version at ${offset}`);
    cursor = versionLine.nextOffset;
    const nameLine = await readAsciiLine(fd, cursor, fileSize, `ASCII section name at ${offset}`);
    cursor = nameLine.nextOffset;

    const sectionLength = parseDecimalField(lengthLine.value, 'ASCII section length');
    const sectionType = parseDecimalField(typeLine.value, 'ASCII section type');
    const sectionVersion = parseDecimalField(versionLine.value, 'ASCII section version');
    const nextOffset = cursor + sectionLength;
    if (nextOffset > fileSize) {
        throw new Error(`ASCII section at offset ${offset} extends past end of file`);
    }

    return {
        section: {
            info: {
                name: nameLine.value || sectionTypeName(sectionType),
                type: sectionTypeName(sectionType),
                size: sectionLength,
                compressedSize: sectionLength,
                version: sectionVersion,
                flags: 'ASCII',
            },
            rawType: sectionType,
            rawFlags: SECTION_FLAG_ASCII,
            dataOffset: cursor,
            diskLength: sectionLength,
        },
        nextOffset,
    };
}

async function readExactly(
    fd: fs.promises.FileHandle,
    buffer: Buffer,
    position: number,
    label: string,
): Promise<void> {
    let totalBytesRead = 0;
    while (totalBytesRead < buffer.length) {
        const { bytesRead } = await fd.read(
            buffer,
            totalBytesRead,
            buffer.length - totalBytesRead,
            position + totalBytesRead,
        );
        if (bytesRead === 0) {
            throw new Error(`Unexpected end of file while reading ${label}`);
        }
        totalBytesRead += bytesRead;
    }
}

async function readAsciiLine(
    fd: fs.promises.FileHandle,
    offset: number,
    fileSize: number,
    label: string,
): Promise<{ value: string; nextOffset: number }> {
    const byteBuf = Buffer.alloc(1);
    const bytes: number[] = [];
    let cursor = offset;

    while (cursor < fileSize) {
        const { bytesRead } = await fd.read(byteBuf, 0, 1, cursor);
        if (bytesRead === 0) {
            break;
        }

        cursor += 1;
        const value = byteBuf.readUInt8(0);
        if (value === 0x0A) {
            return { value: Buffer.from(bytes).toString('utf8'), nextOffset: cursor };
        }
        if (value !== 0x00) {
            bytes.push(value);
        }
    }

    throw new Error(`Unexpected end of file while reading ${label}`);
}

function parseDecimalField(value: string, label: string): number {
    if (!/^\d+$/.test(value)) {
        throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
    }

    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) {
        throw new Error(`${label} is too large to represent safely: ${value}`);
    }

    return parsed;
}

function decodeNullTerminatedString(buffer: Buffer): string {
    const nullIndex = buffer.indexOf(0);
    const end = nullIndex >= 0 ? nullIndex : buffer.length;
    return buffer.subarray(0, end).toString('utf8');
}

function thumbnailFormatName(fileType: number): ThumbnailFormat | null {
    switch (fileType) {
    case 1:
        return 'png';
    case 2:
        return 'jpg';
    case 3:
        return 'bmp';
    default:
        return null;
    }
}

function formatSectionFlags(sectionFlags: number): string {
    const flagStrs: string[] = [];
    if (sectionFlags & SECTION_FLAG_ASCII) { flagStrs.push('ASCII'); }
    if (sectionFlags & SECTION_FLAG_LZ4)   { flagStrs.push('LZ4'); }
    if (sectionFlags & SECTION_FLAG_ZSTD)  { flagStrs.push('Zstd'); }
    return flagStrs.join(', ') || 'None';
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
