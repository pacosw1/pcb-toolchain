// Read a ZIP the way Python's zipfile does (same checks, same order, same messages), with plain Node.
// Only stored and deflated entries can be read: Node has no bzip2 or LZMA, so those fail closed.
import {constants, inflateRawSync} from 'node:zlib';
import {decode, pyRepr} from './py-compat.mjs';

export class BadZipFile extends Error {}

const CRC_TABLE = Array.from({length: 256}, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
export function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const CP437 = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩∪≡±≥≤⌠⌡°≈∙·√ⁿ²■ ';
const name = (bytes, flags) => flags & 0x800 ? decode(bytes) : Array.from(bytes, b => b < 128 ? String.fromCharCode(b) : CP437[b - 128]).join('');

const u64 = (data, at) => Number(data.readBigUInt64LE(at));
const signature = (data, at, text) => data.subarray(at, at + 4).equals(Buffer.from(text, 'latin1'));

function endRecord64(buf, offset, record) {
  offset -= 20;
  if (offset < 0) return record;
  const locator = buf.subarray(offset, offset + 20);
  if (!signature(locator, 0, 'PK\x06\x07')) return record;
  const reloff = u64(locator, 8);
  if (locator.readUInt32LE(4) !== 0 || locator.readUInt32LE(16) > 1) throw new BadZipFile('zipfiles that span multiple disks are not supported');
  offset -= 56;
  if (reloff > offset) throw new BadZipFile('Corrupt zip64 end of central directory locator');
  let extra = offset - reloff, data = buf.subarray(reloff, reloff + 56);
  if (data.length !== 56) throw new BadZipFile('File is not a zip file');
  if (!signature(data, 0, 'PK\x06\x06') && reloff !== offset) {
    extra = 0; data = buf.subarray(offset, offset + 56);
    if (data.length !== 56) throw new BadZipFile('File is not a zip file');
  }
  if (!signature(data, 0, 'PK\x06\x06')) throw new BadZipFile('Zip64 end of central directory record not found');
  const dirSize = u64(data, 40), dirOffset = u64(data, 48);
  if (dirOffset + dirSize !== reloff || u64(data, 4) + 12 !== 56 + extra) throw new BadZipFile('Corrupt zip64 end of central directory record');
  return {size: dirSize, offset: dirOffset, location: offset - extra};
}

function endRecord(buf) {
  const size = buf.length;
  if (size < 22) return null;
  const last = buf.subarray(size - 22);
  if (signature(last, 0, 'PK\x05\x06') && last[20] === 0 && last[21] === 0) {
    return endRecord64(buf, size - 22, {size: last.readUInt32LE(12), offset: last.readUInt32LE(16), location: size - 22});
  }
  const from = Math.max(size - 65536 - 22, 0), start = buf.subarray(from).lastIndexOf('PK\x05\x06', undefined, 'latin1');
  if (start < 0) return null;
  const record = buf.subarray(from + start, from + start + 22);
  if (record.length !== 22) return null;
  return endRecord64(buf, from + start, {size: record.readUInt32LE(12), offset: record.readUInt32LE(16), location: from + start});
}

function decodeExtra(entry, extra) {
  while (extra.length >= 4) {
    const type = extra.readUInt16LE(0), length = extra.readUInt16LE(2);
    if (length + 4 > extra.length) throw new BadZipFile(`Corrupt extra field ${type.toString(16).padStart(4, '0')} (size=${length})`);
    if (type === 1) {
      let data = extra.subarray(4, length + 4);
      const take = field => {
        if (data.length < 8) throw new BadZipFile(`Corrupt zip64 extra field. ${field} not found.`);
        const value = u64(data, 0);
        data = data.subarray(8);
        return value;
      };
      if (entry.fileSize === 0xffffffff) entry.fileSize = take('File size');
      if (entry.compressSize === 0xffffffff) entry.compressSize = take('Compress size');
      if (entry.headerOffset === 0xffffffff) entry.headerOffset = take('Header offset');
    }
    extra = extra.subarray(length + 4);
  }
}

// The entries of the central directory, in order. A bad archive throws what ZipFile(path) raises.
export function openZip(buf) {
  const record = endRecord(buf);
  if (!record) throw new BadZipFile('File is not a zip file');
  const concat = record.location - record.size - record.offset, start = record.offset + concat;
  if (start < 0) throw new BadZipFile('Bad offset for central directory');
  const directory = buf.subarray(start, start + record.size), entries = [], byName = new Map();
  for (let at = 0, total = 0; total < record.size;) {
    const head = directory.subarray(at, at + 46);
    if (head.length !== 46) throw new BadZipFile('Truncated central directory');
    if (!signature(head, 0, 'PK\x01\x02')) throw new BadZipFile('Bad magic number for central directory');
    const nameLength = head.readUInt16LE(28), extraLength = head.readUInt16LE(30), commentLength = head.readUInt16LE(32);
    const flags = head.readUInt16LE(8), original = name(directory.subarray(at + 46, at + 46 + nameLength), flags);
    const zero = original.indexOf('\0');
    const entry = {filename: zero >= 0 ? original.slice(0, zero) : original, original, flags, method: head.readUInt16LE(10),
      crc: head.readUInt32LE(16), compressSize: head.readUInt32LE(20), fileSize: head.readUInt32LE(24), headerOffset: head.readUInt32LE(42)};
    if (head[6] > 63) throw new Error(`zip file version ${(head[6] / 10).toFixed(1)}`);
    decodeExtra(entry, directory.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength));
    entry.headerOffset += concat;
    entries.push(entry);
    byName.set(entry.filename, entry);
    at += 46 + nameLength + extraLength + commentLength;
    total += 46 + nameLength + extraLength + commentLength;
  }
  let end = start;
  for (const entry of [...entries].sort((a, b) => b.headerOffset - a.headerOffset)) { entry.endOffset = end; end = entry.headerOffset; }
  return {buf, entries, byName};
}

function dataStart(zip, entry) {
  if (entry.headerOffset < 0) throw new Error('[Errno 22] Invalid argument');
  const head = zip.buf.subarray(entry.headerOffset, entry.headerOffset + 30);
  if (head.length !== 30) throw new BadZipFile('Truncated file header');
  if (!signature(head, 0, 'PK\x03\x04')) throw new BadZipFile('Bad magic number for file header');
  const nameAt = entry.headerOffset + 30, nameLength = head.readUInt16LE(26), start = nameAt + nameLength + head.readUInt16LE(28);
  if (entry.flags & 0x20) throw new Error('compressed patched data (flag bit 5)');
  if (entry.flags & 0x40) throw new Error('strong encryption (flag bit 6)');
  const local = name(zip.buf.subarray(nameAt, nameAt + nameLength), head.readUInt16LE(6));
  if (local !== entry.original) throw new BadZipFile(`File name in directory ${pyRepr(entry.original)} and header differ.`);
  if (start + entry.compressSize > entry.endOffset) throw new BadZipFile(`Overlapped entries: ${pyRepr(entry.original)} (possible zip bomb)`);
  if (entry.flags & 1) throw new Error(`File ${pyRepr(entry.filename)} is encrypted, password required for extraction`);
  return start;
}

// ZipFile.read(entry): the bytes, after the CRC check.
export function readEntry(zip, entry) {
  const start = dataStart(zip, entry);
  if (![0, 8, 12, 14].includes(entry.method)) throw new Error('That compression method is not supported');
  if (entry.method !== 0 && entry.method !== 8) throw new Error(`compression type ${entry.method} cannot be read without Python`);
  const input = zip.buf.subarray(start, Math.max(start, Math.min(start + entry.compressSize, zip.buf.length)));
  const shortFile = input.length < entry.compressSize;
  let data;
  if (entry.method === 0) {
    if (shortFile && input.length < entry.fileSize) throw new Error('');   // Python's EOFError has no text
    data = input;
  } else {
    let complete = true;
    try { data = inflateRawSync(input); } catch (error) {
      if (error.code === 'Z_DATA_ERROR') throw new Error(`Error -3 while decompressing data: ${error.message}`);
      if (error.code !== 'Z_BUF_ERROR') throw error;
      complete = false;
      data = inflateRawSync(input, {finishFlush: constants.Z_SYNC_FLUSH});
    }
    if (!complete && shortFile && data.length < entry.fileSize) throw new Error('');
  }
  data = data.subarray(0, entry.fileSize);
  if (crc32(data) !== entry.crc) throw new BadZipFile(`Bad CRC-32 for file ${pyRepr(entry.filename)}`);
  return data;
}

// ZipFile.testzip(): the first name that fails a read, else null. Only BadZipFile counts; other errors go up.
export function testZip(zip) {
  for (const entry of zip.entries) {
    try { readEntry(zip, zip.byName.get(entry.filename)); } catch (error) {
      if (error instanceof BadZipFile) return entry.filename;
      throw error;
    }
  }
  return null;
}
