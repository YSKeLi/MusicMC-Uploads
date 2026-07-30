#!/usr/bin/env python3
"""Find a MusicMC temporary upload Release tag in a GitHub Issue event."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path


def find_upload_tag(event: dict, repository: str) -> str:
    body = str((event.get("issue") or {}).get("body") or "")
    escaped_repository = re.escape(repository)
    pattern = re.compile(
        rf"https://github\.com/{escaped_repository}/releases/download/"
        r"(upload-[0-9a-f]{32})/submission-[0-9a-f]{32}\.zip",
        re.IGNORECASE,
    )
    match = pattern.search(body)
    return match.group(1).lower() if match else ""


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--event", required=True)
    parser.add_argument("--repository", required=True)
    args = parser.parse_args()
    event = json.loads(Path(args.event).read_text(encoding="utf-8"))
    print(find_upload_tag(event, args.repository))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
