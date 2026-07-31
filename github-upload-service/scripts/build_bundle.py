#!/usr/bin/env python3
"""Merge processed song segments into a rolling MusicMC resource bundle."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import urllib.request
import uuid
import zipfile
from pathlib import Path, PurePosixPath

from catalog_tools import load_catalog


MAX_SONGS_PER_BUNDLE = 20
MAX_BUNDLE_BYTES = 95 * 1024 * 1024
MAX_EXTRACTED_BYTES = 150 * 1024 * 1024
PACK_FORMAT = 75


def next_bundle_id(catalog: dict) -> str:
    numbers = []
    for bundle in catalog["bundles"]:
        if str(bundle.get("bundle_id", "")).startswith("bundle_"):
            try:
                numbers.append(int(str(bundle["bundle_id"]).removeprefix("bundle_")))
            except ValueError:
                pass
    return f"bundle_{max(numbers, default=0) + 1:04d}"


def select_bundle(catalog: dict, added_bytes: int) -> dict | None:
    counts: dict[str, int] = {}
    for song in catalog["songs"]:
        counts[str(song.get("bundle_id"))] = counts.get(str(song.get("bundle_id")), 0) + 1
    candidates = [
        bundle for bundle in catalog["bundles"]
        if not bundle.get("immutable", True)
        and counts.get(str(bundle.get("bundle_id")), 0) < MAX_SONGS_PER_BUNDLE
        and int(bundle.get("size_bytes", 0)) + added_bytes + 1024 * 1024 <= MAX_BUNDLE_BYTES
    ]
    return max(candidates, key=lambda value: str(value["bundle_id"]), default=None)


def download_existing(bundle: dict, destination: Path) -> None:
    request = urllib.request.Request(
        str(bundle["pack_url"]), headers={"User-Agent": "MusicMC-Bundle-Builder/2"})
    with urllib.request.urlopen(request, timeout=120) as response, destination.open("wb") as output:
        total = 0
        while chunk := response.read(1024 * 1024):
            total += len(chunk)
            if total > MAX_BUNDLE_BYTES:
                raise ValueError("existing resource bundle exceeds the size limit")
            output.write(chunk)
    actual = hashlib.sha1(destination.read_bytes()).hexdigest()
    if actual != str(bundle["pack_sha1"]).lower():
        raise ValueError("existing resource bundle hash mismatch")


def extract_pack(archive: Path, destination: Path) -> None:
    total = 0
    with zipfile.ZipFile(archive) as source:
        for info in source.infolist():
            parts = PurePosixPath(info.filename).parts
            if info.is_dir():
                continue
            if not parts or info.filename.startswith("/") or ".." in parts or "\\" in info.filename:
                raise ValueError("existing resource bundle contains an unsafe path")
            total += info.file_size
            if total > MAX_EXTRACTED_BYTES:
                raise ValueError("existing resource bundle expands beyond the safety limit")
            target = destination.joinpath(*parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            with source.open(info) as input_file, target.open("wb") as output_file:
                shutil.copyfileobj(input_file, output_file)


def write_deterministic_zip(source: Path, destination: Path) -> None:
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as output:
        for file_path in sorted(path for path in source.rglob("*") if path.is_file()):
            relative = file_path.relative_to(source).as_posix()
            info = zipfile.ZipInfo(relative, date_time=(2020, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            output.writestr(info, file_path.read_bytes(), compresslevel=6)


def build(args: argparse.Namespace) -> None:
    catalog = load_catalog(Path(args.catalog))
    manifest_path = Path(args.manifest).resolve()
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    output_dir = Path(args.output).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    added_bytes = sum((manifest_path.parent / "segments" / item["file"]).stat().st_size
                      for item in manifest["segments"])
    selected = select_bundle(catalog, added_bytes)
    if selected:
        bundle_id = str(selected["bundle_id"])
        revision = int(selected["revision"]) + 1
    else:
        bundle_id = next_bundle_id(catalog)
        revision = 1

    pack_root = output_dir / "bundle-root"
    if pack_root.exists():
        shutil.rmtree(pack_root)
    pack_root.mkdir(parents=True)
    if selected:
        existing_zip = output_dir / "existing-bundle.zip"
        download_existing(selected, existing_zip)
        extract_pack(existing_zip, pack_root)

    song_id = str(manifest["song_id"])
    sound_directory = pack_root / "assets" / "musicmc" / "sounds" / "music" / song_id
    if sound_directory.exists():
        shutil.rmtree(sound_directory)
    sound_directory.mkdir(parents=True, exist_ok=True)
    sounds_path = pack_root / "assets" / "musicmc" / "sounds.json"
    sounds_path.parent.mkdir(parents=True, exist_ok=True)
    sounds = json.loads(sounds_path.read_text(encoding="utf-8")) if sounds_path.exists() else {}
    event_prefix = f"music.{song_id}."
    sounds = {key: value for key, value in sounds.items() if not key.startswith(event_prefix)}
    for index, segment in enumerate(manifest["segments"]):
        source = manifest_path.parent / "segments" / str(segment["file"])
        destination = sound_directory / f"part{index:03d}.ogg"
        shutil.copy2(source, destination)
        event_name = str(segment["sound_key"]).removeprefix("musicmc:")
        sounds[event_name] = {
            "sounds": [{"name": f"musicmc:music/{song_id}/part{index:03d}", "stream": True}]
        }
    sounds_path.write_text(json.dumps(sounds, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (pack_root / "pack.mcmeta").write_text(json.dumps({
        "pack": {"pack_format": PACK_FORMAT, "description": f"MusicMC {bundle_id} r{revision}"}
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    pack_path = output_dir / f"musicmc-{bundle_id}-r{revision}.zip"
    write_deterministic_zip(pack_root, pack_path)
    size_bytes = pack_path.stat().st_size
    if size_bytes > MAX_BUNDLE_BYTES:
        raise ValueError("new resource bundle exceeds 95 MB")
    replacing_in_bundle = any(song.get("song_id") == song_id and song.get("bundle_id") == bundle_id
                              for song in catalog["songs"])
    song_count = (0 if replacing_in_bundle else 1) + sum(
        1 for song in catalog["songs"] if song.get("bundle_id") == bundle_id)
    bundle = {
        "bundle_id": bundle_id,
        "revision": revision,
        "pack_id": str(uuid.uuid5(uuid.NAMESPACE_URL, f"musicmc:{bundle_id}:r{revision}")),
        "pack_file": pack_path.name,
        "pack_sha1": hashlib.sha1(pack_path.read_bytes()).hexdigest(),
        "size_bytes": size_bytes,
        "immutable": song_count >= MAX_SONGS_PER_BUNDLE,
        "release_tag": args.release_tag,
    }
    bundle_path = output_dir / "bundle.json"
    bundle_path.write_text(json.dumps(bundle, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    manifest["bundle_id"] = bundle_id
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    with (output_dir / "action-output.env").open("a", encoding="utf-8") as env:
        env.write(f"RELEASE_TAG={args.release_tag}\nPACK_PATH={pack_path}\nBUNDLE_PATH={bundle_path}\n")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--catalog", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--release-tag", required=True)
    args = parser.parse_args()
    build(args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
