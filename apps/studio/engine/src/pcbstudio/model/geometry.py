"""Board geometry as kicad/board.py emits it today (agent B owns that module and may change it: update these models
in the same change, then `npm run types:gen`). board.geometry still returns the parser dict; these models type it."""
from __future__ import annotations

from typing import Literal

from pydantic import Field

from .base import Model

Pt = tuple[float, float]

# A field the parser leaves out of some items (custom pads only): tsgen emits it as `name?: T`.
OPTIONAL = {'ts_optional': True}


class PadPrim(Model):
    """A custom-pad primitive in board coordinates."""
    pts: list[Pt]
    w: float
    fill: bool
    closed: bool


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
    drill_h: float | None = Field(description='Second drill dimension (= drill for a round hole).')
    drill_shape: Literal['circle', 'oval'] | None
    rratio: float
    anchor: str | None = Field(None, description='Custom pads only: anchor shape.', json_schema_extra=OPTIONAL)
    prims: list[PadPrim] | None = Field(None, description='Custom pads only: primitives (board coordinates).',
                                        json_schema_extra=OPTIONAL)


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


class ZoneAllow(Model):
    """Rule area: what may go inside."""
    tracks: bool
    vias: bool
    pads: bool
    copperpour: bool
    footprints: bool


class Zone(Model):
    net: str
    name: str
    layers: list[str]
    rule_area: bool
    keepout: bool = Field(description='Rule area that forbids at least one item.')
    allow: ZoneAllow | None = Field(description='Rule areas only: what may go inside.')
    outline: list[Pt] = Field(description='First outline polygon (= polygons[0]).')
    polygons: list[list[Pt]]
    filled: list[ZoneFill]


class Graphic(Model):
    """A silk or courtyard line/shape in board coordinates (ref '' = board graphic)."""
    layer: str
    ref: str
    pts: list[Pt]
    closed: bool
    w: float
    fill: bool


class Geometry(Model):
    pcb: str
    layers: list[str]
    outline: list[list[Pt]] = Field(description='Edge.Cuts chains; a closed loop has last point = first.')
    outline_open: int = Field(description='Chains that do not close (0 on a good board).')
    footprints: list[Footprint]
    tracks: list[Track]
    vias: list[Via]
    zones: list[Zone]
    graphics: list[Graphic] = Field(description='F/B silk and courtyard.')
    bbox: tuple[float, float, float, float]


class GlbResult(Model):
    path: str
    cached: bool
    size: int
    warnings: list[str] = []
