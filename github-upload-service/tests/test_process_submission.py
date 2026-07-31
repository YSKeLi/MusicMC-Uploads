from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / "scripts" / "process_submission.py"
SPEC = importlib.util.spec_from_file_location("process_submission", SCRIPT)
assert SPEC and SPEC.loader
PROCESSOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PROCESSOR)


class ProcessSubmissionTest(unittest.TestCase):
    def test_parses_machine_stable_issue_sections(self) -> None:
        body = """### Upload ticket

MUS1.payload.signature

### Song name

晴天

### Minecraft player

TestPlayer

### Source type

upload

### Music ZIP file

[anything.zip](https://github.com/user-attachments/files/1/song.zip)
"""
        sections = PROCESSOR.parse_sections(body)
        self.assertEqual("MUS1.payload.signature", sections["Upload ticket"])
        self.assertEqual("晴天", sections["Song name"])
        self.assertEqual("TestPlayer", sections["Minecraft player"])
        self.assertEqual("upload", sections["Source type"])

    def test_accepts_only_trusted_automated_release_urls(self) -> None:
        nonce = "0123456789abcdef0123456789abcdef"
        trusted = (
            "https://github.com/example/musicmc/releases/download/"
            f"upload-{nonce}/submission-{nonce}.zip"
        )
        self.assertEqual(trusted, PROCESSOR.find_attachment_url(
            f"[song.zip]({trusted})", "example/musicmc"))
        with self.assertRaises(PROCESSOR.SubmissionError):
            PROCESSOR.find_attachment_url(
                "https://github.com/other/repo/releases/download/upload-"
                f"{nonce}/submission-{nonce}.zip", "example/musicmc")


if __name__ == "__main__":
    unittest.main()
