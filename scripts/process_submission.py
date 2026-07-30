#!/usr/bin/env python3
"""Validate a signed GitHub Issue submission and build one immutable song pack."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path


MAX_ARCHIVE_BYTES = 25 * 1024 * 1024
MAX_AUDIO_BYTES = 100 * 1024 * 1024
MAX_DURATION_SECONDS = 10 * 60
ALLOWED_AUDIO_EXTENSIONS = {".mp3", ".m4a", ".aac", ".wav", ".flac", ".ogg", ".opus"}
ALLOWED_ATTACHMENT_HOSTS = {
    "user-images.githubusercontent.com",
    "objects.githubusercontent.com",
}
AUTOMATED_RELEASE_PATH = re.compile(
    r"^/YSKeLi/MusicMC-Uploads/releases/download/"
    r"upload-([0-9a-f]{32})/submission-\1\.zip$",
    re.IGNORECASE,
)
SECTION_PATTERN = re.compile(r"^###\s+(.+?)\s*$\r?\n(.*?)(?=^###\s+|\Z)", re.MULTILINE | re.DOTALL)
ATTACHMENT_PATTERN = re.compile(r"https://[^\s)>]+", re.IGNORECASE)


class SubmissionError(Exception):
    pass


def normalize_text(value: str) -> str:
    return unicodedata.normalize("NFKC", value).strip()


def decode_base64url(value: str) -> bytes:
    try:
        return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    except (ValueError, base64.binascii.Error) as exc:
        raise SubmissionError("上传凭证使用了无效的 Base64URL 编码。") from exc


def parse_sections(body: str) -> dict[str, str]:
    sections: dict[str, str] = {}
    for match in SECTION_PATTERN.finditer(body):
        key = normalize_text(match.group(1))
        value = match.group(2).strip()
        if value and value != "_No response_":
            sections[key] = value
    return sections


def require_section(sections: dict[str, str], name: str) -> str:
    value = sections.get(name)
    if not value:
        raise SubmissionError(f"Issue 缺少必填字段：{name}。")
    return value


def verify_ticket(ticket: str, public_key: Path, song_name: str, player_name: str) -> dict:
    parts = normalize_text(ticket).split(".")
    if len(parts) != 3 or parts[0] != "MUS1":
        raise SubmissionError("上传凭证格式无效。请重新在服务器中生成凭证。")

    payload_bytes = decode_base64url(parts[1])
    signature = decode_base64url(parts[2])
    work_dir = public_key.parent
    payload_path = work_dir / ".ticket-payload.tmp"
    signature_path = work_dir / ".ticket-signature.tmp"
    payload_path.write_bytes(payload_bytes)
    signature_path.write_bytes(signature)
    try:
        result = subprocess.run(
            [
                "openssl",
                "dgst",
                "-sha256",
                "-verify",
                str(public_key),
                "-signature",
                str(signature_path),
                str(payload_path),
            ],
            capture_output=True,
            text=True,
            check=False,
        )
    finally:
        payload_path.unlink(missing_ok=True)
        signature_path.unlink(missing_ok=True)

    if result.returncode != 0:
        raise SubmissionError("上传凭证签名无效。")

    try:
        payload = json.loads(payload_bytes)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise SubmissionError("上传凭证内容无效。") from exc

    required = {"v", "player_uuid", "player_name", "song_name", "exp", "nonce"}
    if not isinstance(payload, dict) or not required.issubset(payload):
        raise SubmissionError("上传凭证缺少必要信息。")
    if payload["v"] != 1:
        raise SubmissionError("上传凭证版本不受支持。")

    now = int(time.time())
    try:
        expires_at = int(payload["exp"])
    except (TypeError, ValueError) as exc:
        raise SubmissionError("上传凭证过期时间无效。") from exc
    if expires_at < now:
        raise SubmissionError("上传凭证已经过期，请在服务器中重新生成。")
    if expires_at > now + 3600:
        raise SubmissionError("上传凭证有效期异常。")
    if normalize_text(str(payload["song_name"])) != song_name:
        raise SubmissionError("Issue 中的歌曲名称与上传凭证不一致。")
    if normalize_text(str(payload["player_name"])).casefold() != player_name.casefold():
        raise SubmissionError("Issue 中的 Minecraft 玩家名与上传凭证不一致。")
    return payload


def find_attachment_url(field_value: str) -> str:
    for candidate in ATTACHMENT_PATTERN.findall(field_value):
        candidate = candidate.rstrip(".,]")
        parsed = urllib.parse.urlparse(candidate)
        trusted_attachment = parsed.hostname in ALLOWED_ATTACHMENT_HOSTS
        trusted_staging_release = parsed.hostname == "github.com" and AUTOMATED_RELEASE_PATH.fullmatch(parsed.path)
        if parsed.scheme == "https" and (trusted_attachment or trusted_staging_release):
            return candidate
    raise SubmissionError("没有找到有效的 GitHub ZIP 附件地址。")


def download_attachment(url: str, destination: Path) -> None:
    request = urllib.request.Request(url, headers={"User-Agent": "MusicMC-Submission-Processor/1"})
    try:
        with urllib.request.urlopen(request, timeout=60) as response, destination.open("wb") as target:
            declared_length = response.headers.get("Content-Length")
            if declared_length and int(declared_length) > MAX_ARCHIVE_BYTES:
                raise SubmissionError("ZIP 文件超过 25 MB。")
            total = 0
            while chunk := response.read(1024 * 1024):
                total += len(chunk)
                if total > MAX_ARCHIVE_BYTES:
                    raise SubmissionError("ZIP 文件超过 25 MB。")
                target.write(chunk)
    except SubmissionError:
        raise
    except Exception as exc:
        raise SubmissionError("无法从 GitHub 下载 ZIP 附件。") from exc


def extract_audio(archive: Path, destination_dir: Path) -> Path:
    try:
        source_zip = zipfile.ZipFile(archive)
    except zipfile.BadZipFile as exc:
        raise SubmissionError("上传的文件不是有效 ZIP。") from exc

    with source_zip:
        candidates: list[zipfile.ZipInfo] = []
        for info in source_zip.infolist():
            normalized = info.filename.replace("\\", "/")
            parts = [part for part in normalized.split("/") if part]
            if info.is_dir() or not parts or "__MACOSX" in parts or parts[-1].startswith("."):
                continue
            if normalized.startswith("/") or ".." in parts:
                raise SubmissionError("ZIP 包含不安全的文件路径。")
            if info.flag_bits & 0x1:
                raise SubmissionError("不支持加密 ZIP。")
            if info.file_size > MAX_AUDIO_BYTES:
                raise SubmissionError("解压后的音乐文件超过 100 MB。")
            if info.file_size / max(info.compress_size, 1) > 200:
                raise SubmissionError("ZIP 压缩比例异常。")
            if Path(parts[-1]).suffix.lower() in ALLOWED_AUDIO_EXTENSIONS:
                candidates.append(info)

        if len(candidates) != 1:
            raise SubmissionError("ZIP 必须且只能包含一个受支持的音乐文件。")

        info = candidates[0]
        suffix = Path(info.filename).suffix.lower()
        destination = destination_dir / f"source{suffix}"
        with source_zip.open(info) as source, destination.open("wb") as target:
            shutil.copyfileobj(source, target, length=1024 * 1024)
        if destination.stat().st_size != info.file_size:
            raise SubmissionError("解压后的文件大小校验失败。")
        return destination


def probe_duration(audio_path: Path) -> float:
    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_entries",
            "format=duration",
            "-of",
            "json",
            str(audio_path),
        ],
        capture_output=True,
        text=True,
        check=False,
        timeout=60,
    )
    if result.returncode != 0:
        raise SubmissionError("FFprobe 无法识别该音乐文件。")
    try:
        duration = float(json.loads(result.stdout)["format"]["duration"])
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise SubmissionError("无法读取音乐时长。") from exc
    if not 0 < duration <= MAX_DURATION_SECONDS:
        raise SubmissionError("音乐时长必须大于 0 秒且不超过 10 分钟。")
    return duration


def transcode_audio(source: Path, destination: Path) -> None:
    result = subprocess.run(
        [
            "ffmpeg",
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(source),
            "-map",
            "0:a:0",
            "-vn",
            "-ac",
            "2",
            "-ar",
            "48000",
            "-c:a",
            "libvorbis",
            "-q:a",
            "4",
            "-y",
            str(destination),
        ],
        capture_output=True,
        text=True,
        check=False,
        timeout=180,
    )
    if result.returncode != 0 or not destination.is_file():
        raise SubmissionError("FFmpeg 转码失败。")


def create_resource_pack(output_dir: Path, ogg_path: Path, song_id: str, song_name: str) -> tuple[Path, str, str]:
    pack_root = output_dir / "pack"
    sound_dir = pack_root / "assets" / "musicmc" / "sounds" / "music"
    sound_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(ogg_path, sound_dir / f"{song_id}.ogg")

    pack_meta = {
        "pack": {
            "pack_format": 75,
            "description": f"MusicMC: {song_name}",
        }
    }
    (pack_root / "pack.mcmeta").write_text(
        json.dumps(pack_meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    sound_event = f"music.{song_id}"
    sounds_json = {
        sound_event: {
            "sounds": [
                {
                    "name": f"musicmc:music/{song_id}",
                    "stream": True,
                }
            ]
        }
    }
    (pack_root / "assets" / "musicmc" / "sounds.json").write_text(
        json.dumps(sounds_json, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    pack_path = output_dir / f"musicmc-{song_id}.zip"
    with zipfile.ZipFile(pack_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as pack_zip:
        for file_path in sorted(path for path in pack_root.rglob("*") if path.is_file()):
            pack_zip.write(file_path, file_path.relative_to(pack_root).as_posix())

    pack_sha1 = hashlib.sha1(pack_path.read_bytes()).hexdigest()
    return pack_path, pack_sha1, f"musicmc:{sound_event}"


def write_text(path: Path, value: str) -> None:
    path.write_text(value.rstrip() + "\n", encoding="utf-8")


def process(args: argparse.Namespace) -> None:
    event = json.loads(Path(args.event).read_text(encoding="utf-8"))
    issue = event.get("issue") or {}
    issue_number = int(issue["number"])
    github_uploader = str((issue.get("user") or {})["login"])
    sections = parse_sections(str(issue.get("body") or ""))

    ticket = require_section(sections, "上传凭证")
    song_name = normalize_text(require_section(sections, "歌曲名称"))
    player_name = normalize_text(require_section(sections, "Minecraft 玩家名"))
    attachment_field = require_section(sections, "音乐 ZIP 文件")
    if not 1 <= len(song_name) <= 48 or "\n" in song_name:
        raise SubmissionError("歌曲名称长度必须为 1 到 48 个字符。")
    if not re.fullmatch(r"[A-Za-z0-9_]{3,16}", player_name):
        raise SubmissionError("Minecraft 玩家名格式无效。")

    public_key = Path(args.public_key).resolve()
    payload = verify_ticket(ticket, public_key, song_name, player_name)
    attachment_url = find_attachment_url(attachment_field)

    output_dir = Path(args.output).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    archive_path = output_dir / "submission.zip"
    download_attachment(attachment_url, archive_path)
    source_audio = extract_audio(archive_path, output_dir)
    duration = probe_duration(source_audio)

    ogg_path = output_dir / "song.ogg"
    transcode_audio(source_audio, ogg_path)
    audio_sha256 = hashlib.sha256(ogg_path.read_bytes()).hexdigest()
    song_id = f"song_{issue_number}_{audio_sha256[:12]}"
    pack_path, pack_sha1, sound_key = create_resource_pack(output_dir, ogg_path, song_id, song_name)
    source_archive_path = output_dir / f"musicmc-{song_id}-source.zip"
    archive_path.replace(source_archive_path)
    source_archive_sha256 = hashlib.sha256(source_archive_path.read_bytes()).hexdigest()

    manifest_path = output_dir / f"musicmc-{song_id}.json"
    manifest = {
        "schema_version": 1,
        "issue_number": issue_number,
        "release_tag": args.release_tag,
        "song_id": song_id,
        "display_name": song_name,
        "minecraft_player_name": player_name,
        "minecraft_player_uuid": str(payload["player_uuid"]),
        "ticket_nonce": str(payload["nonce"]),
        "github_uploader": github_uploader,
        "duration_seconds": round(duration, 3),
        "sound_key": sound_key,
        "pack_file": pack_path.name,
        "pack_sha1": pack_sha1,
        "audio_sha256": audio_sha256,
        "source_attachment_url": attachment_url,
        "source_archive_file": source_archive_path.name,
        "source_archive_sha256": source_archive_sha256,
        "created_at_epoch": int(time.time()),
    }
    write_text(manifest_path, json.dumps(manifest, ensure_ascii=False, indent=2))

    write_text(
        output_dir / "release-notes.md",
        f"MusicMC processed song **{song_name}** for Minecraft player `{player_name}`.\n\n"
        f"Source submission: #{issue_number}",
    )
    write_text(
        output_dir / "success-comment.md",
        f"处理完成：**{song_name}**\n\n"
        f"- Minecraft 玩家：`{player_name}`\n"
        f"- 时长：`{duration:.1f}` 秒\n"
        f"- 声音键：`{sound_key}`\n"
        f"- 资源包 SHA-1：`{pack_sha1}`\n\n"
        "Minecraft 服务器将在下一次同步时读取此 Release。",
    )
    write_text(
        output_dir / "action-output.env",
        f"RELEASE_TAG={args.release_tag}\nPACK_PATH={pack_path}\n"
        f"MANIFEST_PATH={manifest_path}\nSOURCE_ARCHIVE_PATH={source_archive_path}",
    )
    print(json.dumps(manifest, ensure_ascii=False))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--event", required=True)
    parser.add_argument("--public-key", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--release-tag", required=True)
    args = parser.parse_args()

    output_dir = Path(args.output)
    try:
        process(args)
        return 0
    except SubmissionError as exc:
        output_dir.mkdir(parents=True, exist_ok=True)
        write_text(output_dir / "error-comment.md", f"MusicMC 拒绝了这个上传：{exc}")
        print(f"submission rejected: {exc}", file=sys.stderr)
        return 2
    except Exception:
        output_dir.mkdir(parents=True, exist_ok=True)
        write_text(
            output_dir / "error-comment.md",
            "MusicMC 处理任务发生内部错误。请让服务器管理员检查 GitHub Actions 日志。",
        )
        raise


if __name__ == "__main__":
    raise SystemExit(main())
