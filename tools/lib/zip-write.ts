// A ZIP writer for stable archives: fixed 1980-01-01 time, regular files with mode 0644, deflate, no zip64.
// The layout is the one Python's zipfile writes, field by field.
import { deflateRawSync } from 'node:zlib';
import { crc32 } from './zip-read.mjs';

export interface ZipEntry { name: string; data: Buffer }

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_DIRECTORY = 0x06054b50;
const VERSION = 20;
const UNIX = 3;
const DEFLATE = 8;
const UTF8_NAME = 0x800;
const DOS_DATE_1980_01_01 = 0x21;
const REGULAR_FILE_0644 = (0o100644 << 16) >>> 0;

interface Stored { name: Buffer; flags: number; crc: number; packedSize: number; size: number; offset: number }

function commonFields(entry: Stored): Buffer {
  const fields = Buffer.alloc(24);
  fields.writeUInt16LE(entry.flags, 0);
  fields.writeUInt16LE(DEFLATE, 2);
  fields.writeUInt16LE(0, 4);
  fields.writeUInt16LE(DOS_DATE_1980_01_01, 6);
  fields.writeUInt32LE(entry.crc, 8);
  fields.writeUInt32LE(entry.packedSize, 12);
  fields.writeUInt32LE(entry.size, 16);
  fields.writeUInt16LE(entry.name.length, 20);
  return fields;
}

function localHeader(entry: Stored): Buffer {
  const start = Buffer.alloc(6);
  start.writeUInt32LE(LOCAL_HEADER, 0);
  start.writeUInt16LE(VERSION, 4);
  return Buffer.concat([start, commonFields(entry), entry.name]);
}

function centralHeader(entry: Stored): Buffer {
  const start = Buffer.alloc(8);
  start.writeUInt32LE(CENTRAL_HEADER, 0);
  start.writeUInt8(VERSION, 4);
  start.writeUInt8(UNIX, 5);
  start.writeUInt16LE(VERSION, 6);
  const end = Buffer.alloc(14);
  end.writeUInt32LE(REGULAR_FILE_0644, 6);
  end.writeUInt32LE(entry.offset, 10);
  return Buffer.concat([start, commonFields(entry), end, entry.name]);
}

function endOfDirectory(count: number, size: number, offset: number): Buffer {
  const record = Buffer.alloc(22);
  record.writeUInt32LE(END_OF_DIRECTORY, 0);
  record.writeUInt16LE(count, 8);
  record.writeUInt16LE(count, 10);
  record.writeUInt32LE(size, 12);
  record.writeUInt32LE(offset, 16);
  return record;
}

export function zipArchive(entries: ZipEntry[]): Buffer {
  const parts: Buffer[] = [];
  const stored: Stored[] = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const packed = deflateRawSync(data);
    const ascii = /^[\x00-\x7f]*$/.test(name);
    const entry = { name: Buffer.from(name), flags: ascii ? 0 : UTF8_NAME, crc: crc32(data), packedSize: packed.length, size: data.length, offset };
    const header = localHeader(entry);
    parts.push(header, packed);
    stored.push(entry);
    offset += header.length + packed.length;
  }
  const directory = Buffer.concat(stored.map(centralHeader));
  return Buffer.concat([...parts, directory, endOfDirectory(stored.length, directory.length, offset)]);
}
