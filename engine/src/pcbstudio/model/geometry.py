"""Board geometry as kicad/board.py emits it today (agent B owns that module and may change it: update these models
in the same change, then `npm run types:gen`). board.geometry still returns the parser dict; these models type it."""
from __future__ import annotations

from .base import Model

Pt = tuple[float, float]


class Pad(Model):
    num: str
    type: str
    shape: str
    x: float
    y: float
    rot: float
    w: float
    h: float
    layers: list[str]
    net: str
    drill: float | None
    rratio: float


class Footprint(Model):
    ref: str
    lib: str
    x: float
    y: float
    rot: float
    layer: str
    locked: bool
    props: dict[str, str]
    attrs: list[str]
    pads: list[Pad]


class Track(Model):
    x1: float
    y1: float
    x2: float
    y2: float
    w: float
    layer: str
    net: str


class Via(Model):
    x: float
    y: float
    d: float
    drill: float
    layers: list[str]
    net: str


class ZoneFill(Model):
    layer: str
    pts: list[Pt]


class Zone(Model):
    net: str
    name: str
    layers: list[str]
    rule_area: bool
    outline: list[Pt]
    filled: list[ZoneFill]


class Geometry(Model):
    pcb: str
    layers: list[str]
    outline: list[list[Pt]]
    footprints: list[Footprint]
    tracks: list[Track]
    vias: list[Via]
    zones: list[Zone]
    bbox: tuple[float, float, float, float]


class GlbResult(Model):
    path: str
    cached: bool
    size: int
    warnings: list[str] = []
