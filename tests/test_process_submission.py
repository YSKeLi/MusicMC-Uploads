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
    def test_parses_portal_issue_sections(self) -> None:
        body = """### 上传凭证

MUS1.payload.signature

### 歌曲名称

晴天

### Minecraft 玩家名

TestPlayer

### 音乐 ZIP 文件

[song.zip](https://github.com/user-attachments/files/1/song.zip)
"""

        sections = PROCESSOR.parse_sections(body)

        self.assertEqual("MUS1.payload.signature", sections["上传凭证"])
        self.assertEqual("晴天", sections["歌曲名称"])
        self.assertEqual("TestPlayer", sections["Minecraft 玩家名"])
        self.assertIn("song.zip", sections["音乐 ZIP 文件"])

    def test_accepts_only_trusted_automated_release_urls(self) -> None:
        nonce = "0123456789abcdef0123456789abcdef"
        trusted = (
            "https://github.com/YSKeLi/MusicMC-Uploads/releases/download/"
            f"upload-{nonce}/submission-{nonce}.zip"
        )
        self.assertEqual(trusted, PROCESSOR.find_attachment_url(f"[song.zip]({trusted})"))
        with self.assertRaises(PROCESSOR.SubmissionError):
            PROCESSOR.find_attachment_url(
                "https://github.com/other/repo/releases/download/upload-"
                f"{nonce}/submission-{nonce}.zip"
            )


if __name__ == "__main__":
    unittest.main()
