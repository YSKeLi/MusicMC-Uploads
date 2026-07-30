from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / "scripts" / "submission_release.py"
SPEC = importlib.util.spec_from_file_location("submission_release", SCRIPT)
assert SPEC and SPEC.loader
SUBMISSION_RELEASE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SUBMISSION_RELEASE)


class SubmissionReleaseTest(unittest.TestCase):
    def test_finds_worker_staging_release(self) -> None:
        nonce = "0123456789abcdef0123456789abcdef"
        event = {
            "issue": {
                "body": (
                    "### 音乐 ZIP 文件\n\n"
                    f"[song.zip](https://github.com/YSKeLi/MusicMC-Uploads/releases/download/"
                    f"upload-{nonce}/submission-{nonce}.zip)"
                )
            }
        }
        self.assertEqual(
            f"upload-{nonce}",
            SUBMISSION_RELEASE.find_upload_tag(event, "YSKeLi/MusicMC-Uploads"),
        )

    def test_ignores_other_repositories(self) -> None:
        event = {
            "issue": {
                "body": "https://github.com/other/repo/releases/download/"
                "upload-0123456789abcdef0123456789abcdef/"
                "submission-0123456789abcdef0123456789abcdef.zip"
            }
        }
        self.assertEqual("", SUBMISSION_RELEASE.find_upload_tag(event, "YSKeLi/MusicMC-Uploads"))


if __name__ == "__main__":
    unittest.main()
