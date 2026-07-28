#!/usr/bin/env python3
"""Add a published song manifest to the token-free public synchronization catalog."""

from __future__ import annotations

import argparse
import json
import time
import unicodedata
from pathlib import Path


def normalized_name(value: object) -> str:
    return unicodedata.normalize("NFKC", str(value)).strip().casefold()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--catalog", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--repository", required=True)
    args = parser.parse_args()

    catalog_path = Path(args.catalog)
    manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    if catalog_path.exists():
        catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    else:
        catalog = {"schema_version": 1, "songs": []}

    required = {
        "song_id",
        "release_tag",
        "pack_file",
        "pack_sha1",
        "source_archive_file",
        "source_archive_sha256",
        "display_name",
        "sound_key",
        "ticket_nonce",
    }
    if catalog.get("schema_version") != 1 or not isinstance(catalog.get("songs"), list):
        raise ValueError("unsupported catalog format")
    if not required.issubset(manifest):
        raise ValueError("manifest is missing required fields")

    release_base = f"https://github.com/{args.repository}/releases/download/{manifest['release_tag']}"
    entry = dict(manifest)
    entry["pack_url"] = f"{release_base}/{manifest['pack_file']}"
    entry["manifest_url"] = f"{release_base}/musicmc-{manifest['song_id']}.json"
    entry["source_archive_url"] = f"{release_base}/{manifest['source_archive_file']}"
    entry["issue_url"] = f"https://github.com/{args.repository}/issues/{manifest['issue_number']}"

    for song in catalog["songs"]:
        if normalized_name(song.get("display_name")) == normalized_name(entry["display_name"]):
            raise ValueError("song name is already published")
        if song.get("ticket_nonce") == entry.get("ticket_nonce"):
            raise ValueError("upload ticket has already been used")

    songs = [song for song in catalog["songs"] if song.get("song_id") != entry["song_id"]]
    songs.append(entry)
    songs.sort(key=lambda song: (int(song.get("created_at_epoch", 0)), str(song["song_id"])))
    catalog["songs"] = songs
    catalog["updated_at_epoch"] = int(time.time())
    catalog_path.write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
