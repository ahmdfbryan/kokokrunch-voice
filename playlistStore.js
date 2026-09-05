const fs = require('fs');
const path = require('path');

// Penyimpanan playlist tersimpan, per-guild. Struktur file:
// { "<guildId>": { "<namaLowercase>": { name, tracks, createdBy, createdAt, updatedAt } } }
// Pola sama kayak giveawayStore.js (JSON file + write chain) biar konsisten
// sama modul persistence lain di bot ini.
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'playlists.json');
let writeChain = Promise.resolve();

const MAX_PLAYLISTS_PER_GUILD = 25;
const MAX_TRACKS_PER_PLAYLIST = 100;

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '{}', 'utf8');
}

function loadAll() {
  ensureFile();
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8') || '{}');
  } catch (err) {
    console.error('[playlist-storage] Gagal baca playlists.json, mulai dari kosong:', err);
    return {};
  }
}

function saveAll(data) {
  ensureFile();
  writeChain = writeChain.then(
    () =>
      new Promise((resolve, reject) => {
        const tmpFile = `${DATA_FILE}.tmp`;
        fs.writeFile(tmpFile, JSON.stringify(data, null, 2), 'utf8', (err) => {
          if (err) return reject(err);
          fs.rename(tmpFile, DATA_FILE, (err2) => (err2 ? reject(err2) : resolve()));
        });
      })
  );
  return writeChain;
}

function normalizeKey(name) {
  return name.trim().toLowerCase();
}

function listPlaylists(guildId) {
  const all = loadAll();
  const guildPlaylists = all[guildId] || {};
  return Object.values(guildPlaylists).sort((a, b) => b.updatedAt - a.updatedAt);
}

function getPlaylist(guildId, name) {
  const all = loadAll();
  const guildPlaylists = all[guildId] || {};
  return guildPlaylists[normalizeKey(name)] || null;
}

/**
 * Simpan (atau timpa kalau nama sama) 1 playlist buat guild tertentu.
 * Track disederhanain -- cuma field yang perlu buat diputer ulang nanti,
 * biar file JSON nggak bengkak dan nggak nyimpen state runtime (isAutoplay dll).
 */
async function savePlaylist(guildId, name, tracks, meta = {}) {
  const trimmedName = name.trim();
  if (!trimmedName) throw new Error('Nama playlist nggak boleh kosong.');
  if (trimmedName.length > 50) throw new Error('Nama playlist maksimal 50 karakter.');
  if (!tracks || tracks.length === 0) {
    throw new Error('Nggak ada lagu di sesi saat ini buat disimpan jadi playlist.');
  }

  const all = loadAll();
  if (!all[guildId]) all[guildId] = {};

  const key = normalizeKey(trimmedName);
  const isUpdate = Boolean(all[guildId][key]);

  if (!isUpdate && Object.keys(all[guildId]).length >= MAX_PLAYLISTS_PER_GUILD) {
    throw new Error(`Sudah ada ${MAX_PLAYLISTS_PER_GUILD} playlist tersimpan di server ini. Hapus salah satu dulu pakai /playlist delete.`);
  }

  const trimmedTracks = tracks.slice(0, MAX_TRACKS_PER_PLAYLIST).map((t) => ({
    title: t.title,
    url: t.url,
    durationText: t.durationText || null,
    durationSeconds: t.durationSeconds || null,
    thumbnail: t.thumbnail || null,
    sourceNote: t.sourceNote || null,
  }));

  const now = Date.now();
  const playlist = {
    name: trimmedName,
    tracks: trimmedTracks,
    createdBy: meta.createdBy || all[guildId][key]?.createdBy || null,
    createdAt: all[guildId][key]?.createdAt || now,
    updatedAt: now,
  };

  all[guildId][key] = playlist;
  await saveAll(all);
  return { playlist, isUpdate, truncated: tracks.length > MAX_TRACKS_PER_PLAYLIST };
}

async function deletePlaylist(guildId, name) {
  const all = loadAll();
  const guildPlaylists = all[guildId];
  const key = normalizeKey(name);
  if (!guildPlaylists || !guildPlaylists[key]) return false;

  delete guildPlaylists[key];
  await saveAll(all);
  return true;
}

module.exports = {
  listPlaylists,
  getPlaylist,
  savePlaylist,
  deletePlaylist,
  MAX_TRACKS_PER_PLAYLIST,
  MAX_PLAYLISTS_PER_GUILD,
};
