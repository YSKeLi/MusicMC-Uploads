const ISSUE_URL = "https://github.com/YSKeLi/MusicMC-Uploads/issues/new";
const MAX_ZIP_BYTES = 25 * 1024 * 1024;

export function readSubmissionParams(url) {
  const params = new URL(url).searchParams;
  return {
    ticket: (params.get("ticket") || "").trim(),
    song: (params.get("song") || "").trim(),
    player: (params.get("player") || "").trim(),
  };
}

export function validateSubmission(submission) {
  const errors = [];
  if (!submission.ticket.startsWith("MUS1.")) {
    errors.push("ticket");
  }
  if (submission.song.length < 1 || submission.song.length > 48 || submission.song.includes("\n")) {
    errors.push("song");
  }
  if (!/^[A-Za-z0-9_]{3,16}$/.test(submission.player)) {
    errors.push("player");
  }
  return errors;
}

export function buildIssueBody(submission) {
  return [
    "### 上传凭证",
    "",
    submission.ticket,
    "",
    "### 歌曲名称",
    "",
    submission.song,
    "",
    "### Minecraft 玩家名",
    "",
    submission.player,
    "",
    "### 音乐 ZIP 文件",
    "",
    "<!-- 请把 ZIP 文件拖到这里，等待上传完成后再创建 Issue。 -->",
  ].join("\n");
}

export function buildIssueUrl(submission) {
  if (validateSubmission(submission).length > 0) {
    throw new Error("Invalid MusicMC submission parameters");
  }
  const params = new URLSearchParams({
    title: `[Music Upload] ${submission.song}`,
    body: buildIssueBody(submission),
  });
  return `${ISSUE_URL}?${params.toString()}`;
}

export function validateZipFile(file, songName) {
  if (!file) {
    return "请选择 ZIP 文件。";
  }
  if (file.name !== `${songName}.zip`) {
    return `压缩包必须命名为 ${songName}.zip。`;
  }
  if (file.size < 1 || file.size > MAX_ZIP_BYTES) {
    return "ZIP 文件必须大于 0 字节且不超过 25 MB。";
  }
  return "";
}

export async function submitUpload(apiUrl, submission, file, fetchImpl = fetch) {
  const fileError = validateZipFile(file, submission.song);
  if (validateSubmission(submission).length > 0 || fileError) {
    throw new Error(fileError || "上传链接无效。");
  }
  const endpoint = new URL("/upload", apiUrl).toString();
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": file.type || "application/zip",
      "X-MusicMC-Ticket": submission.ticket,
      "X-MusicMC-Filename": encodeURIComponent(file.name),
    },
    body: file,
  });
  let result = {};
  try {
    result = await response.json();
  } catch {
    // The status code still provides a useful generic failure below.
  }
  if (!response.ok) {
    throw new Error(result.error || `自动提交失败（HTTP ${response.status}）。`);
  }
  return result;
}
