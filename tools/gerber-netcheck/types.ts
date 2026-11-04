// The small JSON boundary between the Mac-side parser and the native polygon/connectivity engine.
export type Point = [number, number];
export type Geometry =
  | { kind: 'polygon'; points: Point[] }
  | { kind: 'region'; rings: Point[][] }
  | { kind: 'circle'; center: Point; radius: number; resolution?: number }
  | { kind: 'stroke'; points: Point[]; width: number; resolution?: number }
  | { kind: 'union'; items: Geometry[] }
  | { kind: 'difference' | 'intersection'; a: Geometry; b: Geometry }
  | { kind: 'translate'; offset: Point; geometry: Geometry };

export interface Draw { dark: boolean; geometry: Geometry }
export interface Layer { name: string; operations: Draw[] }
export interface Hole { start: Point; end: Point; diameter: number }
export interface Pad { ref: string; pin: string; x: number; y: number; layers: string[]; net: string | null }
export interface CheckInput { layers: Layer[]; holes: Hole[]; pads: Pad[] }
export interface Report {
  layers: { name: string; pieces: number }[];
  pads: number; holes: number; nets: number; nets_checked: number;
  opens: Record<string, string[][]>;
  shorts: Record<string, string[]>[];
  missing: string[];
}
