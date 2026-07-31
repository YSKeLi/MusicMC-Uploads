import assert from "node:assert/strict";
import test from "node:test";
import {
  buildIssueBody,
  buildIssueUrl,
  readSubmissionParams,
  submitNetEase,
  submitUpload,
  validateSubmission,
  validateZipFile,
} from "../docs/portal.mjs";

const submission = {
  ticket: "MUS1.payload.signature",
  song: "晴天",
  player: "TestPlayer",
  source: "upload",
  providerId: "",
};

test("reads prefilled upload and NetEase parameters", () => {
  const uploadUrl = "https://example.test/?ticket=MUS1.payload.signature&song=%E6%99%B4%E5%A4%A9&player=TestPlayer";
  assert.deepEqual(readSubmissionParams(uploadUrl), submission);
  const netease = readSubmissionParams(`${uploadUrl}&source=netease&providerId=186016`);
  assert.equal(netease.source, "netease");
  assert.equal(netease.providerId, "186016");
});

test("builds machine-stable processor sections", () => {
  const body = buildIssueBody(submission);
  assert.match(body, /^### Upload ticket\n\nMUS1\.payload\.signature/m);
  assert.match(body, /^### Song name\n\n晴天/m);
  assert.match(body, /^### Minecraft player\n\nTestPlayer/m);
  assert.match(body, /^### Source type\n\nupload/m);
  assert.match(body, /^### Music ZIP file\n/m);
  assert.doesNotMatch(body, /- \[[ x]\]/i);
});

test("creates a standard prefilled GitHub issue URL", () => {
  const url = new URL(buildIssueUrl(submission, "https://github.com/example/musicmc/issues/new"));
  assert.equal(url.origin + url.pathname, "https://github.com/example/musicmc/issues/new");
  assert.equal(url.searchParams.get("title"), "[Music Upload] 晴天");
  assert.equal(url.searchParams.get("body"), buildIssueBody(submission));
});

test("rejects damaged links", () => {
  assert.deepEqual(validateSubmission({ ticket: "bad", song: "", player: "x", source: "bad", providerId: "" }),
    ["ticket", "song", "player", "source"]);
  assert.throws(() => buildIssueUrl({ ticket: "bad", song: "", player: "x", source: "upload" }));
  assert.throws(() => buildIssueUrl(submission, "https://example.test/issues/new"));
});

test("accepts any ZIP filename and enforces only type and size", () => {
  assert.equal(validateZipFile({ name: "任意名称.zip", size: 1024 }), "");
  assert.match(validateZipFile({ name: "song.mp3", size: 1024 }), /\.zip/);
  assert.match(validateZipFile({ name: "song.zip", size: 26 * 1024 * 1024 }), /25 MB/);
});

test("submits ZIP and NetEase jobs to their API endpoints", async () => {
  const file = { name: "任意名称.zip", size: 1024, type: "application/zip" };
  let request;
  const fetchMock = async (url, init) => {
    request = { url, init };
    return Response.json({ issue_number: 12 }, { status: 201 });
  };
  await submitUpload("https://upload.example/", submission, file, fetchMock);
  assert.equal(request.url, "https://upload.example/upload");
  assert.equal(request.init.headers["X-MusicMC-Filename"], encodeURIComponent("任意名称.zip"));

  const netease = { ...submission, source: "netease", providerId: "186016" };
  await submitNetEase("https://upload.example/", netease, fetchMock);
  assert.equal(request.url, "https://upload.example/netease");
  assert.deepEqual(JSON.parse(request.init.body), { song_id: "186016" });
});
