# MusicMC Uploads

This repository receives signed music submissions from the MusicMC server and
publishes immutable Minecraft 1.21.11 resource packs.

## Player workflow

1. Run `/music upload <song name>` in Minecraft.
2. Open the MusicMC upload portal returned by the server.
3. Select the ZIP whose filename exactly matches the song name and click **上传并提交**.
4. Wait for the issue to be marked `music-ready` or `music-rejected`.

Players do not need a GitHub account. The upload portal creates the processing
Issue automatically through the serverless upload Worker.

The upload portal is hosted at <https://yskeli.github.io/>.

The ZIP must be at most 25 MB and contain exactly one MP3, M4A, AAC, WAV, FLAC,
OGG, or OPUS file. The processed song may be at most 10 minutes long.

## Automation

The `process-music-submission` workflow verifies the server-signed ticket,
validates the archive, transcodes the audio to OGG Vorbis, creates a resource
pack, and publishes the pack and its manifest as an immutable GitHub Release.
The original submitted ZIP is also copied into that Release with a SHA-256 value
in the catalog, allowing Minecraft servers to archive it through a verified
download proxy instead of relying on `github.com/user-attachments`.

No personal access token is stored in this repository or in the Pages site. A
fine-grained token is stored only as the Cloudflare Worker secret `GITHUB_TOKEN`
and the GitHub Actions repository secret `MUSICMC_AUTOMATION_TOKEN`. This makes
the staging Release, processing Issue, final Release, comments, and catalog
commit use the repository owner's GitHub identity.

Minecraft servers synchronize without API authentication from:

`https://raw.githubusercontent.com/YSKeLi/MusicMC-Uploads/main/catalog.json`

## Upload Worker deployment

Create one fine-grained GitHub personal access token restricted to
`YSKeLi/MusicMC-Uploads`, with repository permissions **Contents: Read and
write** and **Issues: Read and write**. Then configure it without writing it to
any file:

```powershell
cd worker
npm install
npx wrangler login
npx wrangler secret put GITHUB_TOKEN
npx wrangler deploy
gh secret set MUSICMC_AUTOMATION_TOKEN --repo YSKeLi/MusicMC-Uploads
```

Set the resulting Worker origin in `docs/config.js`, for example
`https://musicmc-upload.<account>.workers.dev`, then publish the Pages files.
The Worker accepts ZIP files only from `https://yskeli.github.io`, verifies the
P-256 server signature, enforces the 25 MB limit, and streams the body to GitHub
without buffering it in memory.

## Privacy and rights

This is a public repository. Issue contents and uploaded attachments are public.
Only upload audio that you own or are authorized to distribute.
