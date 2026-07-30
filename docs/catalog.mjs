export const CATALOG_URLS = [
  "https://gh.jasonzeng.dev/https://raw.githubusercontent.com/YSKeLi/MusicMC-Uploads/main/catalog.json",
  "https://raw.githubusercontent.com/YSKeLi/MusicMC-Uploads/main/catalog.json",
  "https://cdn.jsdelivr.net/gh/YSKeLi/MusicMC-Uploads@main/catalog.json",
];

export function parseCatalog(value) {
  if (!value || value.schema_version !== 1 || !Array.isArray(value.songs)) {
    throw new Error("Invalid MusicMC catalog");
  }

  return value.songs
    .filter((song) => song && typeof song.display_name === "string" && song.display_name.trim())
    .map((song) => ({
      displayName: song.display_name.trim(),
      uploader: typeof song.minecraft_player_name === "string" ? song.minecraft_player_name : "",
      durationSeconds: Number.isFinite(song.duration_seconds) ? song.duration_seconds : null,
    }))
    .sort((left, right) => left.displayName.localeCompare(right.displayName, "zh-CN"));
}

export function commandForSong(songName) {
  return `/getCD ${songName}`;
}

export function filterSongs(songs, query) {
  const normalized = query.trim().toLocaleLowerCase("zh-CN");
  if (!normalized) {
    return songs;
  }
  return songs.filter((song) =>
    `${song.displayName}\n${song.uploader}`.toLocaleLowerCase("zh-CN").includes(normalized));
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "";
  }
  const rounded = Math.round(seconds);
  const minutes = Math.floor(rounded / 60);
  return `${minutes}:${String(rounded % 60).padStart(2, "0")}`;
}
