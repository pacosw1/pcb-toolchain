// Types of xml-read.mjs.
export interface XmlElement { tag: string; attributes: Map<string, string>; text: string; children: XmlElement[] }
export function parseXml(text: string): XmlElement;
export function iter(element: XmlElement, tag: string): Generator<XmlElement>;
export function findText(element: XmlElement, tag: string): string | null;
