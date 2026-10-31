/**
 * Minimal, dependency-free zip reader for the pinned Godot web editor
 * archive.
 *
 * Only what the download script needs is supported: stored (0) and deflated
 * (8) entries, no encryption, no zip64. Entries are read from the central
 * directory — local headers are only used to locate the payload — because
 * the central directory is the authoritative source for sizes.
 *
 * Every entry name is validated before anything is written, so a malicious
 * archive cannot escape `destDir` through `..` or absolute paths.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_SIZE = 22;
const MAX_COMMENT_LENGTH = 0xffff;
const ZIP64_MARKER = 0xffffffff;

function fail(message) {
  throw new Error(`unzip: ${message}`);
}

function findEndOfCentralDirectory(buffer) {
  const earliest = Math.max(0, buffer.length - EOCD_SIZE - MAX_COMMENT_LENGTH);
  // Archives may carry a comment, so scan backwards — but only accept a
  // candidate whose declared comment ends exactly at the end of the buffer.
  // Trailing bytes that merely contain the signature must not win.
  for (let offset = buffer.length - EOCD_SIZE; offset >= earliest; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== EOCD_SIGNATURE) {
      continue;
    }
    const commentLength = buffer.readUInt16LE(offset + 20);
    if (offset + EOCD_SIZE + commentLength === buffer.length) {
      return offset;
    }
  }
  fail('end of central directory not found (not a zip archive?)');
}

/**
 * Turns an archive entry name into a safe, relative, posix-style path.
 * Rejects absolute paths, drive letters and any `..` segment.
 */
function safeEntryPath(rawName) {
  const name = rawName.replace(/\\/g, '/');
  if (!name) {
    fail('entry with an empty name');
  }
  if (path.posix.isAbsolute(name) || /^[a-zA-Z]:/.test(name)) {
    fail(`absolute entry path rejected: ${rawName}`);
  }
  const normalized = path.posix.normalize(name);
  if (path.posix.isAbsolute(normalized)) {
    fail(`absolute entry path rejected: ${rawName}`);
  }
  if (normalized === '.' || normalized === '') {
    fail(`entry path resolves to the destination directory: ${rawName}`);
  }
  if (normalized.split('/').includes('..')) {
    fail(`parent traversal in entry path rejected: ${rawName}`);
  }
  return normalized;
}

function readCentralDirectory(buffer) {
  const eocd = findEndOfCentralDirectory(buffer);
  const entries = buffer.readUInt16LE(eocd + 10);
  const size = buffer.readUInt32LE(eocd + 12);
  const offset = buffer.readUInt32LE(eocd + 16);

  if (offset === ZIP64_MARKER || size === ZIP64_MARKER) {
    fail('zip64 archives are not supported');
  }
  if (offset + size > buffer.length) {
    fail('central directory points outside the archive');
  }

  const entriesList = [];
  let cursor = offset;
  for (let index = 0; index < entries; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      fail(`corrupt central directory at entry ${index}`);
    }

    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const nameEnd = cursor + 46 + nameLength;
    if (nameEnd > buffer.length) {
      fail(`corrupt central directory name at entry ${index}`);
    }

    const rawName = buffer.subarray(cursor + 46, nameEnd).toString('utf8');
    cursor = nameEnd + extraLength + commentLength;

    if (flags & 0x0001) {
      fail(`encrypted entry is not supported: ${rawName}`);
    }
    if (compressedSize === ZIP64_MARKER || uncompressedSize === ZIP64_MARKER) {
      fail(`zip64 entry is not supported: ${rawName}`);
    }

    entriesList.push({
      rawName,
      name: safeEntryPath(rawName),
      isDirectory: /[\\/]$/.test(rawName),
      method,
      compressedSize,
      uncompressedSize,
      localOffset,
    });
  }

  return entriesList;
}

function readEntryData(buffer, entry) {
  const header = entry.localOffset;
  if (header + 30 > buffer.length || buffer.readUInt32LE(header) !== LOCAL_SIGNATURE) {
    fail(`corrupt local header for ${entry.rawName}`);
  }

  const localNameLength = buffer.readUInt16LE(header + 26);
  const localExtraLength = buffer.readUInt16LE(header + 28);
  const dataStart = header + 30 + localNameLength + localExtraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > buffer.length) {
    fail(`entry data points outside the archive: ${entry.rawName}`);
  }

  const compressed = buffer.subarray(dataStart, dataEnd);
  let data;
  if (entry.method === 0) {
    data = Buffer.from(compressed);
  } else if (entry.method === 8) {
    data = inflateRawSync(compressed);
  } else {
    fail(`unsupported compression method ${entry.method} for ${entry.rawName}`);
  }

  if (data.length !== entry.uncompressedSize) {
    fail(`size mismatch for ${entry.rawName}: expected ${entry.uncompressedSize}, got ${data.length}`);
  }
  return data;
}

/**
 * Extracts every file in `buffer` under `destDir`.
 *
 * @param {Buffer} buffer zip archive bytes
 * @param {string} destDir destination directory (created if needed)
 * @returns {string[]} relative paths of the files written
 */
export function extractZip(buffer, destDir) {
  if (!Buffer.isBuffer(buffer)) {
    fail('expected a Buffer');
  }
  if (buffer.length < EOCD_SIZE) {
    fail('archive is too small to be a zip');
  }

  // Parse and validate everything first: a rejected entry must not leave
  // partially written files behind.
  const entries = readCentralDirectory(buffer);

  const written = [];
  for (const entry of entries) {
    if (entry.isDirectory) {
      mkdirSync(path.join(destDir, entry.name), { recursive: true });
      continue;
    }

    const data = readEntryData(buffer, entry);
    const target = path.join(destDir, entry.name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, data);
    written.push(entry.name);
  }

  return written;
}
