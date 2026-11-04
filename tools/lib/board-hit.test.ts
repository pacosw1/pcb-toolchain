import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copperContains, fromMm, normalize180, padHit, polygonCollides, polygonContains, polygonNear, polygonNearSegment, polygonsOverlap, ringContains, rotated, trackHit, viaHit } from './board-hit.ts';
import type { Pad, PadCopper, Polygon, Pt, Track, Via } from './board-types.ts';

const pt = (x: number, y: number): Pt => ({ x, y });
const square = (x: number, y: number, side: number): Pt[] => [pt(x, y), pt(x + side, y), pt(x + side, y + side), pt(x, y + side)];
const ofRing = (outline: Pt[]): Polygon => ({ outline, holes: [] });

const pad = (fields: Partial<Pad>): Pad => ({
  id: 'p', number: '1', kind: 'Smd', shape: 'Rect', net: 'N', position: pt(0, 0), orientation: 0, size: pt(100, 100), drill: pt(0, 0),
  layers: ['F.Cu'], bbox: { left: 0, top: 0, right: 0, bottom: 0 }, zone_connection: null, thermal_spoke_angle: 0, spoke_templates: 0,
  copper: [], polygons: {}, solder_mask_expansion: 0, ...fields,
});
const track = (fields: Partial<Track>): Track => ({ id: 't', start: pt(0, 0), end: pt(1000, 0), mid: null, width: 100, layer: 'F.Cu', net: 'N', locked: false, ...fields });
const via: Via = { id: 'v', at: pt(0, 0), size: 601, drill: 300, net: 'N', locked: false };

test('FromMM cuts toward zero', () => {
  assert.equal(fromMm(1.0000009), 1_000_000);
  assert.equal(fromMm(-1.0000009), -1_000_000);
  assert.equal(fromMm(0.1 + 0.2), 300_000);
});

test('quarter turns are exact, as RotatePoint', () => {
  assert.deepEqual(rotated(pt(3, 1), 90), pt(1, -3));
  assert.deepEqual(rotated(pt(3, 1), -90), pt(-1, 3));
  assert.deepEqual(rotated(pt(3, 1), 180), pt(-3, -1));
  assert.deepEqual(rotated(pt(3, 1), 450), pt(1, -3));
  assert.deepEqual(rotated(pt(1000, 0), 45), pt(707, -707));
});

test('orientations read as pcbnew gives them', () => {
  assert.equal(normalize180(270), -90);
  assert.equal(normalize180(180), 180);
  assert.equal(normalize180(-180), 180);
  assert.equal(normalize180(0), 0);
});

test('contains follows KiCad edges', () => {
  const s = ofRing(square(0, 0, 10));
  assert.ok(polygonContains(s, pt(5, 5)));
  assert.ok(polygonContains(s, pt(0, 5)));
  assert.ok(!polygonContains(s, pt(10, 5)));
  assert.ok(!polygonContains(s, pt(11, 5)));
});

test('a ring of fewer than three points holds nothing', () => {
  assert.ok(!ringContains([pt(0, 0), pt(9, 9)], pt(1, 1)));
});

test('contains stays exact when the product passes 2^53', () => {
  // The edge (0, 0)-(big, big - 1) at y = big - 2 crosses x = big - 2 + (big - 2) / (big - 1), which rounds to big - 1. In doubles
  // the product (big - 2) * big loses its low bits; the test point on either side of the crossing tells them apart.
  const big = 400_000_001;
  const triangle = [pt(0, 0), pt(big, big - 1), pt(0, big - 1)];
  assert.ok(big * (big - 2) > Number.MAX_SAFE_INTEGER);
  assert.ok(ringContains(triangle, pt(big - 2, big - 2)));
  assert.ok(!ringContains(triangle, pt(big - 1, big - 2)));
  assert.ok(ringContains(square(0, 0, big), pt(big - 1, big - 1)));
});

test('a point in a hole is outside', () => {
  const p: Polygon = { outline: square(0, 0, 10), holes: [square(4, 4, 2)] };
  assert.ok(!polygonContains(p, pt(5, 5)));
  assert.ok(polygonContains(p, pt(2, 5)));
});

test('near is strict at the clearance', () => {
  const s = ofRing(square(0, 0, 10));
  assert.ok(polygonNear(s, pt(5, 5), 0));
  assert.ok(polygonNear(s, pt(13, 5), 4));
  assert.ok(!polygonNear(s, pt(13, 5), 3));
});

test('a segment collides by its half width', () => {
  const s = ofRing(square(0, 0, 10));
  const segment = (a: Pt, b: Pt, width: number): PadCopper => ({ Segment: { a, b, width } });
  assert.ok(polygonCollides(s, segment(pt(13, 0), pt(13, 9), 8)));
  assert.ok(!polygonCollides(s, segment(pt(13, 0), pt(13, 9), 6)));
  assert.ok(polygonCollides(s, segment(pt(-5, 5), pt(15, 5), 0)));
  assert.ok(polygonNearSegment(s, pt(2, 2), pt(3, 3), 0));
});

test('polygons overlap when they cross or nest', () => {
  const s = ofRing(square(0, 0, 10));
  assert.ok(polygonsOverlap(s, ofRing(square(5, 5, 10))));
  assert.ok(polygonsOverlap(s, ofRing(square(2, 2, 2))));
  assert.ok(polygonsOverlap(ofRing(square(2, 2, 2)), s));
  assert.ok(!polygonsOverlap(s, ofRing(square(20, 20, 2))));
});

test('copper in a hole does not collide', () => {
  const p: Polygon = { outline: square(0, 0, 100), holes: [square(40, 40, 20)] };
  assert.ok(!polygonCollides(p, { Circle: { center: pt(50, 50), radius: 5 } }));
  assert.ok(polygonCollides(p, { Circle: { center: pt(50, 50), radius: 11 } }));
});

test('a point on copper is inside it', () => {
  assert.ok(copperContains({ Circle: { center: pt(0, 0), radius: 5 } }, pt(3, 4)));
  assert.ok(!copperContains({ Segment: { a: pt(0, 0), b: pt(10, 0), width: 2 } }, pt(5, 2)));
  assert.ok(copperContains({ Segment: { a: pt(0, 0), b: pt(10, 0), width: 2 } }, pt(5, 2), 1));
});

test('a track hits within half its width plus the accuracy, whole nanometres', () => {
  const t = track({ width: 101 });
  assert.ok(trackHit(t, pt(500, 50)));
  assert.ok(!trackHit(t, pt(500, 51)));
  assert.ok(trackHit(t, pt(500, 51), 1));
  assert.ok(trackHit(t, pt(-30, 40)));
  assert.ok(!trackHit(t, pt(-40, 40)));
});

test('an arc hits along its curve, not its chord', () => {
  const arc = track({ start: pt(-1000, 0), mid: pt(0, -1000), end: pt(1000, 0), width: 100 });
  assert.ok(trackHit(arc, pt(0, -1000)));
  assert.ok(trackHit(arc, pt(707, -707)));
  assert.ok(!trackHit(arc, pt(0, 0)));
  assert.ok(!trackHit(arc, pt(0, 1000)));
  const reversed = track({ start: pt(1000, 0), mid: pt(0, -1000), end: pt(-1000, 0), width: 100 });
  assert.ok(trackHit(reversed, pt(-707, -707)));
  assert.ok(!trackHit(reversed, pt(0, 1000)));
});

test('a via hits within half its size plus the accuracy', () => {
  assert.ok(viaHit(via, pt(300, 0)));
  assert.ok(!viaHit(via, pt(301, 0)));
  assert.ok(viaHit(via, pt(301, 0), 1));
});

test('a pad hits through its polygon, accuracy reaching one past the outline', () => {
  const p = pad({ polygons: { 'F.Cu': ofRing(square(-50, -50, 100)) } });
  assert.ok(padHit(p, pt(0, 0)));
  assert.ok(!padHit(p, pt(51, 0)));
  assert.ok(padHit(p, pt(100, 0), 49));
  assert.ok(!padHit(p, pt(101, 0), 49));
});

test('an accuracy of one is no margin', () => {
  const p = pad({ polygons: { 'F.Cu': ofRing(square(-50, -50, 100)) } });
  assert.ok(!padHit(p, pt(51, 0), 1));
});

test('the hole of a pad counts, beyond its copper', () => {
  const p = pad({ drill: pt(400, 400), polygons: { 'F.Cu': ofRing(square(-50, -50, 100)) } });
  assert.ok(padHit(p, pt(199, 0)));
  assert.ok(!padHit(p, pt(200, 0)));
});

test('a slot lies along the longer side, turned with the pad', () => {
  const slot = pad({ drill: pt(100, 500), polygons: { 'F.Cu': ofRing(square(-5, -5, 10)) } });
  assert.ok(padHit(slot, pt(0, 240)));
  assert.ok(!padHit(slot, pt(240, 0)));
  const turned = pad({ drill: pt(100, 500), orientation: 90, polygons: { 'F.Cu': ofRing(square(-5, -5, 10)) } });
  assert.ok(padHit(turned, pt(240, 0)));
  assert.ok(!padHit(turned, pt(0, 240)));
});

test('a pad with no polygons in the document hits through its copper', () => {
  const p = pad({ copper: [{ Circle: { center: pt(0, 0), radius: 50 } }] });
  assert.ok(padHit(p, pt(50, 0)));
  assert.ok(!padHit(p, pt(51, 0)));
  assert.ok(padHit(p, pt(60, 0), 10));
});
