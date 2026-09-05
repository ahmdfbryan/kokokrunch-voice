const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DATA_PATH = path.join(DATA_DIR, 'musicPlaylists.json');

// { [userId]: { [playlistName]: [{ title, url, durationText, durationSeconds, thumbnail }] } }
let data = {};

const MAX_PLAYLISTS_PER_USER = 25;
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
 * Simpan (atau timpa kalau nama udah ada) playlist buat 1 user. Cuma nyimpen
 * field yang perlu buat replay nanti -- bukan seluruh object track mentah.
 */
function savePlaylist(userId, name, tracks) {
  if (!data[userId]) data[userId] = {};

  const isNew = !data[userId][name];
  if (isNew && Object.keys(data[userId]).length >= MAX_PLAYLISTS_PER_USER) {
    throw new Error(`Kamu udah punya ${MAX_PLAYLISTS_PER_USER} playlist (batas maksimal). Hapus salah satu dulu kalau mau nambah lagi.`);
  }

  const truncated = tracks.length > MAX_TRACKS_PER_PLAYLIST;
  const storedTracks = tracks.slice(0, MAX_TRACKS_PER_PLAYLIST).map(pickTrackFields);

  data[userId][name] = storedTracks;
  saveSync();
  return { isNew, trackCount: storedTracks.length, truncated };
}

/**
 * Tambahin track ke playlist yang UDAH ADA (append, bukan timpa). Bikin
 * playlist baru kalau namanya belum ada. Dipakai buat /playlist add.
 */
function appendToPlaylist(userId, name, newTracks) {
  if (!data[userId]) data[userId] = {};

  const isNew = !data[userId][name];
  if (isNew && Object.keys(data[userId]).length >= MAX_PLAYLISTS_PER_USER) {
    throw new Error(`Kamu udah punya ${MAX_PLAYLISTS_PER_USER} playlist (batas maksimal). Hapus salah satu dulu kalau mau nambah lagi.`);
  }

  const existing = data[userId][name] || [];
  const combined = [...existing, ...newTracks.map(pickTrackFields)];
  const truncated = combined.length > MAX_TRACKS_PER_PLAYLIST;
  const storedTracks = combined.slice(0, MAX_TRACKS_PER_PLAYLIST);

  data[userId][name] = storedTracks;
  saveSync();
  return { isNew, trackCount: storedTracks.length, addedCount: newTracks.length, truncated };
}

function getPlaylist(userId, name) {
  return data[userId]?.[name] || null;
}

function listPlaylists(userId) {
  const playlists = data[userId] || {};
  return Object.entries(playlists).map(([name, tracks]) => ({
    name,
    trackCount: tracks.length,
    totalSeconds: tracks.reduce((sum, t) => sum + (t.durationSeconds || 0), 0),
  }));
}

function deletePlaylist(userId, name) {
  if (!data[userId] || !data[userId][name]) return false;
  delete data[userId][name];
  saveSync();
  return true;
}

module.exports = {
  load,
  savePlaylist,
  appendToPlaylist,
  getPlaylist,
  listPlaylists,
  deletePlaylist,
  MAX_PLAYLISTS_PER_USER,
  MAX_TRACKS_PER_PLAYLIST,
};
