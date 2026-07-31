"""Shared MusicMC catalog v1-to-v2 migration helpers."""

from __future__ import annotations

import hashlib
import json
import uuid
from pathlib import Path


def load_catalog(path: Path) -> dict:
    if not path.exists():
        return {"schema_version": 2, "updated_at_epoch": 0, "bundles": [], "songs": []}
    catalog = json.loads(path.read_text(encoding="utf-8"))
    if catalog.get("schema_version") == 1:
        return migrate_v1(catalog)
    if catalog.get("schema_version") != 2:
        raise ValueError("unsupported catalog format")
    if not isinstance(catalog.get("bundles"), list) or not isinstance(catalog.get("songs"), list):
        raise ValueError("catalog is missing bundles or songs")
    return catalog


def migrate_v1(catalog: dict) -> dict:
    bundles: list[dict] = []
    songs: list[dict] = []
    for old in catalog.get("songs", []):
        song_id = str(old["song_id"])
        bundle_id = f"legacy_{song_id}"
        pack_sha1 = str(old["pack_sha1"])
        pack_id = str(uuid.UUID(bytes=hashlib.md5(
            f"musicmc:{song_id}:{pack_sha1}".encode("utf-8"), usedforsecurity=False
        ).digest(), version=3))
        bundles.append({
            "bundle_id": bundle_id,
            "revision": 1,
            "pack_id": pack_id,
            "pack_file": old["pack_file"],
            "pack_sha1": pack_sha1,
            "pack_url": old["pack_url"],
            "size_bytes": int(old.get("pack_size_bytes", 0)),
            "immutable": True,
        })
        source = {
            "kind": "upload",
            "provider_id": str(old.get("issue_number", "")),
            "provider_url": old.get("source_attachment_url"),
            "archive_file": old.get("source_archive_file"),
            "archive_sha256": old.get("source_archive_sha256"),
            "archive_url": old.get("source_archive_url"),
        }
        songs.append({
            "song_id": song_id,
            "revision": 1,
            "command_name": old["display_name"],
            "display_name": old["display_name"],
            "artist": "",
            "enabled": True,
            "minecraft_player_name": old.get("minecraft_player_name"),
            "minecraft_player_uuid": old.get("minecraft_player_uuid"),
            "github_uploader": old.get("github_uploader"),
            "duration_seconds": old["duration_seconds"],
            "bundle_id": bundle_id,
            "segments": [{
                "sound_key": old["sound_key"],
                "duration_seconds": old["duration_seconds"],
            }],
            "source": source,
            "ticket_nonce": old.get("ticket_nonce"),
            "created_at_epoch": old.get("created_at_epoch", 0),
        })
    return {
        "schema_version": 2,
        "updated_at_epoch": int(catalog.get("updated_at_epoch", 0)),
        "bundles": bundles,
        "songs": songs,
    }
