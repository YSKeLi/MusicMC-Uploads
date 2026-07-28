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

### 上传确认

- [x] 我拥有该音频的使用许可。

### 音乐 ZIP 文件

[song.zip](https://github.com/user-attachments/files/1/song.zip)
"""

        sections = PROCESSOR.parse_sections(body)

        self.assertEqual("MUS1.payload.signature", sections["上传凭证"])
        self.assertEqual("晴天", sections["歌曲名称"])
        self.assertEqual("TestPlayer", sections["Minecraft 玩家名"])
        self.assertIn("song.zip", sections["音乐 ZIP 文件"])


if __name__ == "__main__":
    unittest.main()
