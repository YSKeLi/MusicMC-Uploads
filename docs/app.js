import {
  buildIssueUrl,
  readSubmissionParams,
  submitUpload,
  validateSubmission,
  validateZipFile,
} from "./portal.mjs";

const submission = readSubmissionParams(window.location.href);
const errors = validateSubmission(submission);
const form = document.querySelector("#submission-form");
const songInput = document.querySelector("#song-name");
const playerInput = document.querySelector("#player-name");
const ticketInput = document.querySelector("#upload-ticket");
const continueButton = document.querySelector("#continue-button");
const status = document.querySelector("#link-status");
const errorNotice = document.querySelector("#link-error");
const uploadField = document.querySelector("#upload-field");
const fileInput = document.querySelector("#music-zip");
const filenameHint = document.querySelector("#filename-hint");
const actionHint = document.querySelector("#action-hint");
const uploadError = document.querySelector("#upload-error");
const uploadSuccess = document.querySelector("#upload-success");
const configuredApi = window.MUSICMC_CONFIG?.uploadApiUrl?.trim() || "";

songInput.value = submission.song;
playerInput.value = submission.player;
ticketInput.value = submission.ticket;

if (errors.length === 0) {
  status.textContent = "凭证已载入";
  status.classList.add("ready");
  filenameHint.textContent = `请选择 ${submission.song}.zip`;
} else {
  status.textContent = "链接无效";
  status.classList.add("error");
  errorNotice.hidden = false;
}

if (configuredApi) {
  actionHint.textContent = "选择文件后由 MusicMC 自动提交";
  fileInput.addEventListener("change", updateFileState);
  updateFileState();
} else {
  uploadField.hidden = true;
  actionHint.textContent = "下一步在 GitHub 添加 ZIP 附件";
  continueButton.textContent = "继续到 GitHub";
  continueButton.disabled = errors.length > 0;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (errors.length > 0) {
    return;
  }
  if (!configuredApi) {
    continueButton.disabled = true;
    continueButton.textContent = "正在打开 GitHub";
    window.location.assign(buildIssueUrl(submission));
    return;
  }

  const file = fileInput.files[0];
  const fileError = validateZipFile(file, submission.song);
  if (fileError) {
    showUploadError(fileError);
    return;
  }
  continueButton.disabled = true;
  continueButton.textContent = "正在上传";
  actionHint.textContent = "正在上传，请勿关闭页面";
  uploadError.hidden = true;
  try {
    const result = await submitUpload(configuredApi, submission, file);
    status.textContent = "提交成功";
    uploadSuccess.replaceChildren(
      document.createTextNode(`歌曲“${submission.song}”已进入处理队列。`),
    );
    if (result.issue_url) {
      const issueLink = document.createElement("a");
      issueLink.href = result.issue_url;
      issueLink.textContent = ` 查看任务 #${result.issue_number}`;
      uploadSuccess.append(issueLink);
    }
    uploadSuccess.hidden = false;
    actionHint.textContent = "服务器处理完成后即可使用 /getCD 获取";
    continueButton.textContent = "已提交";
    fileInput.disabled = true;
  } catch (error) {
    showUploadError(error.message || "自动提交失败，请稍后重试。");
    continueButton.textContent = "重新提交";
    continueButton.disabled = false;
    actionHint.textContent = "提交失败后可直接重试";
  }
});

function updateFileState() {
  const fileError = validateZipFile(fileInput.files[0], submission.song);
  continueButton.disabled = errors.length > 0 || Boolean(fileError);
  if (fileInput.files.length > 0 && fileError) {
    showUploadError(fileError);
  } else {
    uploadError.hidden = true;
  }
}

function showUploadError(message) {
  uploadError.textContent = message;
  uploadError.hidden = false;
}
