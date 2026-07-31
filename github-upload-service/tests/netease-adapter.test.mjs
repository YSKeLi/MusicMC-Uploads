import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { fetchTrack, normalizeMediaUrl } = require("../actions/netease-adapter.cjs");

test("uses EAPI for playable URLs and preserves Cookie input", async () => {
  const calls = [];
  const result = await fetchTrack("123", "MUSIC_U=secret", {
    songDetail: async (options) => {
      calls.push(["detail", options]);
      return { body: { songs: [{ id: 123, name: "Test" }] } };
    },
    songUrlV1: async (options) => {
      calls.push(["url", options]);
      return { body: { data: [{ url: "https://music.example/test.mp3", type: "mp3" }] } };
    },
  });

  assert.equal(result.song.name, "Test");
  assert.equal(result.mediaEntry.type, "mp3");
  assert.equal(calls[0][1].cookie, "MUSIC_U=secret");
  assert.deepEqual(calls[1][1], {
    id: "123",
    level: "exhigh",
    crypto: "eapi",
    cookie: "MUSIC_U=secret",
  });
});

test("rejects accounts without a playable URL", async () => {
  await assert.rejects(
    fetchTrack("123", "cookie", {
      songDetail: async () => ({ body: { songs: [{ id: 123 }] } }),
      songUrlV1: async () => ({ body: { data: [{ url: null }] } }),
    }),
    /cannot obtain a playable URL/,
  );
});

test("upgrades trusted NetEase CDN URLs to HTTPS", () => {
  assert.equal(normalizeMediaUrl("http://m801.music.126.net/song.mp3").protocol, "https:");
  assert.throws(() => normalizeMediaUrl("http://example.com/song.mp3"), /unsupported media URL/);
});
