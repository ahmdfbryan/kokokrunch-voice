const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DATA_PATH = path.join(DATA_DIR, 'streakGroups.json');

// { [groupId]: {
//   id, guildId, ownerId, name, memberIds: [...],
//   createdAt, currentStreak, longestStreak,
//   checkins: { [dayKey]: [userId, ...] },  -- window yang lagi berjalan/belum dievaluasi
//   lastFinalizedDayKey: string,             -- dayKey window yang masih "terbuka" (belum dievaluasi)
// } }
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

function generateId() {
  return 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function getAllGroups(guildId) {
  const all = Object.values(data);
  return guildId ? all.filter((g) => g.guildId === guildId) : all;
}

function getGroup(groupId) {
  return data[groupId] || null;
}

function getGroupByOwner(guildId, ownerId) {
  return Object.values(data).find((g) => g.guildId === guildId && g.ownerId === ownerId) || null;
}

/**
 * Grup yang dia OWN diprioritaskan; kalau nggak, cari grup manapun di mana
 * dia jadi member biasa.
 */
function getGroupForUser(guildId, userId) {
  const owned = getGroupByOwner(guildId, userId);
  if (owned) return owned;
  return Object.values(data).find((g) => g.guildId === guildId && g.memberIds.includes(userId)) || null;
}

function createGroup(guildId, ownerId, dayKeyNow, name) {
  const group = {
    id: generateId(),
    guildId,
    ownerId,
    name: name || null,
    memberIds: [ownerId],
    createdAt: Date.now(),
    currentStreak: 0,
    longestStreak: 0,
    checkins: {},
    lastFinalizedDayKey: dayKeyNow,
  };
  data[group.id] = group;
  saveSync();
  return group;
}

function renameGroup(groupId, newName) {
  const g = data[groupId];
  if (!g) return { ok: false, reason: 'not_found' };
  g.name = newName;
  saveSync();
  return { ok: true, group: g };
}

function addMember(groupId, userId) {
  const g = data[groupId];
  if (!g) return { ok: false, reason: 'not_found' };
  if (g.memberIds.includes(userId)) return { ok: false, reason: 'already_member' };
  if (g.memberIds.length >= 15) return { ok: false, reason: 'full' };
  g.memberIds.push(userId);
  saveSync();
  return { ok: true, group: g };
}

function recordCheckin(groupId, dayKey, userId) {
  const g = data[groupId];
  if (!g) return;
  if (!g.checkins[dayKey]) g.checkins[dayKey] = [];
  if (!g.checkins[dayKey].includes(userId)) {
    g.checkins[dayKey].push(userId);
    saveSync();
  }
}

function saveGroup(group) {
  data[group.id] = group;
  saveSync();
}

module.exports = {
  load,
  getAllGroups,
  getGroup,
  getGroupByOwner,
  getGroupForUser,
  createGroup,
  renameGroup,
  addMember,
  recordCheckin,
  saveGroup,
};
