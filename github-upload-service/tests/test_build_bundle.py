from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / "scripts" / "build_bundle.py"


class BuildBundleTest(unittest.TestCase):
    def test_builds_segmented_bundle_and_action_outputs(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            build = root / "build"
            segments = build / "segments"
            segments.mkdir(parents=True)
            (segments / "part000.ogg").write_bytes(b"OggS test audio")
            catalog = root / "catalog.json"
            catalog.write_text(
                '{"schema_version":2,"updated_at_epoch":0,"bundles":[],"songs":[]}\n', encoding="utf-8")
            manifest = build / "manifest.json"
            manifest.write_text(json.dumps({
                "song_id": "song_1", "segments": [{
                    "sound_key": "musicmc:music.song_1.part000",
                    "duration_seconds": 5, "file": "part000.ogg",
                }],
            }), encoding="utf-8")

            result = subprocess.run([
                sys.executable, str(SCRIPT), "--catalog", str(catalog), "--manifest", str(manifest),
                "--output", str(build), "--release-tag", "bundle-run-1",
            ], capture_output=True, text=True, check=False)

            self.assertEqual(0, result.returncode, result.stderr)
            bundle = json.loads((build / "bundle.json").read_text(encoding="utf-8"))
            pack = build / bundle["pack_file"]
            with zipfile.ZipFile(pack) as archive:
                self.assertIn("assets/musicmc/sounds/music/song_1/part000.ogg", archive.namelist())
                sounds = json.loads(archive.read("assets/musicmc/sounds.json"))
                self.assertIn("music.song_1.part000", sounds)
            self.assertIn("PACK_PATH=", (build / "action-output.env").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
