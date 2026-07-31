#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  song_detail: songDetail,
  song_url_v1: songUrlV1,
} = require("@neteasecloudmusicapienhanced/api");

const MAX_AUDIO_BYTES = 100 * 1024 * 1024;

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) {
    throw new Error(`Missing ${name}`);
  }
  return process.argv[index + 1];
}

function parseSections(body) {
  const sections = new Map();
  const headings = [...body.matchAll(/^###\s+(.+?)\s*$/gm)];
  for (let index = 0; index < headings.length; index += 1) {
    const match = headings[index];
    const start = match.index + match[0].length;
    const end = headings[index + 1]?.index ?? body.length;
    sections.set(match[1].normalize("NFKC").trim(), body.slice(start, end).trim());
  }
  return sections;
}

function requireSection(sections, ...names) {
  for (const name of names) {
    if (sections.get(name)) return sections.get(name);
  }
  throw new Error(`Issue is missing ${names[0]}`);
}

async function download(url, destination) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error("NetEase returned a non-HTTPS media URL");
  const response = await fetch(parsed, {
    redirect: "follow",
    headers: {
      "User-Agent": "Mozilla/5.0 MusicMC-Actions-Adapter/1",
      Referer: "https://music.163.com/",
    },
  });
  if (!response.ok || !response.body) throw new Error(`Media download failed (${response.status})`);
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > MAX_AUDIO_BYTES) throw new Error("Media file exceeds 100 MB");
  const output = fs.createWriteStream(destination, { flags: "wx" });
  let total = 0;
  try {
    for await (const chunk of response.body) {
      total += chunk.length;
      if (total > MAX_AUDIO_BYTES) throw new Error("Media file exceeds 100 MB");
      if (!output.write(chunk)) await new Promise((resolve) => output.once("drain", resolve));
    }
    await new Promise((resolve, reject) => output.end((error) => error ? reject(error) : resolve()));
  } catch (error) {
    output.destroy();
    fs.rmSync(destination, { force: true });
    throw error;
  }
  if (total < 1024) throw new Error("NetEase returned an empty media file");
}

async function main() {
  const event = JSON.parse(fs.readFileSync(argument("--event"), "utf8"));
  const outputDirectory = path.resolve(argument("--output"));
  const metadataPath = path.resolve(argument("--metadata"));
  const sections = parseSections(String(event.issue?.body || ""));
  const providerId = requireSection(sections, "NetEase song ID", "网易云歌曲 ID").trim();
  if (!/^[1-9][0-9]{0,19}$/.test(providerId)) throw new Error("Invalid NetEase song ID");
  const cookie = String(process.env.NETEASE_COOKIE || "").trim();
  if (!cookie) throw new Error("NETEASE_COOKIE is not configured");

  const [details, media] = await Promise.all([
    songDetail({ ids: providerId, cookie }),
    songUrlV1({ id: providerId, level: "exhigh", cookie }),
  ]);
  const song = details?.body?.songs?.[0];
  const mediaEntry = media?.body?.data?.[0];
  if (!song || String(song.id) !== providerId) throw new Error("NetEase song does not exist");
  if (!mediaEntry?.url) throw new Error("The account cannot obtain a playable URL for this song");

  const extension = /^[a-z0-9]{2,5}$/i.test(mediaEntry.type || "")
    ? String(mediaEntry.type).toLowerCase()
    : "mp3";
  fs.mkdirSync(outputDirectory, { recursive: true });
  const filename = `netease-source.${extension}`;
  await download(mediaEntry.url, path.join(outputDirectory, filename));
  const metadata = {
    provider_id: providerId,
    title: String(song.name || providerId),
    artist: Array.isArray(song.ar) ? song.ar.map((artist) => artist.name).filter(Boolean).join(" / ") : "",
    file: filename,
  };
  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}

main().catch((error) => {
  console.error(`NetEase adapter failed: ${error.message}`);
  process.exitCode = 2;
});
