const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DATA_PATH = path.join(DATA_DIR, 'voiceControl.json');

// { [channelId]: { ownerId, ownerTag, managerIds: [userId, ...], statusText } }
// -- key-nya channelId (BUKAN guildId), soalnya kontrol ini emang spesifik
// buat 1 voice channel tertentu (channel fix tempat Satpam Voice nongkrong
// 24/7), bukan sistem multi-channel. `statusText` cuma buat DITAMPILIN
// ulang di embed kita sendiri -- Discord nggak nyediain cara buat MEMBACA
// balik voice status yang udah di-set lewat API, jadi kita simpen sendiri
// nilai terakhir yang berhasil kita kirim.
let data = {};

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

function ensureEntry(channelId) {
  if (!data[channelId]) data[channelId] = { ownerId: null, ownerTag: null, managerIds: [], statusText: null };
  return data[channelId];
}

/** Snapshot read-only -- dipakai di tempat yang cuma butuh BACA, nggak nulis. */
function getEntry(channelId) {
  const entry = data[channelId];
  if (!entry) return { ownerId: null, ownerTag: null, managerIds: [], statusText: null };
  return { ownerId: entry.ownerId, ownerTag: entry.ownerTag, managerIds: [...entry.managerIds], statusText: entry.statusText };
}

function getOwnerId(channelId) {
  return getEntry(channelId).ownerId;
}

function getManagerIds(channelId) {
  return getEntry(channelId).managerIds;
}

/** Klaim kepemilikan pertama kali -- GAGAL kalau udah ada owner (pakai Transfer buat ganti). */
function claimOwnership(channelId, userId, userTag) {
  const entry = ensureEntry(channelId);
  if (entry.ownerId) return { ok: false, reason: 'already_owned' };
  entry.ownerId = userId;
  entry.ownerTag = userTag || null;
  saveSync();
  return { ok: true };
}

/** Transfer kepemilikan ke member lain -- owner lama otomatis dicopot dari status owner. */
function transferOwnership(channelId, newOwnerId, newOwnerTag) {
  const entry = ensureEntry(channelId);
  entry.ownerId = newOwnerId;
  entry.ownerTag = newOwnerTag || null;
  // Owner baru otomatis dicopot dari daftar manager (kalau sebelumnya manager) -- nggak perlu dobel status.
  entry.managerIds = entry.managerIds.filter((id) => id !== newOwnerId);
  saveSync();
  return { ok: true };
}

function addManager(channelId, userId) {
  const entry = ensureEntry(channelId);
  if (entry.ownerId === userId) return { ok: false, reason: 'is_owner' };
  if (entry.managerIds.includes(userId)) return { ok: false, reason: 'already_manager' };
  entry.managerIds.push(userId);
  saveSync();
  return { ok: true };
}

function removeManager(channelId, userId) {
  const entry = ensureEntry(channelId);
  if (!entry.managerIds.includes(userId)) return { ok: false, reason: 'not_manager' };
  entry.managerIds = entry.managerIds.filter((id) => id !== userId);
  saveSync();
  return { ok: true };
}

function setStatusText(channelId, text) {
  const entry = ensureEntry(channelId);
  entry.statusText = text || null;
  saveSync();
}

module.exports = {
  load,
  getEntry,
  getOwnerId,
  getManagerIds,
  claimOwnership,
  transferOwnership,
  addManager,
  removeManager,
  setStatusText,
};
