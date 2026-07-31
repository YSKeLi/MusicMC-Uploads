from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / "scripts" / "update_catalog.py"


class UpdateCatalogTest(unittest.TestCase):
    def test_adds_v2_bundle_and_release_urls(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            catalog = root / "catalog.json"
            manifest = root / "manifest.json"
            bundle = root / "bundle.json"
            catalog.write_text(
                '{"schema_version":2,"updated_at_epoch":0,"bundles":[],"songs":[]}\n', encoding="utf-8")
            manifest.write_text(json.dumps(song_manifest("nonce-1")), encoding="utf-8")
            bundle.write_text(json.dumps(bundle_manifest()), encoding="utf-8")

            result = run_update(catalog, manifest, bundle)

            self.assertEqual(0, result.returncode, result.stderr)
            output = json.loads(catalog.read_text(encoding="utf-8"))
            self.assertEqual(2, output["schema_version"])
            self.assertEqual(
                "https://github.com/example/uploads/releases/download/bundle-1/musicmc-bundle_0001-r1.zip",
                output["bundles"][0]["pack_url"],
            )
            self.assertNotIn("file", output["songs"][0]["segments"][0])
            self.assertEqual("upload", output["songs"][0]["source"]["kind"])

    def test_rejects_reused_ticket(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            catalog = root / "catalog.json"
            manifest = root / "manifest.json"
            bundle = root / "bundle.json"
            old_song = song_manifest("nonce-1")
            old_song.pop("bundle_id")
            old_song["bundle_id"] = "bundle_0001"
            old_song["segments"][0].pop("file")
            catalog.write_text(json.dumps({
                "schema_version": 2, "updated_at_epoch": 1,
                "bundles": [{key: value for key, value in bundle_manifest().items() if key != "release_tag"}
                            | {"pack_url": "https://example.com/pack.zip"}],
                "songs": [old_song],
            }), encoding="utf-8")
            duplicate = song_manifest("nonce-1")
            duplicate["song_id"] = "song_2"
            duplicate["command_name"] = "another"
            manifest.write_text(json.dumps(duplicate), encoding="utf-8")
            changed_bundle = bundle_manifest()
            changed_bundle["revision"] = 2
            bundle.write_text(json.dumps(changed_bundle), encoding="utf-8")

            result = run_update(catalog, manifest, bundle)

            self.assertNotEqual(0, result.returncode)
            self.assertIn("upload ticket has already been used", result.stderr)

    def test_replaces_song_id_with_a_higher_revision(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            catalog = root / "catalog.json"
            manifest = root / "manifest.json"
            bundle = root / "bundle.json"
            old_song = song_manifest("old-nonce")
            old_song["segments"][0].pop("file")
            old_bundle = bundle_manifest()
            old_bundle.pop("release_tag")
            old_bundle["pack_url"] = "https://example.com/old.zip"
            catalog.write_text(json.dumps({
                "schema_version": 2, "updated_at_epoch": 1,
                "bundles": [old_bundle], "songs": [old_song],
            }), encoding="utf-8")
            replacement = song_manifest("new-nonce")
            replacement["revision"] = 2
            manifest.write_text(json.dumps(replacement), encoding="utf-8")
            changed_bundle = bundle_manifest()
            changed_bundle["revision"] = 2
            bundle.write_text(json.dumps(changed_bundle), encoding="utf-8")

            result = run_update(catalog, manifest, bundle)

            self.assertEqual(0, result.returncode, result.stderr)
            songs = json.loads(catalog.read_text(encoding="utf-8"))["songs"]
            self.assertEqual(1, len(songs))
            self.assertEqual("song_1", songs[0]["song_id"])
            self.assertEqual(2, songs[0]["revision"])


def run_update(catalog: Path, manifest: Path, bundle: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run([
        sys.executable, str(SCRIPT), "--catalog", str(catalog), "--manifest", str(manifest),
        "--bundle", str(bundle), "--repository", "example/uploads",
    ], capture_output=True, text=True, check=False)


def song_manifest(nonce: str) -> dict[str, object]:
    return {
        "schema_version": 2, "issue_number": 1, "song_id": "song_1", "revision": 1,
        "command_name": "test", "display_name": "Test Song", "artist": "", "enabled": True,
        "minecraft_player_name": "TestPlayer",
        "minecraft_player_uuid": "00000000-0000-0000-0000-000000000001",
        "github_uploader": "tester", "duration_seconds": 5,
        "segments": [{"sound_key": "musicmc:music.song_1.part000", "duration_seconds": 5,
                      "file": "part000.ogg"}],
        "source": {"kind": "upload", "provider_id": "1", "provider_url": None,
                   "archive_file": "source.zip", "archive_sha256": "01" * 32},
        "ticket_nonce": nonce, "created_at_epoch": 1, "bundle_id": "bundle_0001",
    }


def bundle_manifest() -> dict[str, object]:
    return {
        "bundle_id": "bundle_0001", "revision": 1,
        "pack_id": "00000000-0000-0000-0000-000000000001",
        "pack_file": "musicmc-bundle_0001-r1.zip",
        "pack_sha1": "0123456789abcdef0123456789abcdef01234567",
        "size_bytes": 1024, "immutable": False, "release_tag": "bundle-1",
    }


if __name__ == "__main__":
    unittest.main()
