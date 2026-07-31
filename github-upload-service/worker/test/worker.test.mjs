import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { buildIssueBody, handleRequest, verifyTicket } from "../src/index.js";

const encoder = new TextEncoder();
const now = Math.floor(Date.now() / 1000);

function makeTicket(overrides = {}) {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const payload = {
    v: 1,
    player_uuid: "00000000-0000-0000-0000-000000000001",
    player_name: "TestPlayer",
    song_name: "晴天",
    exp: now + 300,
    nonce: "0123456789abcdef0123456789abcdef",
    ...overrides,
  };
  const payloadBytes = encoder.encode(JSON.stringify(payload));
  const signature = sign("sha256", payloadBytes, privateKey);
  return {
    ticket: `MUS1.${Buffer.from(payloadBytes).toString("base64url")}.${signature.toString("base64url")}`,
    payload,
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
  };
}

function bindings(fixture) {
  return {
    GITHUB_TOKEN: "test-token",
    GITHUB_REPOSITORY: "example/musicmc",
    GITHUB_BRANCH: "main",
    ALLOWED_ORIGIN: "https://music.example.com",
    UPLOAD_PUBLIC_KEY: fixture.publicKeyPem,
  };
}

function githubMock(calls, pending = [], catalogValue = { schema_version: 2, bundles: [], songs: [] }) {
  const catalog = Buffer.from(JSON.stringify(catalogValue)).toString("base64");
  return async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("/contents/catalog.json")) return Response.json({ content: catalog });
    if (String(url).includes("/issues?state=open")) return Response.json(pending);
    if (String(url).endsWith("/releases")) return Response.json({ id: 42 }, { status: 201 });
    if (String(url).startsWith("https://uploads.github.com/")) {
      return Response.json({
        browser_download_url: "https://github.com/example/musicmc/releases/download/upload-0123456789abcdef0123456789abcdef/submission-0123456789abcdef0123456789abcdef.zip",
      }, { status: 201 });
    }
    if (String(url).endsWith("/issues")) {
      return Response.json({ number: 12, html_url: "https://github.com/example/issues/12" }, { status: 201 });
    }
    throw new Error(`Unexpected URL ${url}`);
  };
}

test("verifies Java-compatible DER ECDSA tickets", async () => {
  const fixture = makeTicket();
  assert.deepEqual(await verifyTicket(fixture.ticket, fixture.publicKeyPem, now), fixture.payload);
});

test("selects a public key from the rotation registry", async () => {
  const fixture = makeTicket({ key_id: "key-2026" });
  const registry = JSON.stringify({ "key-2026": fixture.publicKeyPem });
  assert.deepEqual(await verifyTicket(fixture.ticket, registry, now), fixture.payload);
});

test("rejects an expired ticket", async () => {
  const fixture = makeTicket({ exp: now - 1 });
  await assert.rejects(verifyTicket(fixture.ticket, fixture.publicKeyPem, now), /已经过期/);
});

test("builds an issue contract without a confirmation checkbox", () => {
  const fixture = makeTicket();
  const body = buildIssueBody(fixture.ticket, fixture.payload, {
    kind: "upload", assetUrl: "https://example.test/song.zip", filename: "任意名称.zip",
  });
  assert.match(body, /^### Music ZIP file\n\n\[任意名称\.zip\]/m);
  assert.match(body, /musicmc-player:00000000/);
  assert.doesNotMatch(body, /\[[ x]\]/i);
});

test("fails closed when deployment bindings are missing", async () => {
  const response = await handleRequest(new Request("https://upload.example/upload"), {});
  assert.equal(response.status, 503);
});

test("accepts any safe ZIP filename and creates an automatic task", async () => {
  const fixture = makeTicket();
  const calls = [];
  const bytes = encoder.encode("PK test archive");
  const request = new Request("https://upload.example/upload", {
    method: "POST",
    headers: {
      Origin: "https://music.example.com",
      "Content-Type": "application/zip",
      "Content-Length": String(bytes.length),
      "X-MusicMC-Ticket": fixture.ticket,
      "X-MusicMC-Filename": encodeURIComponent("不是歌曲名.zip"),
    },
    body: bytes,
  });
  const response = await handleRequest(request, bindings(fixture), { fetch: githubMock(calls) });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).issue_number, 12);
  assert.equal(calls.length, 5);
  const issueRequest = JSON.parse(calls[4].init.body);
  assert.equal(issueRequest.labels[0], "music-pending");
  assert.match(issueRequest.body, /不是歌曲名\.zip/);
});

test("creates NetEase tasks without uploading audio through the Worker", async () => {
  const fixture = makeTicket();
  const calls = [];
  const request = new Request("https://upload.example/netease", {
    method: "POST",
    headers: { Origin: "https://music.example.com", "Content-Type": "application/json",
      "X-MusicMC-Ticket": fixture.ticket },
    body: JSON.stringify({ song_id: "186016" }),
  });
  const response = await handleRequest(request, bindings(fixture), { fetch: githubMock(calls) });
  assert.equal(response.status, 201);
  assert.equal(calls.length, 3);
  assert.match(JSON.parse(calls[2].init.body).body, /### NetEase song ID\n\n186016/);
});

test("allows unlimited history but blocks a second active task for one player", async () => {
  const fixture = makeTicket();
  const pending = [{ body: "<!-- musicmc-player:00000000-0000-0000-0000-000000000001 -->" }];
  const request = new Request("https://upload.example/netease", {
    method: "POST",
    headers: { Origin: "https://music.example.com", "Content-Type": "application/json",
      "X-MusicMC-Ticket": fixture.ticket },
    body: JSON.stringify({ song_id: "186016" }),
  });
  const response = await handleRequest(request, bindings(fixture), { fetch: githubMock([], pending) });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /正在处理/);
});

test("allows an administrator-signed replacement of only the bound song", async () => {
  const fixture = makeTicket({ replace_song_id: "song_1", replace_revision: 2 });
  const catalog = {
    schema_version: 2,
    bundles: [],
    songs: [{ song_id: "song_1", command_name: "晴天", revision: 1 }],
  };
  const calls = [];
  const request = new Request("https://upload.example/netease", {
    method: "POST",
    headers: { Origin: "https://music.example.com", "Content-Type": "application/json",
      "X-MusicMC-Ticket": fixture.ticket },
    body: JSON.stringify({ song_id: "186016" }),
  });
  const response = await handleRequest(request, bindings(fixture), {
    fetch: githubMock(calls, [], catalog),
  });
  assert.equal(response.status, 201);
});
