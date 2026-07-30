import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import {
  buildIssueBody,
  handleRequest,
  verifyTicket,
} from "../src/index.js";

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
  const ticket = `MUS1.${Buffer.from(payloadBytes).toString("base64url")}.${signature.toString("base64url")}`;
  return {
    ticket,
    payload,
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
  };
}

test("verifies Java-compatible DER ECDSA tickets", async () => {
  const fixture = makeTicket();
  assert.deepEqual(await verifyTicket(fixture.ticket, fixture.publicKeyPem, now), fixture.payload);
});

test("rejects an expired ticket", async () => {
  const fixture = makeTicket({ exp: now - 1 });
  await assert.rejects(
    verifyTicket(fixture.ticket, fixture.publicKeyPem, now),
    /已经过期/,
  );
});

test("builds the processor issue contract without a confirmation checkbox", () => {
  const fixture = makeTicket();
  const body = buildIssueBody(fixture.ticket, fixture.payload, "https://example.test/song.zip", "晴天.zip");
  assert.match(body, /^### 音乐 ZIP 文件\n\n\[晴天\.zip\]/m);
  assert.doesNotMatch(body, /\[[ x]\]/i);
});

test("streams an accepted ZIP to a release and creates an issue", async () => {
  const fixture = makeTicket();
  const calls = [];
  const catalog = Buffer.from(JSON.stringify({ schema_version: 1, songs: [] })).toString("base64");
  const fetchMock = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("/contents/catalog.json")) {
      return Response.json({ content: catalog });
    }
    if (String(url).endsWith("/releases")) {
      return Response.json({ id: 42 }, { status: 201 });
    }
    if (String(url).startsWith("https://uploads.github.com/")) {
      return Response.json({
        browser_download_url: "https://github.com/YSKeLi/MusicMC-Uploads/releases/download/upload-0123456789abcdef0123456789abcdef/submission-0123456789abcdef0123456789abcdef.zip",
      }, { status: 201 });
    }
    if (String(url).endsWith("/issues")) {
      return Response.json({ number: 12, html_url: "https://github.com/example/issues/12" }, { status: 201 });
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  const bytes = encoder.encode("PK test archive");
  const request = new Request("https://upload.example/upload", {
    method: "POST",
    headers: {
      Origin: "https://yskeli.github.io",
      "Content-Type": "application/zip",
      "Content-Length": String(bytes.length),
      "X-MusicMC-Ticket": fixture.ticket,
      "X-MusicMC-Filename": encodeURIComponent("晴天.zip"),
    },
    body: bytes,
  });

  const response = await handleRequest(request, {
    GITHUB_TOKEN: "test-token",
    GITHUB_REPOSITORY: "YSKeLi/MusicMC-Uploads",
    GITHUB_BRANCH: "main",
    ALLOWED_ORIGIN: "https://yskeli.github.io",
    UPLOAD_PUBLIC_KEY: fixture.publicKeyPem,
  }, { fetch: fetchMock });

  assert.equal(response.status, 201);
  assert.equal((await response.json()).issue_number, 12);
  assert.equal(calls.length, 4);
  assert.equal(calls[2].init.body, request.body);
  const issueRequest = JSON.parse(calls[3].init.body);
  assert.equal(issueRequest.labels[0], "music-pending");
  assert.match(issueRequest.body, /晴天\.zip/);
});
