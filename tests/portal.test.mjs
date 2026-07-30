import assert from "node:assert/strict";
import test from "node:test";
import {
  buildIssueBody,
  buildIssueUrl,
  readSubmissionParams,
  submitUpload,
  validateSubmission,
  validateZipFile,
} from "../docs/portal.mjs";

const submission = {
  ticket: "MUS1.payload.signature",
  song: "晴天",
  player: "TestPlayer",
};

test("reads prefilled submission parameters", () => {
  const url = "https://example.test/?ticket=MUS1.payload.signature&song=%E6%99%B4%E5%A4%A9&player=TestPlayer";
  assert.deepEqual(readSubmissionParams(url), submission);
});

test("builds the sections expected by the processor", () => {
  const body = buildIssueBody(submission);
  assert.match(body, /^### 上传凭证\n\nMUS1\.payload\.signature/m);
  assert.match(body, /^### 歌曲名称\n\n晴天/m);
  assert.match(body, /^### Minecraft 玩家名\n\nTestPlayer/m);
  assert.match(body, /^### 音乐 ZIP 文件\n/m);
  assert.doesNotMatch(body, /- \[[ x]\]/i);
  assert.ok(body.indexOf("### 音乐 ZIP 文件") > body.indexOf("### Minecraft 玩家名"));
});

test("creates a standard prefilled GitHub issue URL", () => {
  const url = new URL(buildIssueUrl(submission));
  assert.equal(url.origin + url.pathname, "https://github.com/YSKeLi/MusicMC-Uploads/issues/new");
  assert.equal(url.searchParams.get("title"), "[Music Upload] 晴天");
  assert.equal(url.searchParams.get("body"), buildIssueBody(submission));
  assert.equal(url.searchParams.has("labels"), false);
});

test("rejects damaged links", () => {
  assert.deepEqual(validateSubmission({ ticket: "bad", song: "", player: "x" }), [
    "ticket",
    "song",
    "player",
  ]);
  assert.throws(() => buildIssueUrl({ ticket: "bad", song: "", player: "x" }));
});

test("requires a ZIP named exactly after the song", () => {
  assert.equal(validateZipFile({ name: "晴天.zip", size: 1024 }, "晴天"), "");
  assert.match(validateZipFile({ name: "other.zip", size: 1024 }, "晴天"), /晴天\.zip/);
  assert.match(validateZipFile({ name: "晴天.zip", size: 26 * 1024 * 1024 }, "晴天"), /25 MB/);
});

test("submits the ZIP directly to the configured API", async () => {
  const file = { name: "晴天.zip", size: 1024, type: "application/zip" };
  let request;
  const result = await submitUpload("https://upload.example/", submission, file, async (url, init) => {
    request = { url, init };
    return Response.json({ issue_number: 12 }, { status: 201 });
  });
  assert.equal(request.url, "https://upload.example/upload");
  assert.equal(request.init.headers["X-MusicMC-Filename"], encodeURIComponent("晴天.zip"));
  assert.equal(request.init.body, file);
  assert.equal(result.issue_number, 12);
});
