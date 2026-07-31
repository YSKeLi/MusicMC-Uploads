#!/usr/bin/env python3
"""Publish a processed song and rolling resource bundle into catalog v2."""

from __future__ import annotations

import argparse
import json
import time
import unicodedata
import urllib.parse
from pathlib import Path

from catalog_tools import load_catalog


def normalized_name(value: object) -> str:
    return unicodedata.normalize("NFKC", str(value)).strip().casefold()


def update(args: argparse.Namespace) -> None:
    catalog_path = Path(args.catalog)
    catalog = load_catalog(catalog_path)
    manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    bundle = json.loads(Path(args.bundle).read_text(encoding="utf-8"))
    required_song = {
        "song_id", "revision", "command_name", "display_name", "duration_seconds", "segments",
        "source", "ticket_nonce", "bundle_id",
    }
    required_bundle = {"bundle_id", "revision", "pack_id", "pack_file", "pack_sha1", "release_tag"}
    if not required_song.issubset(manifest) or not required_bundle.issubset(bundle):
        raise ValueError("manifest or bundle is missing required fields")
    if manifest["bundle_id"] != bundle["bundle_id"]:
        raise ValueError("song and bundle identifiers do not match")
    replacing = next((song for song in catalog["songs"] if song.get("song_id") == manifest["song_id"]), None)
    for song in catalog["songs"]:
        if (song.get("song_id") != manifest["song_id"]
                and normalized_name(song.get("command_name", song.get("display_name")))
                == normalized_name(manifest["command_name"])):
            raise ValueError("song command name is already published")
        if song.get("ticket_nonce") == manifest["ticket_nonce"]:
            raise ValueError("upload ticket has already been used")
    if replacing is not None and int(manifest["revision"]) <= int(replacing.get("revision", 1)):
        raise ValueError("song revision did not increase")
    if replacing is None and int(manifest["revision"]) != 1:
        raise ValueError("replacement song does not exist")

    release_base = (args.asset_base_url or
                    f"https://github.com/{args.repository}/releases/download/{bundle['release_tag']}").rstrip("/")
    parsed_base = urllib.parse.urlparse(release_base)
    if parsed_base.scheme != "https" or not parsed_base.netloc:
        raise ValueError("asset base URL must use HTTPS")
    published_bundle = {key: value for key, value in bundle.items() if key != "release_tag"}
    published_bundle["pack_url"] = f"{release_base}/{bundle['pack_file']}"
    old_index = next((index for index, item in enumerate(catalog["bundles"])
                      if item.get("bundle_id") == bundle["bundle_id"]), None)
    if old_index is None:
        for item in catalog["bundles"]:
            if not item.get("immutable", True):
                item["immutable"] = True
        catalog["bundles"].append(published_bundle)
    else:
        if int(bundle["revision"]) <= int(catalog["bundles"][old_index].get("revision", 0)):
            raise ValueError("bundle revision did not increase")
        catalog["bundles"][old_index] = published_bundle

    source = dict(manifest["source"])
    archive_file = source.get("archive_file")
    source["archive_url"] = f"{release_base}/{archive_file}" if archive_file else None
    song = {
        "song_id": manifest["song_id"],
        "revision": int(manifest["revision"]),
        "command_name": manifest["command_name"],
        "display_name": manifest["display_name"],
        "artist": manifest.get("artist", ""),
        "enabled": bool(manifest.get("enabled", True)),
        "minecraft_player_name": manifest.get("minecraft_player_name"),
        "minecraft_player_uuid": manifest.get("minecraft_player_uuid"),
        "github_uploader": manifest.get("github_uploader"),
        "duration_seconds": manifest["duration_seconds"],
        "bundle_id": manifest["bundle_id"],
        "segments": [
            {"sound_key": item["sound_key"], "duration_seconds": item["duration_seconds"]}
            for item in manifest["segments"]
        ],
        "source": source,
        "ticket_nonce": manifest["ticket_nonce"],
        "created_at_epoch": manifest.get("created_at_epoch", int(time.time())),
    }
    catalog["songs"] = [item for item in catalog["songs"] if item.get("song_id") != song["song_id"]]
    catalog["songs"].append(song)
    catalog["songs"].sort(key=lambda item: (int(item.get("created_at_epoch", 0)), str(item["song_id"])))
    catalog["bundles"].sort(key=lambda item: str(item["bundle_id"]))
    catalog["schema_version"] = 2
    catalog["updated_at_epoch"] = int(time.time())
    catalog_path.write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--catalog", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--bundle", required=True)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--asset-base-url")
    args = parser.parse_args()
    update(args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
