export function crc32(data: Buffer): number;
export interface ZipEntryInfo { filename: string }
export interface ZipFile { entries: ZipEntryInfo[]; byName: Map<string, ZipEntryInfo> }
export function openZip(data: Buffer): ZipFile;
export function readEntry(zip: ZipFile, entry: ZipEntryInfo): Buffer;
