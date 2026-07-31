import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { commandForSong, filterSongs, formatDuration, parseCatalog } from "../docs/catalog.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

const songs = parseCatalog({
  schema_version: 2,
  bundles: [],
  songs: [
    { command_name: "qing-tian", display_name: "晴天", artist: "周杰伦", enabled: true,
      minecraft_player_name: "Steve", duration_seconds: 243.2, source: { kind: "netease" } },
    { command_name: "abc", display_name: "abc", enabled: true,
      minecraft_player_name: "Alex", duration_seconds: 61, source: { kind: "upload" } },
    { command_name: "hidden", display_name: "Hidden", enabled: false, duration_seconds: 1 },
  ],
});

test("parses, sorts, and hides disabled v2 songs", () => {
  assert.deepEqual(songs.map((song) => song.displayName), ["晴天", "abc"]);
  assert.equal(formatDuration(songs.find((song) => song.displayName === "abc").durationSeconds), "1:01");
});

test("builds the exact lowercase getcd command from command_name", () => {
  assert.equal(commandForSong(songs[0].commandName), "/getcd qing-tian");
});

test("filters by song, artist, command, and uploader", () => {
  assert.deepEqual(filterSongs(songs, "周杰伦").map((song) => song.displayName), ["晴天"]);
  assert.deepEqual(filterSongs(songs, "alex").map((song) => song.displayName), ["abc"]);
});

test("keeps v1 catalogs readable during migration", () => {
  assert.equal(parseCatalog({ schema_version: 1, songs: [{ display_name: "old" }] })[0].commandName, "old");
  assert.throws(() => parseCatalog({ schema_version: 3, songs: [] }));
});

test("uses a separately deployed runtime catalog when configured", async () => {
  globalThis.MUSICMC_CONFIG = {
    catalogUrls: ["https://raw.githubusercontent.com/example/runtime/main/catalog.json"],
  };
  try {
    const configured = await import(`../docs/catalog.mjs?configured=${Date.now()}`);
    assert.deepEqual(configured.CATALOG_URLS, globalThis.MUSICMC_CONFIG.catalogUrls);
  } finally {
    delete globalThis.MUSICMC_CONFIG;
  }
});

test("renders a portal config for separate runtime and Pages repositories", () => {
  const directory = mkdtempSync(join(tmpdir(), "musicmc-site-config-"));
  const output = join(directory, "config.js");
  try {
    const result = spawnSync(process.execPath, [join(ROOT, "scripts/render-site-config.mjs"), output], {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_REPOSITORY: "example/MusicMC-Uploads",
        MUSICMC_UPLOAD_API_URL: "https://musicmc-upload.example-musicmc.workers.dev",
        MUSICMC_CATALOG_URL:
          "https://raw.githubusercontent.com/example/MusicMC-Uploads/main/catalog.json",
        MUSICMC_CATALOG_BRANCH: "main",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const generated = readFileSync(output, "utf8");
    assert.match(generated, /example\/MusicMC-Uploads\/issues\/new/);
    assert.match(generated, /raw\.githubusercontent\.com\/example\/MusicMC-Uploads/);
    assert.match(generated, /cdn\.jsdelivr\.net\/gh\/example\/MusicMC-Uploads@main/);
    assert.doesNotMatch(generated, /OWNER\/REPOSITORY/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
