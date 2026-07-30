const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;
const DEFAULT_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEsPkQJP8RmR+QoasscEvVWy4ctqXW
Mmf8G20eWqh6Z11AI+FLKfNrFfkw1Yugc2lN6+9eiYKMUN7SiRehNRBuXA==
-----END PUBLIC KEY-----`;

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
  const allowedOrigin = env.ALLOWED_ORIGIN || "https://yskeli.github.io";
  const origin = request.headers.get("Origin") || "";
  const corsHeaders = cors(allowedOrigin);

  if (request.method === "OPTIONS") {
    if (origin !== allowedOrigin) {
      return jsonResponse({ error: "不允许的网页来源。" }, 403, corsHeaders);
    }
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const url = new URL(request.url);
  if (url.pathname !== "/upload" || request.method !== "POST") {
    return jsonResponse({ error: "Not found" }, 404, corsHeaders);
  }
  if (origin !== allowedOrigin) {
    return jsonResponse({ error: "不允许的网页来源。" }, 403, corsHeaders);
  }

  try {
    const token = requireEnvironment(env, "GITHUB_TOKEN");
    const repository = validateRepository(env.GITHUB_REPOSITORY || "YSKeLi/MusicMC-Uploads");
    const branch = env.GITHUB_BRANCH || "main";
    const ticket = requireHeader(request, "X-MusicMC-Ticket");
    const encodedFilename = requireHeader(request, "X-MusicMC-Filename");
    const filename = decodeFilename(encodedFilename);
    const length = validateArchiveRequest(request);
    const payload = await verifyTicket(ticket, env.UPLOAD_PUBLIC_KEY || DEFAULT_PUBLIC_KEY);

    if (filename !== `${payload.song_name}.zip`) {
      throw new UploadError(400, `压缩包必须命名为 ${payload.song_name}.zip。`);
    }

    await ensureSongNameAvailable(fetchImpl, token, repository, branch, payload.song_name);
    const result = await publishSubmission({
      fetchImpl,
      token,
      repository,
      branch,
      payload,
      ticket,
      filename,
      length,
      body: request.body,
    });
    return jsonResponse(result, 201, corsHeaders);
  } catch (error) {
    if (error instanceof UploadError) {
      return jsonResponse({ error: error.message }, error.status, corsHeaders);
    }
    console.error("MusicMC upload failed", error);
    return jsonResponse({ error: "自动提交暂时失败，请稍后重试。" }, 500, corsHeaders);
  }
}

async function publishSubmission(options) {
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
        headers: {
          "Content-Type": "application/zip",
          "Content-Length": String(options.length),
        },
        body: fixedBody.body,
      }, 201, "ZIP 上传到 GitHub 失败。"),
      fixedBody.completion,
    ]);

    const issue = await githubJson(options.fetchImpl, options.token, options.repository, "/issues", {
      method: "POST",
      body: JSON.stringify({
        title: `[Music Upload] ${options.payload.song_name}`,
        body: buildIssueBody(options.ticket, options.payload, asset.browser_download_url, options.filename),
        labels: ["music-pending"],
      }),
    }, 201, "自动创建处理任务失败。");

    return {
      status: "submitted",
      issue_number: issue.number,
      issue_url: issue.html_url,
      song_name: options.payload.song_name,
    };
  } catch (error) {
    if (releaseId !== null) {
      await cleanupRelease(options.fetchImpl, options.token, options.repository, releaseId, tag);
    }
    throw error;
  }
}

function createFixedLengthBody(body, length) {
  if (typeof FixedLengthStream === "undefined") {
    return { body, completion: Promise.resolve() };
  }
  const stream = new FixedLengthStream(length);
  return {
    body: stream.readable,
    completion: body.pipeTo(stream.writable),
  };
}

export function buildIssueBody(ticket, payload, assetUrl, filename) {
  return [
    "### 上传凭证",
    "",
    ticket,
    "",
    "### 歌曲名称",
    "",
    payload.song_name,
    "",
    "### Minecraft 玩家名",
    "",
    payload.player_name,
    "",
    "### 音乐 ZIP 文件",
    "",
    `[${filename}](${assetUrl})`,
  ].join("\n");
}

async function ensureSongNameAvailable(fetchImpl, token, repository, branch, songName) {
  const catalog = await githubJson(
    fetchImpl,
    token,
    repository,
    `/contents/catalog.json?ref=${encodeURIComponent(branch)}`,
    {},
    200,
    "无法读取歌曲目录。",
  );
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder().decode(base64ToBytes(catalog.content.replace(/\s/g, ""))));
  } catch {
    throw new UploadError(502, "GitHub 歌曲目录格式无效。");
  }
  const wanted = normalizeName(songName);
  if ((parsed.songs || []).some((song) => normalizeName(song.display_name) === wanted)) {
    throw new UploadError(409, "该歌曲名称已经存在。");
  }
}

export async function verifyTicket(ticket, publicKeyPem, nowSeconds = Math.floor(Date.now() / 1000)) {
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

  const publicKey = await crypto.subtle.importKey(
    "spki",
    pemToBytes(publicKeyPem),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  let valid = false;
  try {
    valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      derEcdsaToRaw(derSignature, 32),
      payloadBytes,
    );
  } catch {
    valid = false;
  }
  if (!valid) {
    throw new UploadError(403, "上传凭证签名无效。");
  }

  if (payload.v !== 1
      || typeof payload.song_name !== "string"
      || !/^[A-Za-z0-9_]{3,16}$/.test(payload.player_name || "")
      || !/^[0-9a-f]{32}$/.test(payload.nonce || "")
      || !/^[0-9a-f-]{36}$/i.test(payload.player_uuid || "")) {
    throw new UploadError(400, "上传凭证缺少必要信息。");
  }
  if (!Number.isInteger(payload.exp) || payload.exp < nowSeconds) {
    throw new UploadError(410, "上传凭证已经过期，请回到服务器重新生成。");
  }
  if (payload.exp > nowSeconds + 3600) {
    throw new UploadError(400, "上传凭证有效期异常。");
  }
  return payload;
}

export function derEcdsaToRaw(signature, size) {
  let offset = 0;
  if (signature[offset++] !== 0x30) {
    throw new Error("Invalid ECDSA sequence");
  }
  const sequenceLength = readDerLength(signature, offset);
  offset = sequenceLength.offset;
  if (offset + sequenceLength.length !== signature.length || signature[offset++] !== 0x02) {
    throw new Error("Invalid ECDSA sequence length");
  }
  const rLength = readDerLength(signature, offset);
  offset = rLength.offset;
  const r = signature.slice(offset, offset + rLength.length);
  offset += rLength.length;
  if (signature[offset++] !== 0x02) {
    throw new Error("Invalid ECDSA integer");
  }
  const sLength = readDerLength(signature, offset);
  offset = sLength.offset;
  const s = signature.slice(offset, offset + sLength.length);
  offset += sLength.length;
  if (offset !== signature.length) {
    throw new Error("Trailing ECDSA data");
  }

  const raw = new Uint8Array(size * 2);
  copyDerInteger(r, raw, 0, size);
  copyDerInteger(s, raw, size, size);
  return raw;
}

function readDerLength(bytes, offset) {
  const first = bytes[offset++];
  if (first < 0x80) {
    return { length: first, offset };
  }
  const byteCount = first & 0x7f;
  if (byteCount < 1 || byteCount > 2 || offset + byteCount > bytes.length) {
    throw new Error("Invalid DER length");
  }
  let length = 0;
  for (let index = 0; index < byteCount; index += 1) {
    length = (length << 8) | bytes[offset++];
  }
  return { length, offset };
}

function copyDerInteger(value, target, targetOffset, size) {
  let source = value;
  while (source.length > 1 && source[0] === 0) {
    source = source.slice(1);
  }
  if (source.length > size) {
    throw new Error("ECDSA integer is too large");
  }
  target.set(source, targetOffset + size - source.length);
}

function validateArchiveRequest(request) {
  const contentType = (request.headers.get("Content-Type") || "").split(";", 1)[0].trim();
  if (!new Set(["application/zip", "application/x-zip-compressed", "application/octet-stream"]).has(contentType)) {
    throw new UploadError(415, "只能上传 ZIP 文件。");
  }
  const length = Number(request.headers.get("Content-Length"));
  if (!Number.isInteger(length) || length < 1) {
    throw new UploadError(411, "浏览器没有提供文件大小，请重新选择 ZIP。");
  }
  if (length > MAX_ARCHIVE_BYTES) {
    throw new UploadError(413, "ZIP 文件不能超过 25 MB。");
  }
  return length;
}

function requireHeader(request, name) {
  const value = request.headers.get(name);
  if (!value || !value.trim()) {
    throw new UploadError(400, `缺少请求字段 ${name}。`);
  }
  return value.trim();
}

function decodeFilename(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new UploadError(400, "ZIP 文件名编码无效。");
  }
}

function requireEnvironment(env, name) {
  const value = env[name];
  if (!value) {
    throw new UploadError(503, "自动提交服务尚未完成配置。");
  }
  return value;
}

function validateRepository(value) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    throw new UploadError(500, "服务端仓库配置无效。");
  }
  return value;
}

async function githubJson(fetchImpl, token, repository, path, init, expectedStatus, publicError) {
  return githubJsonAbsolute(
    fetchImpl,
    token,
    `https://api.github.com/repos/${repository}${path}`,
    init,
    expectedStatus,
    publicError,
  );
}

async function githubJsonAbsolute(fetchImpl, token, url, init, expectedStatus, publicError) {
  const headers = new Headers(init.headers || {});
  headers.set("Accept", "application/vnd.github+json");
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("User-Agent", "MusicMC-Upload-Worker/1");
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
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "MusicMC-Upload-Worker/1",
    "X-GitHub-Api-Version": "2022-11-28",
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
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extraHeaders },
  });
}
