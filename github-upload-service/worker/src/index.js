const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;
const DEFAULT_MAX_PENDING = 50;

class UploadError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export default {
  fetch(request, env) {
    return handleRequest(request, env);
  },
};

export async function handleRequest(request, env, dependencies = {}) {
  const fetchImpl = dependencies.fetch || fetch;
  const allowedOrigin = String(env.ALLOWED_ORIGIN || "").trim();
  const origin = request.headers.get("Origin") || "";
  const corsHeaders = cors(allowedOrigin);
  if (!allowedOrigin) return jsonResponse({ error: "自动投稿服务尚未完成配置。" }, 503, {});
  if (request.method === "OPTIONS") {
    if (origin !== allowedOrigin) return jsonResponse({ error: "不允许的网页来源。" }, 403, corsHeaders);
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const url = new URL(request.url);
  if (request.method !== "POST" || !new Set(["/upload", "/netease"]).has(url.pathname)) {
    return jsonResponse({ error: "Not found" }, 404, corsHeaders);
  }
  if (origin !== allowedOrigin) return jsonResponse({ error: "不允许的网页来源。" }, 403, corsHeaders);

  try {
    const token = requireEnvironment(env, "GITHUB_TOKEN");
    const repository = validateRepository(requireEnvironment(env, "GITHUB_REPOSITORY"));
    const branch = env.GITHUB_BRANCH || "main";
    const ticket = requireHeader(request, "X-MusicMC-Ticket");
    const publicKeys = env.UPLOAD_PUBLIC_KEYS || requireEnvironment(env, "UPLOAD_PUBLIC_KEY");
    const payload = await verifyTicket(ticket, publicKeys);
    await ensureSubmissionAllowed(fetchImpl, token, repository, branch, payload, env.MAX_PENDING_UPLOADS);

    let result;
    if (url.pathname === "/upload") {
      const filename = decodeFilename(requireHeader(request, "X-MusicMC-Filename"));
      const length = validateArchiveRequest(request, filename);
      result = await publishUpload({
        fetchImpl, token, repository, branch, payload, ticket, filename, length, body: request.body,
      });
    } else {
      const providerId = await readNetEaseRequest(request);
      result = await publishNetEase({ fetchImpl, token, repository, payload, ticket, providerId });
    }
    return jsonResponse(result, 201, corsHeaders);
  } catch (error) {
    if (error instanceof UploadError) return jsonResponse({ error: error.message }, error.status, corsHeaders);
    console.error("MusicMC upload failed", error);
    return jsonResponse({ error: "自动投稿暂时失败，请稍后重试。" }, 500, corsHeaders);
  }
}

async function publishUpload(options) {
  const tag = `upload-${options.payload.nonce}`;
  let releaseId = null;
  try {
    const release = await githubJson(options.fetchImpl, options.token, options.repository, "/releases", {
      method: "POST",
      body: JSON.stringify({
        tag_name: tag,
        target_commitish: options.branch,
        name: `MusicMC pending upload: ${options.payload.song_name}`,
        body: "Temporary upload created by the MusicMC submission service.",
        draft: false,
        prerelease: true,
      }),
    }, 201, "该上传凭证已被使用，或暂存文件创建失败。");
    releaseId = release.id;
    const assetName = `submission-${options.payload.nonce}.zip`;
    const uploadUrl = `https://uploads.github.com/repos/${options.repository}/releases/${releaseId}/assets?name=${encodeURIComponent(assetName)}`;
    const fixedBody = createFixedLengthBody(options.body, options.length);
    const [asset] = await Promise.all([
      githubJsonAbsolute(options.fetchImpl, options.token, uploadUrl, {
        method: "POST",
        headers: { "Content-Type": "application/zip", "Content-Length": String(options.length) },
        body: fixedBody.body,
      }, 201, "ZIP 上传到 GitHub 失败。"),
      fixedBody.completion,
    ]);
    const issue = await createIssue(options, buildIssueBody(options.ticket, options.payload, {
      kind: "upload", assetUrl: asset.browser_download_url, filename: options.filename,
    }));
    return submittedResult(issue, options.payload.song_name);
  } catch (error) {
    if (releaseId !== null) {
      await cleanupRelease(options.fetchImpl, options.token, options.repository, releaseId, tag);
    }
    throw error;
  }
}

async function publishNetEase(options) {
  const issue = await createIssue(options, buildIssueBody(options.ticket, options.payload, {
    kind: "netease", providerId: options.providerId,
  }));
  return submittedResult(issue, options.payload.song_name);
}

async function createIssue(options, body) {
  return githubJson(options.fetchImpl, options.token, options.repository, "/issues", {
    method: "POST",
    body: JSON.stringify({
      title: `[Music Upload] ${options.payload.song_name}`,
      body,
      labels: ["music-pending"],
    }),
  }, 201, "自动创建处理任务失败。");
}

function submittedResult(issue, songName) {
  return { status: "submitted", issue_number: issue.number, issue_url: issue.html_url, song_name: songName };
}

function createFixedLengthBody(body, length) {
  if (typeof FixedLengthStream === "undefined") return { body, completion: Promise.resolve() };
  const stream = new FixedLengthStream(length);
  return { body: stream.readable, completion: body.pipeTo(stream.writable) };
}

export function buildIssueBody(ticket, payload, source) {
  const lines = [
    `<!-- musicmc-player:${payload.player_uuid} -->`,
    `<!-- musicmc-nonce:${payload.nonce} -->`,
    "### Upload ticket", "", ticket, "",
    "### Song name", "", payload.song_name, "",
    "### Minecraft player", "", payload.player_name, "",
    "### Source type", "", source.kind, "",
  ];
  if (source.kind === "upload") {
    lines.push("### Music ZIP file", "", `[${source.filename}](${source.assetUrl})`);
  } else {
    lines.push("### NetEase song ID", "", source.providerId);
  }
  return lines.join("\n");
}

async function ensureSubmissionAllowed(fetchImpl, token, repository, branch, payload, configuredLimit) {
  const [catalogResource, pending] = await Promise.all([
    githubJson(fetchImpl, token, repository, `/contents/catalog.json?ref=${encodeURIComponent(branch)}`,
      {}, 200, "无法读取歌曲目录。"),
    githubJson(fetchImpl, token, repository, "/issues?state=open&labels=music-pending&per_page=100",
      {}, 200, "无法读取投稿队列。"),
  ]);
  let catalog;
  try {
    catalog = JSON.parse(new TextDecoder().decode(base64ToBytes(catalogResource.content.replace(/\s/g, ""))));
  } catch {
    throw new UploadError(502, "GitHub 歌曲目录格式无效。");
  }
  const wanted = normalizeName(payload.song_name);
  const existing = (catalog.songs || []).find((song) =>
    normalizeName(song.command_name || song.display_name) === wanted);
  if (payload.replace_song_id) {
    if (!existing || existing.song_id !== payload.replace_song_id) {
      throw new UploadError(409, "替换凭证指定的歌曲与目录不一致。");
    }
  } else if (existing) {
    throw new UploadError(409, "该歌曲命令名称已经存在。");
  }
  const issues = Array.isArray(pending) ? pending.filter((issue) => !issue.pull_request) : [];
  const maxPending = boundedInteger(configuredLimit, 1, 100, DEFAULT_MAX_PENDING);
  if (issues.length >= maxPending) throw new UploadError(429, "全服投稿队列已满，请稍后再试。");
  const playerMarker = `<!-- musicmc-player:${payload.player_uuid} -->`;
  if (issues.some((issue) => String(issue.body || "").includes(playerMarker))) {
    throw new UploadError(409, "你已经有一个正在处理的投稿，请等待完成后再提交。");
  }
  const nonceMarker = `<!-- musicmc-nonce:${payload.nonce} -->`;
  if (issues.some((issue) => String(issue.body || "").includes(nonceMarker))) {
    throw new UploadError(409, "该上传凭证已经使用。");
  }
}

async function readNetEaseRequest(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    throw new UploadError(400, "网易云投稿请求格式无效。");
  }
  const providerId = String(body?.song_id || "").trim();
  if (!/^[1-9][0-9]{0,19}$/.test(providerId)) throw new UploadError(400, "网易云歌曲 ID 无效。");
  return providerId;
}

export async function verifyTicket(ticket, publicKeySource, nowSeconds = Math.floor(Date.now() / 1000)) {
  const parts = ticket.trim().split(".");
  if (parts.length !== 3 || parts[0] !== "MUS1") {
    throw new UploadError(400, "上传凭证格式无效，请回到服务器重新生成。");
  }
  let payloadBytes;
  let derSignature;
  let payload;
  try {
    payloadBytes = base64UrlToBytes(parts[1]);
    derSignature = base64UrlToBytes(parts[2]);
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes));
  } catch {
    throw new UploadError(400, "上传凭证内容无效，请回到服务器重新生成。");
  }
  const publicKeyPem = selectPublicKey(publicKeySource, payload.key_id || "default");
  const publicKey = await crypto.subtle.importKey(
    "spki", pemToBytes(publicKeyPem), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  let valid = false;
  try {
    valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" }, publicKey, derEcdsaToRaw(derSignature, 32), payloadBytes);
  } catch {
    valid = false;
  }
  if (!valid) throw new UploadError(403, "上传凭证签名无效。");
  if (payload.v !== 1
      || typeof payload.song_name !== "string"
      || !/^[A-Za-z0-9_]{3,16}$/.test(payload.player_name || "")
      || !/^[0-9a-f]{32}$/.test(payload.nonce || "")
      || !/^[0-9a-f-]{36}$/i.test(payload.player_uuid || "")) {
    throw new UploadError(400, "上传凭证缺少必要信息。");
  }
  if (payload.replace_song_id !== undefined
      && (!/^[a-z0-9_-]{1,96}$/.test(payload.replace_song_id)
        || !Number.isInteger(payload.replace_revision) || payload.replace_revision < 2)) {
    throw new UploadError(400, "替换凭证内容无效。");
  }
  if (!Number.isInteger(payload.exp) || payload.exp < nowSeconds) {
    throw new UploadError(410, "上传凭证已经过期，请回到服务器重新生成。");
  }
  if (payload.exp > nowSeconds + 3600) throw new UploadError(400, "上传凭证有效期异常。");
  return payload;
}

function selectPublicKey(source, keyId) {
  const text = String(source || "").trim();
  if (text.startsWith("-----BEGIN PUBLIC KEY-----")) return text;
  try {
    const keys = JSON.parse(text);
    const selected = keys[keyId];
    if (typeof selected === "string" && selected.includes("BEGIN PUBLIC KEY")) return selected;
  } catch {
    // The public error below intentionally hides key registry details.
  }
  throw new UploadError(403, "上传凭证使用的签名密钥不受支持。");
}

export function derEcdsaToRaw(signature, size) {
  let offset = 0;
  if (signature[offset++] !== 0x30) throw new Error("Invalid ECDSA sequence");
  const sequenceLength = readDerLength(signature, offset);
  offset = sequenceLength.offset;
  if (offset + sequenceLength.length !== signature.length || signature[offset++] !== 0x02) {
    throw new Error("Invalid ECDSA sequence length");
  }
  const rLength = readDerLength(signature, offset);
  offset = rLength.offset;
  const r = signature.slice(offset, offset + rLength.length);
  offset += rLength.length;
  if (signature[offset++] !== 0x02) throw new Error("Invalid ECDSA integer");
  const sLength = readDerLength(signature, offset);
  offset = sLength.offset;
  const s = signature.slice(offset, offset + sLength.length);
  offset += sLength.length;
  if (offset !== signature.length) throw new Error("Trailing ECDSA data");
  const raw = new Uint8Array(size * 2);
  copyDerInteger(r, raw, 0, size);
  copyDerInteger(s, raw, size, size);
  return raw;
}

function readDerLength(bytes, offset) {
  const first = bytes[offset++];
  if (first < 0x80) return { length: first, offset };
  const byteCount = first & 0x7f;
  if (byteCount < 1 || byteCount > 2 || offset + byteCount > bytes.length) {
    throw new Error("Invalid DER length");
  }
  let length = 0;
  for (let index = 0; index < byteCount; index += 1) length = (length << 8) | bytes[offset++];
  return { length, offset };
}

function copyDerInteger(value, target, targetOffset, size) {
  let source = value;
  while (source.length > 1 && source[0] === 0) source = source.slice(1);
  if (source.length > size) throw new Error("ECDSA integer is too large");
  target.set(source, targetOffset + size - source.length);
}

function validateArchiveRequest(request, filename) {
  if (!filename.toLocaleLowerCase("und").endsWith(".zip") || filename.includes("/") || filename.includes("\\")) {
    throw new UploadError(400, "请选择 ZIP 文件；文件名会由 MusicMC 自动规范化。");
  }
  const contentType = (request.headers.get("Content-Type") || "").split(";", 1)[0].trim();
  if (!new Set(["application/zip", "application/x-zip-compressed", "application/octet-stream"]).has(contentType)) {
    throw new UploadError(415, "只能上传 ZIP 文件。");
  }
  const length = Number(request.headers.get("Content-Length"));
  if (!Number.isInteger(length) || length < 1) throw new UploadError(411, "浏览器没有提供文件大小。");
  if (length > MAX_ARCHIVE_BYTES) throw new UploadError(413, "ZIP 文件不能超过 25 MB。");
  return length;
}

function requireHeader(request, name) {
  const value = request.headers.get(name);
  if (!value || !value.trim()) throw new UploadError(400, `缺少请求字段 ${name}。`);
  return value.trim();
}

function decodeFilename(value) {
  try { return decodeURIComponent(value); } catch { throw new UploadError(400, "ZIP 文件名编码无效。"); }
}

function requireEnvironment(env, name) {
  const value = env[name];
  if (!value) throw new UploadError(503, "自动投稿服务尚未完成配置。");
  return value;
}

function validateRepository(value) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    throw new UploadError(500, "服务端仓库配置无效。");
  }
  return value;
}

function boundedInteger(value, minimum, maximum, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
}

async function githubJson(fetchImpl, token, repository, path, init, expectedStatus, publicError) {
  return githubJsonAbsolute(fetchImpl, token, `https://api.github.com/repos/${repository}${path}`,
    init, expectedStatus, publicError);
}

async function githubJsonAbsolute(fetchImpl, token, url, init, expectedStatus, publicError) {
  const headers = new Headers(init.headers || {});
  headers.set("Accept", "application/vnd.github+json");
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("User-Agent", "MusicMC-Upload-Worker/2");
  headers.set("X-GitHub-Api-Version", "2022-11-28");
  if (init.body && typeof init.body === "string" && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetchImpl(url, { ...init, headers });
  if (response.status !== expectedStatus) {
    const details = await response.text();
    console.error("GitHub API request failed", response.status, details.slice(0, 500));
    throw new UploadError(response.status === 422 ? 409 : 502, publicError);
  }
  return response.json();
}

async function cleanupRelease(fetchImpl, token, repository, releaseId, tag) {
  const headers = {
    Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`,
    "User-Agent": "MusicMC-Upload-Worker/2", "X-GitHub-Api-Version": "2022-11-28",
  };
  await Promise.allSettled([
    fetchImpl(`https://api.github.com/repos/${repository}/releases/${releaseId}`, { method: "DELETE", headers }),
    fetchImpl(`https://api.github.com/repos/${repository}/git/refs/tags/${tag}`, { method: "DELETE", headers }),
  ]);
}

function normalizeName(value) {
  return String(value || "").normalize("NFKC").trim().toLocaleLowerCase("und");
}

function pemToBytes(pem) {
  return base64ToBytes(pem.replace(/-----[^-]+-----/g, "").replace(/\s/g, ""));
}

function base64UrlToBytes(value) {
  return base64ToBytes(value.replace(/-/g, "+").replace(/_/g, "/"));
}

function base64ToBytes(value) {
  const padded = value + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-MusicMC-Ticket, X-MusicMC-Filename",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function jsonResponse(value, status, extraHeaders) {
  return new Response(JSON.stringify(value), {
    status, headers: { "Content-Type": "application/json; charset=utf-8", ...extraHeaders },
  });
}
