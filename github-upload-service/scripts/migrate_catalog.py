#!/usr/bin/env python3
"""Convert a MusicMC catalog to schema v2 without changing published assets."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from catalog_tools import load_catalog


def migrate(source: Path, destination: Path) -> dict:
    catalog = load_catalog(source)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(
        json.dumps(catalog, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return catalog


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--catalog", required=True)
    parser.add_argument("--output")
    parser.add_argument("--check-only", action="store_true")
    args = parser.parse_args()
    source = Path(args.catalog).resolve()
    catalog = load_catalog(source)
    if not args.check_only:
        destination = Path(args.output).resolve() if args.output else source
        migrate(source, destination)
    print(json.dumps({
        "schema_version": catalog["schema_version"],
        "songs": len(catalog["songs"]),
        "bundles": len(catalog["bundles"]),
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
