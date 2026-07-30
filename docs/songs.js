import {
  CATALOG_URLS,
  commandForSong,
  filterSongs,
  formatDuration,
  parseCatalog,
} from "./catalog.mjs";

const searchInput = document.querySelector("#song-search");
const songList = document.querySelector("#song-list");
const status = document.querySelector("#catalog-status");
const emptyState = document.querySelector("#empty-state");
let songs = [];

function render() {
  const visibleSongs = filterSongs(songs, searchInput.value);
  songList.replaceChildren(...visibleSongs.map(createSongButton));
  emptyState.hidden = visibleSongs.length > 0;
  status.textContent = songs.length > 0 ? `${songs.length} 首可用歌曲` : "暂无歌曲";
}

function createSongButton(song) {
  const button = document.createElement("button");
  button.className = "song-row";
  button.type = "button";
  button.dataset.songName = song.displayName;
  button.setAttribute("aria-label", `复制 ${commandForSong(song.displayName)}`);

  const identity = document.createElement("span");
  identity.className = "song-identity";
  const name = document.createElement("strong");
  name.textContent = song.displayName;
  const meta = document.createElement("small");
  const duration = formatDuration(song.durationSeconds);
  meta.textContent = [song.uploader && `上传者 ${song.uploader}`, duration].filter(Boolean).join(" · ");
  identity.append(name, meta);

  const command = document.createElement("code");
  command.textContent = commandForSong(song.displayName);
  button.append(identity, command);
  button.addEventListener("click", () => copyCommand(button, song.displayName));
  return button;
}

async function copyCommand(button, songName) {
  const command = commandForSong(songName);
  try {
    await writeClipboard(command);
    button.classList.add("copied");
    status.textContent = `已复制：${command}`;
    window.setTimeout(() => button.classList.remove("copied"), 1600);
  } catch {
    status.textContent = "复制失败，请手动选择命令";
  }
}

async function writeClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.className = "clipboard-fallback";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) {
    throw new Error("Clipboard unavailable");
  }
}

async function loadCatalog() {
  status.textContent = "正在读取歌曲目录";
  for (const url of CATALOG_URLS) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      songs = parseCatalog(await response.json());
      render();
      return;
    } catch {
      // Try the next public mirror.
    }
  }
  status.textContent = "歌曲目录暂时无法读取";
  emptyState.hidden = false;
  emptyState.textContent = "请稍后刷新页面";
}

searchInput.addEventListener("input", render);
loadCatalog();
