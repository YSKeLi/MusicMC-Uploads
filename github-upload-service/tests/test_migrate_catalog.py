import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "github-upload-service" / "scripts" / "migrate_catalog.py"


class MigrateCatalogTest(unittest.TestCase):
    def test_preserves_v1_song_identity_and_asset_urls(self):
        with tempfile.TemporaryDirectory() as directory:
            catalog_path = Path(directory) / "catalog.json"
            catalog_path.write_text(json.dumps({
                "schema_version": 1,
                "updated_at_epoch": 123,
                "songs": [{
                    "song_id": "song_5_deadbeef",
                    "display_name": "abc",
                    "minecraft_player_name": "PlayerOne",
                    "minecraft_player_uuid": "4544298e-3bb7-36ab-8412-2e96b477ffdd",
                    "ticket_nonce": "a" * 32,
                    "duration_seconds": 42.5,
                    "sound_key": "musicmc:music.song_5_deadbeef",
                    "pack_file": "musicmc-song_5_deadbeef.zip",
                    "pack_sha1": "b" * 40,
                    "pack_url": "https://github.com/owner/repo/releases/download/song-5/pack.zip",
                    "created_at_epoch": 123,
                }],
            }), encoding="utf-8")

            result = subprocess.run(
                [sys.executable, str(SCRIPT), "--catalog", str(catalog_path)],
                check=True, capture_output=True, text=True,
            )
            summary = json.loads(result.stdout)
            migrated = json.loads(catalog_path.read_text(encoding="utf-8"))

        self.assertEqual({"schema_version": 2, "songs": 1, "bundles": 1}, summary)
        self.assertEqual("song_5_deadbeef", migrated["songs"][0]["song_id"])
        self.assertEqual("abc", migrated["songs"][0]["command_name"])
        self.assertEqual(
            "https://github.com/owner/repo/releases/download/song-5/pack.zip",
            migrated["bundles"][0]["pack_url"],
        )


if __name__ == "__main__":
    unittest.main()
