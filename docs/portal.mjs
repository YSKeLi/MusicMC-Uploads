const ISSUE_URL = "https://github.com/YSKeLi/MusicMC-Uploads/issues/new";

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
    "### 上传确认",
    "",
    "- [x] 我拥有该音频，或已获得在此服务器中使用和分发该音频的许可。",
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
