"""Supplier directory loading and straight-line distance ranking (spec §5, §11).

The directory has only name, phone and address, so the engine ranks by straight-line
distance from the patient's confirmed address. Coordinates are hardcoded approximations
(no geocoding service, no network) for the prototype.
"""

from __future__ import annotations

import csv
import math
from pathlib import Path

from dme.contract import DirectorySupplier

DIRECTORY_CSV = Path(__file__).resolve().parents[1] / "data" / "suppliers.csv"

# Mocked patient address: 2236 N Seminary Ave, Chicago 60614.
PATIENT_LATLON = (41.9227, -87.6545)

# Supplier name -> (id, approximate lat, lon of its street address).
# Ids match the SUP array in docs/state-machine.html.
SUPPLIER_GEO: dict[str, tuple[str, float, float]] = {
    "Lincoln Park DME Services":        ("lp", 41.9255, -87.6497),  # 2401 N Lincoln Ave
    "Halsted Home Health Supply":       ("hh", 41.9350, -87.6487),  # 2870 N Halsted St
    "Lakeshore Home Medical Equipment": ("ls", 41.9146, -87.6325),  # 1820 N Clark St
    "Windy City Mobility & DME":        ("wc", 41.8948, -87.6392),  # 435 W Erie St
    "Prairie State Medical Supply":     ("ps", 41.9417, -87.6871),  # 3344 N Western Ave
    "Belmont Medical Equipment":        ("bm", 41.9393, -87.7128),  # 3400 W Belmont Ave
    "Roosevelt Medical Supply Co":      ("rs", 41.8670, -87.6555),  # 1147 W Roosevelt Rd
    "Northside CarePlus Equipment":     ("nc", 41.9780, -87.6682),  # 5215 N Clark St
    "ChicagoLand Durable Medical":      ("cl", 41.8705, -87.6252),  # 900 S Wabash Ave
    "South Loop Medical Supply":        ("sl", 41.8614, -87.6270),  # 1530 S State St
    "Midwest Mobility Solutions":       ("mm", 42.0115, -87.7930),  # 6601 W Touhy Ave, Niles
    "Evanston Home Medical":            ("eh", 42.0640, -87.6990),  # 1700 Central St, Evanston
}

EARTH_RADIUS_MI = 3958.8


def miles_between(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Great-circle (haversine) distance in miles."""
    lat1, lon1, lat2, lon2 = map(math.radians, (*a, *b))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * EARTH_RADIUS_MI * math.asin(math.sqrt(h))


def miles_from_patient(supplier_name: str) -> float | None:
    geo = SUPPLIER_GEO.get(supplier_name)
    if geo is None:
        return None
    return round(miles_between(PATIENT_LATLON, (geo[1], geo[2])), 1)


def load_directory(path: Path = DIRECTORY_CSV) -> list[DirectorySupplier]:
    """Read the three-column directory CSV and attach id + miles."""
    out: list[DirectorySupplier] = []
    with path.open(newline="") as fh:
        for i, row in enumerate(csv.DictReader(fh)):
            name = row["supplier_name"].strip()
            sid = SUPPLIER_GEO[name][0] if name in SUPPLIER_GEO else f"s{i + 1}"
            out.append(DirectorySupplier(id=sid, name=name, phone=row["phone"].strip(),
                                         address=row["address"].strip(),
                                         miles=miles_from_patient(name)))
    return out


def rank_by_distance(directory: list[DirectorySupplier]) -> list[DirectorySupplier]:
    """Nearest first (§5). Fills `miles` where the caller left it empty. Ranking uses
    unrounded distances, so Windy City (2.08) sorts before Prairie State (2.13) even
    though both display as ~2.1. Unknown locations go last; ties keep directory order."""

    def exact(s: DirectorySupplier) -> float:
        if s.name in SUPPLIER_GEO:
            _, lat, lon = SUPPLIER_GEO[s.name]
            return miles_between(PATIENT_LATLON, (lat, lon))
        return s.miles if s.miles is not None else math.inf

    filled = [s if s.miles is not None else s.model_copy(update={"miles": miles_from_patient(s.name)})
              for s in directory]
    return sorted(filled, key=exact)
