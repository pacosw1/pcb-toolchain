"""Part, datasheet and BOM shapes."""
from __future__ import annotations

from typing import Literal

from pydantic import Field

from .base import Model

DatasheetSource = Literal['filename', 'source_json', 'cad_manifest', 'components_json', 'bom_csv']


class DatasheetRef(Model):
    """A datasheet PDF in the project (project-relative, exists) with its measured sha256."""
    path: str
    sha256: str
    recorded_sha256: str | None = None   # the sha256 a source file states (source.json, manifest, BOM CSV)
    sources: list[DatasheetSource]


class PartRecord(Model):
    c_number: str
    mpn: str | None = None
    manufacturer: str | None = None
    datasheet: DatasheetRef | None = None          # the preferred one (sources in DatasheetSource order)
    datasheets: list[DatasheetRef] = Field(default_factory=list)
    cad_asset: str | None = None                   # project-relative registry/cad-assets/<C>/ folder
    evidence: list[str] = Field(default_factory=list)  # project-relative catalog snapshots that exist


class PartsIndexStats(Model):
    path: str                      # SQLite file (cache dir, not in the project)
    fingerprint: str
    rebuilt: bool                  # False = inputs unchanged, the stored index was used
    pdfs: int                      # PDFs in the datasheets folder
    pdfs_c_in_name: int            # PDFs the `_C####.pdf` name rule maps (the old lookup)
    pdfs_mapped: int               # PDFs any source maps to a C-number
    c_numbers: int                 # C-numbers with at least one datasheet
    by_source: dict[str, int]      # C-numbers first resolved by each source
    missing_paths: int             # datasheet paths a source names that do not exist (ignored)
    hash_mismatches: int           # recorded sha256 != measured


class BomSource(Model):
    """The evidence CSV joined to a BOM (the revision's `bom`), after column normalisation."""
    path: str
    rows: int
    columns: list[str]             # normalised names found
    unknown_columns: list[str]     # original headers with no normalised meaning (kept out of the join)
    header_only: bool


class BomLine(Model):
    refs: list[str]
    qty: int
    value: str
    lcsc: str | None               # the PCB footprint C-number (pcb_lcsc)
    mpn: str | None
    manufacturer: str | None
    footprint: str
    description: str | None
    dnp: bool
    assembly: Literal['smd', 'tht', 'other']
    datasheet: str | None
    datasheet_sha256: str | None = None
    datasheet_url: str | None
    cad_asset: bool
    stock_status: str | None
    assembly_status: str | None
    csv_lcsc: str | None = None    # the C-number the BOM CSV states for these refs (first differing one if mixed)
    lcsc_mismatch_refs: list[str] = Field(default_factory=list)  # refs whose CSV C-number != PCB C-number
    csv_missing_refs: list[str] = Field(default_factory=list)    # refs the CSV does not list (CSV present only)


class BomSummary(Model):
    refs: int
    lines: int
    dnp_refs: int
    missing_lcsc: int
    missing_datasheet: int
    missing_cad_asset: int
    lcsc_mismatches: int = 0       # refs, CSV vs PCB
    lines_with_mismatch: int = 0
    csv_missing_refs: int = 0
    csv_only_refs: int = 0         # CSV designators with no footprint on the PCB


class Bom(Model):
    pcb: str
    revision: str | None = None
    source: BomSource | None = None
    csv_only_refs: list[str] = Field(default_factory=list)
    lines: list[BomLine]
    summary: BomSummary


class PartPlacement(Model):
    ref: str
    value: str | None
    lcsc: str | None
    mpn: str | None
    x: float
    y: float
    rot: float
    layer: str
    pads: int
    dnp: bool


class BoardParts(Model):
    pcb: str
    bbox: tuple[float, float, float, float]
    tracks: int
    vias: int
    footprints: list[PartPlacement]
