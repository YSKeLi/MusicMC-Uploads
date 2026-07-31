#!/usr/bin/env python3
"""Validate a signed MusicMC submission and create streamable OGG segments."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
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
SEGMENT_SECONDS = 5
ALLOWED_AUDIO_EXTENSIONS = {".mp3", ".m4a", ".aac", ".wav", ".flac", ".ogg", ".opus"}
ALLOWED_ATTACHMENT_HOSTS = {"user-images.githubusercontent.com", "objects.githubusercontent.com"}
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


def section(sections: dict[str, str], *names: str, required: bool = True) -> str:
    for name in names:
        value = sections.get(name)
        if value:
            return value
    if required:
        raise SubmissionError(f"Issue 缺少必填字段：{names[0]}。")
    return ""


def verify_ticket(ticket: str, public_key: Path, song_name: str, player_name: str) -> dict:
    parts = normalize_text(ticket).split(".")
    if len(parts) != 3 or parts[0] != "MUS1":
        raise SubmissionError("上传凭证格式无效，请回到服务器重新生成。")

    payload_bytes = decode_base64url(parts[1])
    signature = decode_base64url(parts[2])
    try:
        payload = json.loads(payload_bytes)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise SubmissionError("上传凭证内容无效。") from exc
    selected_key = public_key
    temporary_key: Path | None = None
    if public_key.suffix.lower() == ".json":
        registry = json.loads(public_key.read_text(encoding="utf-8"))
        key_id = str(payload.get("key_id") or "default")
        pem = registry.get(key_id)
        if not isinstance(pem, str) or "BEGIN PUBLIC KEY" not in pem:
            raise SubmissionError("上传凭证使用的签名密钥不受支持。")
        temporary_key = public_key.parent / ".ticket-public-key.tmp"
        temporary_key.write_text(pem, encoding="ascii")
        selected_key = temporary_key
    work_dir = public_key.parent
    payload_path = work_dir / ".ticket-payload.tmp"
    signature_path = work_dir / ".ticket-signature.tmp"
    payload_path.write_bytes(payload_bytes)
    signature_path.write_bytes(signature)
    try:
        result = subprocess.run(
            ["openssl", "dgst", "-sha256", "-verify", str(selected_key),
             "-signature", str(signature_path), str(payload_path)],
            capture_output=True, text=True, check=False,
        )
    finally:
        payload_path.unlink(missing_ok=True)
        signature_path.unlink(missing_ok=True)
        if temporary_key is not None:
            temporary_key.unlink(missing_ok=True)
    if result.returncode != 0:
        raise SubmissionError("上传凭证签名无效。")

    required = {"v", "player_uuid", "player_name", "song_name", "exp", "nonce"}
    if not isinstance(payload, dict) or not required.issubset(payload) or payload["v"] != 1:
        raise SubmissionError("上传凭证版本或内容无效。")
    now = int(time.time())
    try:
        expires_at = int(payload["exp"])
    except (TypeError, ValueError) as exc:
        raise SubmissionError("上传凭证过期时间无效。") from exc
    if expires_at < now:
        raise SubmissionError("上传凭证已经过期，请回到服务器重新生成。")
    if expires_at > now + 3600:
        raise SubmissionError("上传凭证有效期异常。")
    if normalize_text(str(payload["song_name"])) != song_name:
        raise SubmissionError("歌曲名称与上传凭证不一致。")
    if normalize_text(str(payload["player_name"])).casefold() != player_name.casefold():
        raise SubmissionError("Minecraft 玩家名与上传凭证不一致。")
    return payload


def automated_release_pattern(repository: str) -> re.Pattern[str]:
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
        raise SubmissionError("GitHub 仓库信息无效。")
    return re.compile(
        rf"^/{re.escape(repository)}/releases/download/"
        r"upload-([0-9a-f]{32})/submission-\1\.zip$",
        re.IGNORECASE,
    )


def find_attachment_url(field_value: str, repository: str) -> str:
    release_pattern = automated_release_pattern(repository)
    for candidate in ATTACHMENT_PATTERN.findall(field_value):
        candidate = candidate.rstrip(".,]")
        parsed = urllib.parse.urlparse(candidate)
        trusted_attachment = parsed.hostname in ALLOWED_ATTACHMENT_HOSTS
        trusted_staging = parsed.hostname == "github.com" and release_pattern.fullmatch(parsed.path)
        if parsed.scheme == "https" and (trusted_attachment or trusted_staging):
            return candidate
    raise SubmissionError("没有找到有效的 GitHub ZIP 附件地址。")


def download_limited(url: str, destination: Path, maximum: int, label: str) -> None:
    request = urllib.request.Request(url, headers={"User-Agent": "MusicMC-Submission-Processor/2"})
    try:
        with urllib.request.urlopen(request, timeout=90) as response, destination.open("wb") as target:
            declared = response.headers.get("Content-Length")
            if declared and int(declared) > maximum:
                raise SubmissionError(f"{label}超过大小限制。")
            total = 0
            while chunk := response.read(1024 * 1024):
                total += len(chunk)
                if total > maximum:
                    raise SubmissionError(f"{label}超过大小限制。")
                target.write(chunk)
    except SubmissionError:
        raise
    except Exception as exc:
        raise SubmissionError(f"无法下载{label}。") from exc


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
                raise SubmissionError("解压后的音频不能超过 100 MB。")
            if info.file_size / max(info.compress_size, 1) > 200:
                raise SubmissionError("ZIP 压缩比例异常。")
            if Path(parts[-1]).suffix.lower() in ALLOWED_AUDIO_EXTENSIONS:
                candidates.append(info)
        if len(candidates) != 1:
            raise SubmissionError("ZIP 必须且只能包含一个受支持的音频文件。")
        info = candidates[0]
        destination = destination_dir / f"source{Path(info.filename).suffix.lower()}"
        with source_zip.open(info) as source, destination.open("wb") as target:
            shutil.copyfileobj(source, target, length=1024 * 1024)
        if destination.stat().st_size != info.file_size:
            raise SubmissionError("解压后的文件大小校验失败。")
        return destination


def probe_duration(audio_path: Path) -> float:
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries",
         "format=duration", "-of", "json", str(audio_path)],
        capture_output=True, text=True, check=False, timeout=60,
    )
    if result.returncode != 0:
        raise SubmissionError("FFprobe 无法识别该音频。")
    try:
        duration = float(json.loads(result.stdout)["format"]["duration"])
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise SubmissionError("无法读取音频时长。") from exc
    if not 0 < duration <= MAX_DURATION_SECONDS:
        raise SubmissionError("音频时长必须大于 0 秒且不超过 10 分钟。")
    return duration


def transcode_audio(source: Path, destination: Path) -> None:
    result = subprocess.run(
        ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-i", str(source),
         "-map", "0:a:0", "-vn", "-ac", "2", "-ar", "48000", "-c:a", "libvorbis",
         "-q:a", "4", "-filter:a", "volume=0.64", "-y", str(destination)],
        capture_output=True, text=True, check=False, timeout=240,
    )
    if result.returncode != 0 or not destination.is_file():
        raise SubmissionError("FFmpeg 转码失败。")


def segment_audio(source_ogg: Path, output_dir: Path, song_id: str) -> list[dict[str, object]]:
    segments_dir = output_dir / "segments"
    segments_dir.mkdir(parents=True, exist_ok=True)
    pattern = segments_dir / "part%03d.ogg"
    result = subprocess.run(
        ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-i", str(source_ogg),
         "-map", "0:a:0", "-c", "copy", "-f", "segment", "-segment_time", str(SEGMENT_SECONDS),
         "-reset_timestamps", "1", "-y", str(pattern)],
        capture_output=True, text=True, check=False, timeout=180,
    )
    files = sorted(segments_dir.glob("part*.ogg"))
    if result.returncode != 0 or not files:
        raise SubmissionError("音频分片失败。")
    segments: list[dict[str, object]] = []
    for index, path in enumerate(files):
        segments.append({
            "sound_key": f"musicmc:music.{song_id}.part{index:03d}",
            "duration_seconds": round(probe_duration(path), 3),
            "file": path.name,
        })
    return segments


def fetch_netease_source(adapter: Path, event: Path, output_dir: Path) -> tuple[Path, dict]:
    metadata_path = output_dir / "netease.json"
    result = subprocess.run(
        ["node", str(adapter), "--event", str(event), "--output", str(output_dir),
         "--metadata", str(metadata_path)],
        capture_output=True, text=True, check=False, timeout=180,
    )
    if result.returncode != 0:
        raise SubmissionError("网易云音频获取失败；Cookie 可能过期、账号无权限或触发了风控。")
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    source = output_dir / str(metadata["file"])
    if not source.is_file() or source.stat().st_size > MAX_AUDIO_BYTES:
        raise SubmissionError("网易云返回的音频文件无效或超过 100 MB。")
    return source, metadata


def write_text(path: Path, value: str) -> None:
    path.write_text(value.rstrip() + "\n", encoding="utf-8")


def process(args: argparse.Namespace) -> None:
    event_path = Path(args.event).resolve()
    event = json.loads(event_path.read_text(encoding="utf-8"))
    repository = str((event.get("repository") or {}).get("full_name") or "")
    issue = event.get("issue") or {}
    issue_number = int(issue["number"])
    github_uploader = str((issue.get("user") or {}).get("login") or "automation")
    sections = parse_sections(str(issue.get("body") or ""))

    ticket = section(sections, "Upload ticket", "上传凭证")
    song_name = normalize_text(section(sections, "Song name", "歌曲名称"))
    player_name = normalize_text(section(sections, "Minecraft player", "Minecraft 玩家名"))
    source_kind = normalize_text(section(sections, "Source type", "来源类型", required=False) or "upload").casefold()
    if not 1 <= len(song_name) <= 48 or "\n" in song_name:
        raise SubmissionError("歌曲名称长度必须为 1 到 48 个字符。")
    if not re.fullmatch(r"[A-Za-z0-9_]{3,16}", player_name):
        raise SubmissionError("Minecraft 玩家名格式无效。")
    payload = verify_ticket(ticket, Path(args.public_key).resolve(), song_name, player_name)

    output_dir = Path(args.output).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    source_info: dict[str, object]
    source_archive_path: Path | None = None
    artist = ""
    provider_title = song_name
    if source_kind == "netease":
        if not args.netease_adapter:
            raise SubmissionError("Actions 未配置网易云内部适配器。")
        source_audio, metadata = fetch_netease_source(
            Path(args.netease_adapter).resolve(), event_path, output_dir)
        artist = str(metadata.get("artist") or "")[:96]
        provider_title = str(metadata.get("title") or song_name)[:96]
        provider_id = str(metadata["provider_id"])
        source_info = {
            "kind": "netease",
            "provider_id": provider_id,
            "provider_url": f"https://music.163.com/song?id={provider_id}",
            "archive_file": None,
            "archive_sha256": None,
        }
    elif source_kind == "upload":
        attachment = section(sections, "Music ZIP file", "音乐 ZIP 文件")
        attachment_url = find_attachment_url(attachment, repository)
        archive_path = output_dir / "submission.zip"
        download_limited(attachment_url, archive_path, MAX_ARCHIVE_BYTES, "ZIP 文件")
        source_audio = extract_audio(archive_path, output_dir)
        source_archive_path = output_dir / f"musicmc-submission-{issue_number}-source.zip"
        archive_path.replace(source_archive_path)
        source_info = {
            "kind": "upload",
            "provider_id": str(issue_number),
            "provider_url": f"https://github.com/{repository}/issues/{issue_number}",
            "archive_file": source_archive_path.name,
            "archive_sha256": hashlib.sha256(source_archive_path.read_bytes()).hexdigest(),
        }
    else:
        raise SubmissionError("不支持的音频来源。")

    duration = probe_duration(source_audio)
    ogg_path = output_dir / "song.ogg"
    transcode_audio(source_audio, ogg_path)
    audio_sha256 = hashlib.sha256(ogg_path.read_bytes()).hexdigest()
    replacement_song_id = payload.get("replace_song_id")
    if replacement_song_id is not None:
        if not re.fullmatch(r"[a-z0-9_-]{1,96}", str(replacement_song_id)):
            raise SubmissionError("替换凭证中的歌曲 ID 无效。")
        song_id = str(replacement_song_id)
        revision = int(payload.get("replace_revision", 0))
        if revision < 2:
            raise SubmissionError("替换凭证中的版本号无效。")
    else:
        song_id = f"song_{issue_number}_{audio_sha256[:12]}"
        revision = 1
    segments = segment_audio(ogg_path, output_dir, song_id)

    manifest_path = output_dir / f"musicmc-{song_id}.json"
    manifest = {
        "schema_version": 2,
        "issue_number": issue_number,
        "song_id": song_id,
        "revision": revision,
        "command_name": song_name,
        "display_name": provider_title if source_kind == "netease" else song_name,
        "artist": artist,
        "enabled": True,
        "minecraft_player_name": player_name,
        "minecraft_player_uuid": str(payload["player_uuid"]),
        "ticket_nonce": str(payload["nonce"]),
        "github_uploader": github_uploader,
        "duration_seconds": round(sum(float(item["duration_seconds"]) for item in segments), 3),
        "segments": segments,
        "audio_sha256": audio_sha256,
        "source": source_info,
        "created_at_epoch": int(time.time()),
    }
    write_text(manifest_path, json.dumps(manifest, ensure_ascii=False, indent=2))
    write_text(
        output_dir / "release-notes.md",
        f"MusicMC 自动处理歌曲 **{song_name}**（Minecraft 玩家 `{player_name}`）。\n\n"
        f"来源任务：#{issue_number}",
    )
    write_text(
        output_dir / "success-comment.md",
        f"处理完成：**{song_name}**\n\n- Minecraft 玩家：`{player_name}`\n"
        f"- 来源：`{source_kind}`\n- 时长：`{duration:.1f}` 秒\n- 分片数：`{len(segments)}`\n\n"
        "Minecraft 服务器会在下一次目录同步后提供这首歌。",
    )
    archive_output = str(source_archive_path) if source_archive_path else ""
    write_text(
        output_dir / "action-output.env",
        f"MANIFEST_PATH={manifest_path}\nSOURCE_ARCHIVE_PATH={archive_output}",
    )
    print(json.dumps(manifest, ensure_ascii=False))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--event", required=True)
    parser.add_argument("--public-key", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--netease-adapter")
    args = parser.parse_args()
    output_dir = Path(args.output)
    try:
        process(args)
        return 0
    except SubmissionError as exc:
        output_dir.mkdir(parents=True, exist_ok=True)
        write_text(output_dir / "error-comment.md", f"MusicMC 拒绝了这个投稿：{exc}")
        print(f"submission rejected: {exc}", file=sys.stderr)
        return 2
    except Exception:
        output_dir.mkdir(parents=True, exist_ok=True)
        write_text(output_dir / "error-comment.md", "MusicMC 处理任务发生内部错误，请检查 GitHub Actions 日志。")
        raise


if __name__ == "__main__":
    raise SystemExit(main())
