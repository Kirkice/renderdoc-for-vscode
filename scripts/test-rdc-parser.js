const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const esbuild = require('esbuild');

const workspaceRoot = path.resolve(__dirname, '..');
const bundlePath = path.join(os.tmpdir(), `rdcParser.test.${process.pid}.cjs`);

function buildParserBundle() {
  esbuild.buildSync({
    entryPoints: [path.join(workspaceRoot, 'src', 'rdcParser.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundlePath,
    logLevel: 'silent',
  });

  return require(bundlePath);
}

function makeHeader(options = {}) {
  const {
    version = 0x102,
    driverId = 9,
    driverName = 'OpenGL ES Driver',
    machineIdent = 1234567890123456789n,
    timeBase = 987654321n,
    timeFreq = 1000.0,
    thumbnail = Buffer.alloc(0),
    headerPadding = 0,
    progVersion = 'v1.43 286e07',
    invalidDriverNameLength,
  } = options;

  const driverBytes = Buffer.from(driverName + '\0', 'utf8');
  const timeBaseBytes = version >= 0x102 ? 16 : 0;
  const headerLength = 32 + 8 + thumbnail.length + 13 + driverBytes.length + timeBaseBytes + headerPadding;
  const header = Buffer.alloc(headerLength);

  header.writeBigUInt64LE(0x434F4452n, 0);
  header.writeUInt32LE(version, 8);
  header.writeUInt32LE(headerLength, 12);

  const progVersionBytes = Buffer.alloc(16);
  Buffer.from(progVersion, 'ascii').copy(progVersionBytes, 0, 0, 16);
  progVersionBytes.copy(header, 16);

  header.writeUInt16LE(thumbnail.length > 0 ? 64 : 0, 32);
  header.writeUInt16LE(thumbnail.length > 0 ? 64 : 0, 34);
  header.writeUInt32LE(thumbnail.length, 36);
  thumbnail.copy(header, 40);

  const metaOffset = 40 + thumbnail.length;
  header.writeBigUInt64LE(machineIdent, metaOffset + 0);
  header.writeUInt32LE(driverId, metaOffset + 8);
  header.writeUInt8(invalidDriverNameLength ?? driverBytes.length, metaOffset + 12);
  driverBytes.copy(header, metaOffset + 13);

  if (version >= 0x102) {
    const timeOffset = metaOffset + 13 + driverBytes.length;
    header.writeBigUInt64LE(timeBase, timeOffset + 0);
    header.writeDoubleLE(timeFreq, timeOffset + 8);
  }

  return header;
}

function makeBinarySection(sectionType, sectionName, data, version = 1, flags = 0) {
  const nameBytes = Buffer.from(sectionName + '\0', 'utf8');
  const header = Buffer.alloc(40 + nameBytes.length);
  header.writeUInt8(0, 0);
  header.writeUInt32LE(sectionType, 4);
  header.writeBigUInt64LE(BigInt(data.length), 8);
  header.writeBigUInt64LE(BigInt(data.length), 16);
  header.writeBigUInt64LE(BigInt(version), 24);
  header.writeUInt32LE(flags, 32);
  header.writeUInt32LE(nameBytes.length, 36);
  nameBytes.copy(header, 40);
  return Buffer.concat([header, data]);
}

function makeAsciiSection(sectionType, sectionName, data, version = 0) {
  const prefix = Buffer.from(`A\n${data.length}\n${sectionType}\n${version}\n${sectionName}\n`, 'utf8');
  return Buffer.concat([prefix, data]);
}

function makeExtendedThumbnail(width, height, format, data) {
  const payload = Buffer.alloc(12 + data.length);
  payload.writeUInt16LE(width, 0);
  payload.writeUInt16LE(height, 2);
  payload.writeUInt32LE(data.length, 4);
  payload.writeUInt32LE(format, 8);
  data.copy(payload, 12);
  return payload;
}

function writeCapture(fileName, parts) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rdc-parser-test-'));
  const filePath = path.join(tempDir, fileName);
  fs.writeFileSync(filePath, Buffer.concat(parts));
  return { tempDir, filePath };
}

async function writeAndParse(parseRdcFile, fileName, parts) {
  const { tempDir, filePath } = writeCapture(fileName, parts);
  const parsed = await parseRdcFile(filePath);
  return { parsed, tempDir, filePath };
}

async function expectParseFailure(parseRdcFile, fileName, parts, pattern) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rdc-parser-test-'));
  const filePath = path.join(tempDir, fileName);
  fs.writeFileSync(filePath, Buffer.concat(parts));
  await assert.rejects(() => parseRdcFile(filePath), pattern);
}

async function run() {
  const { parseRdcFile, parseRdcThumbnail } = buildParserBundle();

  {
    const { parsed } = await writeAndParse(parseRdcFile, 'valid.rdc', [
      makeHeader({ headerPadding: 12 }),
      makeBinarySection(1, 'FrameCapture', Buffer.from([1, 2, 3, 4]), 7, 0),
      makeBinarySection(4, 'Notes', Buffer.from('hello', 'utf8'), 2, 0x2),
      makeAsciiSection(3, 'Bookmarks', Buffer.from('marks', 'utf8'), 11),
    ]);

    assert.equal(parsed.api, 'OpenGL ES');
    assert.equal(parsed.driver, 'OpenGL ES Driver');
    assert.equal(parsed.rdocVersion, 'v1.43 286e07');
    assert.equal(parsed.timestamp, '987654321');
    assert.equal(parsed.sectionCount, 3);
    assert.deepEqual(
      parsed.sections.map((section) => ({ name: section.name, type: section.type, flags: section.flags, size: section.size, version: section.version })),
      [
        { name: 'FrameCapture', type: 'FrameCapture', flags: 'None', size: 4, version: 7 },
        { name: 'Notes', type: 'Notes', flags: 'LZ4', size: 5, version: 2 },
        { name: 'Bookmarks', type: 'Bookmarks', flags: 'ASCII', size: 5, version: 11 },
      ],
    );
  }

  {
    const primaryThumbnail = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const { filePath } = writeCapture('primary-thumbnail.rdc', [
      makeHeader({ thumbnail: primaryThumbnail }),
      makeBinarySection(1, 'FrameCapture', Buffer.from([1, 2, 3]), 1, 0),
    ]);

    const thumbnail = await parseRdcThumbnail(filePath);
    assert.deepEqual(thumbnail, {
      width: 64,
      height: 64,
      base64: primaryThumbnail.toString('base64'),
      format: 'jpg',
    });
  }

  {
    const primaryThumbnail = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const extendedThumbnail = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const { filePath } = writeCapture('extended-thumbnail.rdc', [
      makeHeader({ thumbnail: primaryThumbnail }),
      makeBinarySection(1, 'FrameCapture', Buffer.from([1, 2, 3]), 1, 0),
      makeBinarySection(7, 'ExtendedThumbnail', makeExtendedThumbnail(128, 96, 1, extendedThumbnail), 1, 0),
    ]);

    const thumbnail = await parseRdcThumbnail(filePath);
    assert.deepEqual(thumbnail, {
      width: 128,
      height: 96,
      base64: extendedThumbnail.toString('base64'),
      format: 'png',
    });
  }

  {
    const { filePath } = writeCapture('compressed-extended-thumbnail.rdc', [
      makeHeader({ thumbnail: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) }),
      makeBinarySection(1, 'FrameCapture', Buffer.from([1, 2, 3]), 1, 0),
      makeBinarySection(7, 'ExtendedThumbnail', makeExtendedThumbnail(128, 96, 1, Buffer.from([0x89, 0x50, 0x4e, 0x47])), 1, 0x2),
    ]);

    const thumbnail = await parseRdcThumbnail(filePath);
    assert.equal(thumbnail, null);
  }

  await expectParseFailure(
    parseRdcFile,
    'invalid-magic.rdc',
    [Buffer.from('NOPE')],
    /Not a valid RDC file|truncated/i,
  );

  await expectParseFailure(
    parseRdcFile,
    'missing-framecapture.rdc',
    [
      makeHeader(),
      makeBinarySection(4, 'Notes', Buffer.from('hello', 'utf8'), 2, 0),
    ],
    /FrameCapture as the first section/i,
  );

  await expectParseFailure(
    parseRdcFile,
    'invalid-driver-name-length.rdc',
    [
      makeHeader({ invalidDriverNameLength: 0 }),
      makeBinarySection(1, 'FrameCapture', Buffer.from([1]), 1, 0),
    ],
    /Driver name length is invalid/i,
  );

  await expectParseFailure(
    parseRdcFile,
    'invalid-version.rdc',
    [
      makeHeader({ version: 0x103 }),
      makeBinarySection(1, 'FrameCapture', Buffer.from([1]), 1, 0),
    ],
    /Unsupported RDC version/i,
  );

  console.log('rdcParser tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  try {
    fs.unlinkSync(bundlePath);
  } catch {}
});