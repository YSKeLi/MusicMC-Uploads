import assert from "node:assert/strict";
import test from "node:test";
import {
  commandForSong,
  filterSongs,
  formatDuration,
  parseCatalog,
} from "../docs/catalog.mjs";

const songs = parseCatalog({
  schema_version: 1,
  songs: [
    { display_name: "晴天", minecraft_player_name: "Steve", duration_seconds: 243.2 },
    { display_name: "abc", minecraft_player_name: "Alex", duration_seconds: 61 },
  ],
});

test("parses and sorts published songs", () => {
  assert.deepEqual(songs.map((song) => song.displayName), ["晴天", "abc"]);
  assert.equal(formatDuration(songs.find((song) => song.displayName === "abc").durationSeconds), "1:01");
});

test("builds the exact getCD command", () => {
  assert.equal(commandForSong("晴天"), "/getCD 晴天");
});

test("filters by song and uploader", () => {
  assert.deepEqual(filterSongs(songs, "晴").map((song) => song.displayName), ["晴天"]);
  assert.deepEqual(filterSongs(songs, "alex").map((song) => song.displayName), ["abc"]);
});

test("rejects malformed catalogs", () => {
  assert.throws(() => parseCatalog({ schema_version: 2, songs: [] }));
});
