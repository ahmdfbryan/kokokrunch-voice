const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DATA_PATH = path.join(DATA_DIR, 'musicPlaylists.json');

// { [guildId]: { [playlistName]: { ownerId, ownerTag, tracks: [{ title, url,
//   durationText, durationSeconds, thumbnail }] } } }
//
// Playlist di-scope per GUILD (server), bukan per user -- jadi semua member
// server bisa LIHAT & PAKAI (play/add) playlist yang sama lewat /playlist,
// s!playlist, tombol Playlist di panel, maupun AI. Nama parameter di bawah
// sengaja dipanggil `scopeId` (bukan `userId`) buat nunjukkin ini bukan lagi
// ID personal, walau nilainya sekarang selalu guild.id di semua caller.
//
// Tapi buat ngehapus (baik seluruh playlist maupun 1 lagu doang), cuma
// PEMILIK (yang pertama kali bikin playlist itu) yang boleh -- makanya tiap
// playlist nyimpen `ownerId`/`ownerTag` (dicatat sekali pas playlist itu
// pertama kali dibuat, nggak berubah walau member lain ikut nambahin lagu).
// Ini murni penyimpanan data; PENGECEKAN izinnya sendiri (canDelete) ada di
// bawah, dipanggil dari layer command/panel sebelum manggil deletePlaylist
// atau removeTrackAt.
let data = {};

const MAX_PLAYLISTS_PER_GUILD = 25;
const MAX_TRACKS_PER_PLAYLIST = 100;

function load() {
  try {
    data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  } catch {
    data = {};
  }
  normalizeLegacyData();
}

/**
 * Playlist yang kesimpen SEBELUM fitur owner ini ada masih format lama
 * (langsung array of tracks, tanpa ownerId/ownerTag). Dibungkus di sini jadi
 * format baru `{ ownerId: null, ownerTag: null, tracks }` biar nggak crash --
 * ownerId `null` berarti "pemilik nggak diketahui" (playlist yatim), dan
 * `canDelete` di bawah punya fallback khusus buat kasus ini.
 */
function normalizeLegacyData() {
  for (const scopeId of Object.keys(data)) {
    const playlists = data[scopeId];
    if (!playlists || typeof playlists !== 'object') continue;
    for (const name of Object.keys(playlists)) {
      const entry = playlists[name];
      if (Array.isArray(entry)) {
        playlists[name] = { ownerId: null, ownerTag: null, tracks: entry };
      }
    }
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
 * mentah. `owner` = { id, tag } dari yang manggil -- CUMA dipakai buat nyatet
 * pemilik pas playlist ini BARU dibuat; kalau namanya udah ada (ditimpa),
 * pemilik ASLINYA tetap dipertahankan (nggak pindah tangan cuma gara-gara
 * member lain nyimpen ulang pakai nama yang sama).
 */
function savePlaylist(scopeId, name, tracks, owner) {
  if (!data[scopeId]) data[scopeId] = {};

  const existing = data[scopeId][name];
  const isNew = !existing;
  if (isNew && Object.keys(data[scopeId]).length >= MAX_PLAYLISTS_PER_GUILD) {
    throw new Error(`Server ini udah punya ${MAX_PLAYLISTS_PER_GUILD} playlist (batas maksimal). Hapus salah satu dulu kalau mau nambah lagi.`);
  }

  const truncated = tracks.length > MAX_TRACKS_PER_PLAYLIST;
  const storedTracks = tracks.slice(0, MAX_TRACKS_PER_PLAYLIST).map(pickTrackFields);

  data[scopeId][name] = {
    ownerId: isNew ? owner?.id || null : existing.ownerId,
    ownerTag: isNew ? owner?.tag || null : existing.ownerTag,
    tracks: storedTracks,
  };
  saveSync();
  return { isNew, trackCount: storedTracks.length, truncated };
}

/**
 * Tambahin track ke playlist yang UDAH ADA (append, bukan timpa). Bikin
 * playlist baru kalau namanya belum ada. Dipakai buat /playlist add & tombol
 * "Add" (nambahin lagu yang lagi diputar) di panel. Sama kayak savePlaylist,
 * `owner` cuma dicatet pas playlist ini BARU dibuat lewat append ini.
 */
function appendToPlaylist(scopeId, name, newTracks, owner) {
  if (!data[scopeId]) data[scopeId] = {};

  const existing = data[scopeId][name];
  const isNew = !existing;
  if (isNew && Object.keys(data[scopeId]).length >= MAX_PLAYLISTS_PER_GUILD) {
    throw new Error(`Server ini udah punya ${MAX_PLAYLISTS_PER_GUILD} playlist (batas maksimal). Hapus salah satu dulu kalau mau nambah lagi.`);
  }

  const existingTracks = existing?.tracks || [];
  const combined = [...existingTracks, ...newTracks.map(pickTrackFields)];
  const truncated = combined.length > MAX_TRACKS_PER_PLAYLIST;
  const storedTracks = combined.slice(0, MAX_TRACKS_PER_PLAYLIST);

  data[scopeId][name] = {
    ownerId: isNew ? owner?.id || null : existing.ownerId,
    ownerTag: isNew ? owner?.tag || null : existing.ownerTag,
    tracks: storedTracks,
  };
  saveSync();
  return { isNew, trackCount: storedTracks.length, addedCount: newTracks.length, truncated };
}

function getPlaylist(scopeId, name) {
  return data[scopeId]?.[name]?.tracks || null;
}

/**
 * Info pemilik 1 playlist -- `{ ownerId, ownerTag }` (keduanya bisa `null`
 * kalau playlist-nya "yatim", dibuat sebelum fitur owner ini ada), atau
 * `null` kalau playlist-nya sendiri nggak ketemu.
 */
function getPlaylistOwner(scopeId, name) {
  const entry = data[scopeId]?.[name];
  if (!entry) return null;
  return { ownerId: entry.ownerId || null, ownerTag: entry.ownerTag || null };
}

/**
 * Cek apakah `userId` boleh ngehapus (baik seluruh playlist maupun 1 lagu
 * doang) dari playlist ini -- HARUS pemiliknya (yang pertama kali bikin).
 * Playlist "yatim" (ownerId null, dibuat sebelum fitur ini ada) fallback ke
 * `hasManageGuild` (izin Manage Server), biar tetap ada yang bisa
 * beres-beres playlist lama itu.
 */
function canDelete(scopeId, name, userId, hasManageGuild) {
  const owner = getPlaylistOwner(scopeId, name);
  if (!owner) return { allowed: false, reason: 'not_found', owner: null };
  if (owner.ownerId) {
    return { allowed: owner.ownerId === userId, reason: 'not_owner', owner };
  }
  return { allowed: !!hasManageGuild, reason: 'orphaned', owner };
}

function listPlaylists(scopeId) {
  const playlists = data[scopeId] || {};
  return Object.entries(playlists).map(([name, entry]) => ({
    name,
    trackCount: entry.tracks.length,
    totalSeconds: entry.tracks.reduce((sum, t) => sum + (t.durationSeconds || 0), 0),
    ownerId: entry.ownerId || null,
    ownerTag: entry.ownerTag || null,
  }));
}

function deletePlaylist(scopeId, name) {
  if (!data[scopeId] || !data[scopeId][name]) return false;
  delete data[scopeId][name];
  saveSync();
  return true;
}

/**
 * Hapus SATU lagu aja dari playlist (dipakai dari tombol "Hapus Lagu" di
 * panel) -- beda dari `deletePlaylist` yang ngehapus SELURUH playlist.
 * `indexOneBased` ngikutin nomor urut yang ditampilin di layar detail
 * playlist (1 = lagu pertama).
 */
function removeTrackAt(scopeId, name, indexOneBased) {
  const tracks = data[scopeId]?.[name]?.tracks;
  if (!tracks) return { ok: false, reason: 'not_found' };

  const idx = indexOneBased - 1;
  if (!Number.isInteger(idx) || idx < 0 || idx >= tracks.length) {
    return { ok: false, reason: 'out_of_range' };
  }

  const [removed] = tracks.splice(idx, 1);
  saveSync();
  return { ok: true, removedTitle: removed.title, trackCount: tracks.length };
}

/**
 * Ganti nama playlist (dipakai dari tombol "Rename" di panel). Nolak kalau
 * nama lama nggak ketemu atau nama baru udah dipakai playlist lain (di
 * server yang sama). Pemilik (ownerId/ownerTag) ikut playlist-nya pindah ke
 * nama baru, nggak berubah.
 */
function renamePlaylist(scopeId, oldName, newName) {
  if (!data[scopeId] || !data[scopeId][oldName]) {
    return { ok: false, reason: 'not_found' };
  }
  if (oldName !== newName && data[scopeId][newName]) {
    return { ok: false, reason: 'name_taken' };
  }

  const entry = data[scopeId][oldName];
  delete data[scopeId][oldName];
  data[scopeId][newName] = entry;
  saveSync();
  return { ok: true };
}

module.exports = {
  load,
  savePlaylist,
  appendToPlaylist,
  getPlaylist,
  getPlaylistOwner,
  canDelete,
  listPlaylists,
  deletePlaylist,
  removeTrackAt,
  renamePlaylist,
  MAX_PLAYLISTS_PER_GUILD,
  MAX_TRACKS_PER_PLAYLIST,
};
