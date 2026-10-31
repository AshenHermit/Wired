import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { deflateRawSync } from 'node:zlib';

import { extractZip } from './unzip.mjs';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function localHeader(entry) {
  const name = Buffer.from(entry.name, 'utf8');
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt16LE(entry.method, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt32LE(entry.crc, 14);
  header.writeUInt32LE(entry.data.length, 18);
  header.writeUInt32LE(entry.uncompressed.length, 22);
  header.writeUInt16LE(name.length, 26);
  header.writeUInt16LE(0, 28);
  return Buffer.concat([header, name, entry.data]);
}

function centralHeader(entry, offset) {
  const name = Buffer.from(entry.name, 'utf8');
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(entry.method, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt16LE(0, 14);
  header.writeUInt32LE(entry.crc, 16);
  header.writeUInt32LE(entry.data.length, 20);
  header.writeUInt32LE(entry.uncompressed.length, 24);
  header.writeUInt16LE(name.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(0, 38);
  header.writeUInt32LE(offset, 42);
  return Buffer.concat([header, name]);
}

/**
 * Builds an uncompressed-archive-format (zip) buffer containing the given
 * entries. `method` is 0 (stored) unless the entry asks for 8 (deflated).
 *
 * The CRC always covers the original bytes: deflating happens after the
 * checksum is computed, as the zip format requires.
 */
function makeZip(entries) {
  const prepared = entries.map((entry) => {
    const uncompressed = Buffer.isBuffer(entry.data)
      ? entry.data
      : Buffer.from(entry.data ?? '', 'utf8');
    const method = entry.method ?? 0;
    return {
      name: entry.name,
      method,
      uncompressed,
      crc: crc32(uncompressed),
      data: method === 8 ? deflateRawSync(uncompressed) : uncompressed,
    };
  });

  const parts = [];
  const central = [];
  let offset = 0;
  for (const entry of prepared) {
    const local = localHeader(entry);
    parts.push(local);
    central.push(centralHeader(entry, offset));
    offset += local.length;
  }

  const centralBuffer = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(prepared.length, 8);
  eocd.writeUInt16LE(prepared.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...parts, centralBuffer, eocd]);
}

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), 'wired-unzip-'));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('extracts stored entries and creates nested directories', () => {
  withTempDir((dest) => {
    const zip = makeZip([
      { name: 'godot.editor.html', data: '<html></html>' },
      { name: 'nested/deep/file.txt', data: 'hello' },
    ]);

    const written = extractZip(zip, dest);

    assert.deepEqual(written.sort(), ['godot.editor.html', 'nested/deep/file.txt']);
    assert.equal(readFileSync(join(dest, 'godot.editor.html'), 'utf8'), '<html></html>');
    assert.equal(readFileSync(join(dest, 'nested', 'deep', 'file.txt'), 'utf8'), 'hello');
  });
});

test('extracts deflated entries', () => {
  withTempDir((dest) => {
    const payload = 'deflated '.repeat(200);
    const zip = makeZip([{ name: 'godot.editor.js', data: payload, method: 8 }]);

    const written = extractZip(zip, dest);

    assert.deepEqual(written, ['godot.editor.js']);
    assert.equal(readFileSync(join(dest, 'godot.editor.js'), 'utf8'), payload);
  });
});

test('rejects parent traversal', () => {
  withTempDir((dest) => {
    const zip = makeZip([{ name: '../evil.txt', data: 'pwned' }]);

    assert.throws(() => extractZip(zip, dest), /\.\./);
    assert.equal(existsSync(join(dest, '..', 'evil.txt')), false);
  });
});

test('rejects absolute paths', () => {
  withTempDir((dest) => {
    const zip = makeZip([{ name: '/etc/passwd', data: 'pwned' }]);

    assert.throws(() => extractZip(zip, dest), /absolute/i);
    assert.equal(existsSync(join(dest, 'etc', 'passwd')), false);
  });
});

test('ignores directory entries', () => {
  withTempDir((dest) => {
    const zip = makeZip([{ name: 'dir/', data: '' }]);

    const written = extractZip(zip, dest);

    assert.deepEqual(written, []);
    assert.equal(statSync(join(dest, 'dir')).isDirectory(), true);
    assert.equal(existsSync(join(dest, 'dir', 'dir')), false);
  });
});

test('ignores a fake end-of-central-directory signature in a comment', () => {
  withTempDir((dest) => {
    const base = makeZip([{ name: 'godot.editor.html', data: '<html></html>' }]);

    // Real archives may carry a comment. Append 22 bytes that start with the
    // EOCD signature, so a naive backwards scan stops on the comment instead
    // of the actual record.
    const comment = Buffer.alloc(22, 0xaa);
    comment.writeUInt32LE(0x06054b50, 0);
    base.writeUInt16LE(comment.length, base.length - 22 + 20);

    const written = extractZip(Buffer.concat([base, comment]), dest);

    assert.deepEqual(written, ['godot.editor.html']);
    assert.equal(readFileSync(join(dest, 'godot.editor.html'), 'utf8'), '<html></html>');
  });
});
