from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / "scripts" / "update_catalog.py"


class UpdateCatalogTest(unittest.TestCase):
    def test_adds_release_urls(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            catalog = root / "catalog.json"
            manifest = root / "manifest.json"
            catalog.write_text('{"schema_version":1,"songs":[]}\n', encoding="utf-8")
            manifest.write_text(json.dumps(song_manifest("nonce-1")), encoding="utf-8")

            result = run_update(catalog, manifest)

            self.assertEqual(0, result.returncode, result.stderr)
            song = json.loads(catalog.read_text(encoding="utf-8"))["songs"][0]
            self.assertEqual(
                "https://github.com/example/uploads/releases/download/release-1/musicmc-song_1.zip",
                song["pack_url"],
            )
            self.assertEqual(
                "https://github.com/example/uploads/releases/download/release-1/musicmc-song_1-source.zip",
                song["source_archive_url"],
            )

    def test_rejects_reused_ticket(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            catalog = root / "catalog.json"
            manifest = root / "manifest.json"
            catalog.write_text(
                json.dumps({"schema_version": 1, "songs": [song_manifest("nonce-1")]}),
                encoding="utf-8",
            )
            duplicate = song_manifest("nonce-1")
            duplicate["song_id"] = "song_2"
            duplicate["display_name"] = "Another Song"
            manifest.write_text(json.dumps(duplicate), encoding="utf-8")

            result = run_update(catalog, manifest)

            self.assertNotEqual(0, result.returncode)
            self.assertIn("upload ticket has already been used", result.stderr)


def run_update(catalog: Path, manifest: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            sys.executable,
            str(SCRIPT),
            "--catalog",
            str(catalog),
            "--manifest",
            str(manifest),
            "--repository",
            "example/uploads",
        ],
        capture_output=True,
        text=True,
        check=False,
    )


def song_manifest(nonce: str) -> dict[str, object]:
    return {
        "schema_version": 1,
        "issue_number": 1,
        "release_tag": "release-1",
        "song_id": "song_1",
        "display_name": "Test Song",
        "minecraft_player_name": "TestPlayer",
        "minecraft_player_uuid": "00000000-0000-0000-0000-000000000001",
        "github_uploader": "tester",
        "duration_seconds": 60,
        "sound_key": "musicmc:music.song_1",
        "pack_file": "musicmc-song_1.zip",
        "pack_sha1": "0123456789abcdef0123456789abcdef01234567",
        "source_attachment_url": "https://github.com/user-attachments/files/1/song.zip",
        "source_archive_file": "musicmc-song_1-source.zip",
        "source_archive_sha256": "01" * 32,
        "ticket_nonce": nonce,
        "created_at_epoch": 1,
    }


if __name__ == "__main__":
    unittest.main()
