import { buildIssueUrl, readSubmissionParams, validateSubmission } from "./portal.mjs";

const submission = readSubmissionParams(window.location.href);
const errors = validateSubmission(submission);
const form = document.querySelector("#submission-form");
const songInput = document.querySelector("#song-name");
const playerInput = document.querySelector("#player-name");
const ticketInput = document.querySelector("#upload-ticket");
const continueButton = document.querySelector("#continue-button");
const status = document.querySelector("#link-status");
const errorNotice = document.querySelector("#link-error");

songInput.value = submission.song;
playerInput.value = submission.player;
ticketInput.value = submission.ticket;

if (errors.length === 0) {
  status.textContent = "凭证已载入";
  status.classList.add("ready");
  continueButton.disabled = false;
} else {
  status.textContent = "链接无效";
  status.classList.add("error");
  errorNotice.hidden = false;
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (errors.length > 0) {
    return;
  }
  continueButton.disabled = true;
  continueButton.textContent = "正在打开 GitHub";
  window.location.assign(buildIssueUrl(submission));
});
