# MusicMC Uploads

This repository receives signed music submissions from the MusicMC server and
publishes immutable Minecraft 1.21.11 resource packs.

## Player workflow

1. Run `/music upload <song name>` in Minecraft.
2. Open the MusicMC upload portal returned by the server.
3. Confirm the pre-filled ticket, song name, and player name, then continue to GitHub and attach one ZIP file.
4. Wait for the issue to be marked `music-ready` or `music-rejected`.

The upload portal is hosted at <https://yskeli.github.io/>.

The ZIP must be at most 25 MB and contain exactly one MP3, M4A, AAC, WAV, FLAC,
OGG, or OPUS file. The processed song may be at most 10 minutes long.

## Automation

The `process-music-submission` workflow verifies the server-signed ticket,
validates the archive, transcodes the audio to OGG Vorbis, creates a resource
pack, and publishes the pack and its manifest as an immutable GitHub Release.

No personal access token is stored in this repository. GitHub Actions publishes
releases using the repository-scoped, short-lived `GITHUB_TOKEN` issued for each
workflow job.

Minecraft servers synchronize without API authentication from:

`https://raw.githubusercontent.com/YSKeLi/MusicMC-Uploads/main/catalog.json`

## Privacy and rights

This is a public repository. Issue contents and uploaded attachments are public.
Only upload audio that you own or are authorized to distribute.
