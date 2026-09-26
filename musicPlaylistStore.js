const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DATA_PATH = path.join(DATA_DIR, 'musicPlaylists.json');

// { [guildId]: { [playlistName]: [{ title, url, durationText, durationSeconds, thumbnail }] } }
//
// Playlist di-scope per GUILD (server), bukan per user -- jadi semua member
// server bisa lihat & pakai playlist yang sama lewat /playlist, s!playlist,
// tombol Playlist di panel, maupun AI. Nama parameter di bawah sengaja
// dipanggil `scopeId` (bukan `userId`) buat nunjukkin ini bukan lagi ID
// personal, walau nilainya sekarang selalu guild.id di semua caller.
let data = {};

const MAX_PLAYLISTS_PER_GUILD = 25;
const MAX_TRACKS_PER_PLAYLIST = 100;

function load() {
  try {
    data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  } catch {
    data = {};
  }
}

function saveSync() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmpPath = `${DATA_PATH}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, DATA_PATH); // atomic replace, biar file nggak korup kalau proses mati pas nulis
}

function pickTrackFields(t) {
  return {
    title: t.title,
    url: t.url,
    durationText: t.durationText || null,
    durationSeconds: t.durationSeconds || null,
    thumbnail: t.thumbnail || null,
  };
}

/**
 * Simpan (atau timpa kalau nama udah ada) playlist buat 1 server. Cuma
 * nyimpen field yang perlu buat replay nanti -- bukan seluruh object track
 * mentah.
 */
function savePlaylist(scopeId, name, tracks) {
  if (!data[scopeId]) data[scopeId] = {};

  const isNew = !data[scopeId][name];
  if (isNew && Object.keys(data[scopeId]).length >= MAX_PLAYLISTS_PER_GUILD) {
    throw new Error(`Server ini udah punya ${MAX_PLAYLISTS_PER_GUILD} playlist (batas maksimal). Hapus salah satu dulu kalau mau nambah lagi.`);
  }

  const truncated = tracks.length > MAX_TRACKS_PER_PLAYLIST;
  const storedTracks = tracks.slice(0, MAX_TRACKS_PER_PLAYLIST).map(pickTrackFields);

  data[scopeId][name] = storedTracks;
  saveSync();
  return { isNew, trackCount: storedTracks.length, truncated };
}

/**
 * Tambahin track ke playlist yang UDAH ADA (append, bukan timpa). Bikin
 * playlist baru kalau namanya belum ada. Dipakai buat /playlist add & tombol
 * "Add" (nambahin lagu yang lagi diputar) di panel.
 */
function appendToPlaylist(scopeId, name, newTracks) {
  if (!data[scopeId]) data[scopeId] = {};

  const isNew = !data[scopeId][name];
  if (isNew && Object.keys(data[scopeId]).length >= MAX_PLAYLISTS_PER_GUILD) {
    throw new Error(`Server ini udah punya ${MAX_PLAYLISTS_PER_GUILD} playlist (batas maksimal). Hapus salah satu dulu kalau mau nambah lagi.`);
  }

  const existing = data[scopeId][name] || [];
  const combined = [...existing, ...newTracks.map(pickTrackFields)];
  const truncated = combined.length > MAX_TRACKS_PER_PLAYLIST;
  const storedTracks = combined.slice(0, MAX_TRACKS_PER_PLAYLIST);

  data[scopeId][name] = storedTracks;
  saveSync();
  return { isNew, trackCount: storedTracks.length, addedCount: newTracks.length, truncated };
}

function getPlaylist(scopeId, name) {
  return data[scopeId]?.[name] || null;
}

function listPlaylists(scopeId) {
  const playlists = data[scopeId] || {};
  return Object.entries(playlists).map(([name, tracks]) => ({
    name,
    trackCount: tracks.length,
    totalSeconds: tracks.reduce((sum, t) => sum + (t.durationSeconds || 0), 0),
  }));
}

function deletePlaylist(scopeId, name) {
  if (!data[scopeId] || !data[scopeId][name]) return false;
  delete data[scopeId][name];
  saveSync();
  return true;
}

/**
 * Ganti nama playlist (dipakai dari tombol "Rename" di panel). Nolak kalau
 * nama lama nggak ketemu atau nama baru udah dipakai playlist lain (di
 * server yang sama).
 */
function renamePlaylist(scopeId, oldName, newName) {
  if (!data[scopeId] || !data[scopeId][oldName]) {
    return { ok: false, reason: 'not_found' };
  }
  if (oldName !== newName && data[scopeId][newName]) {
    return { ok: false, reason: 'name_taken' };
  }

  const tracks = data[scopeId][oldName];
  delete data[scopeId][oldName];
  data[scopeId][newName] = tracks;
  saveSync();
  return { ok: true };
}

module.exports = {
  load,
  savePlaylist,
  appendToPlaylist,
  getPlaylist,
  listPlaylists,
  deletePlaylist,
  renamePlaylist,
  MAX_PLAYLISTS_PER_GUILD,
  MAX_TRACKS_PER_PLAYLIST,
};
