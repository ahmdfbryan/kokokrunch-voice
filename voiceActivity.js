const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DATA_PATH = path.join(DATA_DIR, 'voiceActivity.json');

// { [userId]: { username, totalSeconds, currentStreak, longestStreak, lastActiveDate } }
let data = {};

// userId -> timestamp (ms) waktu member itu mulai sesi voice yang lagi jalan.
// In-memory aja, nggak perlu persist (kalau bot restart, sesi lama otomatis
// "hilang" tapi nggak masalah -- lihat catatan di index.js soal populate ulang).
const activeSessions = new Map();

function load() {
  try {
    const raw = fs.readFileSync(DATA_PATH, 'utf8');
    data = JSON.parse(raw);
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

/**
 * Tanggal hari ini dalam zona waktu WIB (UTC+7), format YYYY-MM-DD.
 * Dipakai buat hitung streak biar "harinya" masuk akal buat komunitas Indonesia.
 */
function getWibDateString(date = new Date()) {
  const wib = new Date(date.getTime() + 7 * 60 * 60 * 1000);
  return wib.toISOString().slice(0, 10);
}

function ensureUser(userId, username) {
  if (!data[userId]) {
    data[userId] = { username: username || userId, totalSeconds: 0, currentStreak: 0, longestStreak: 0, lastActiveDate: null };
  } else if (username) {
    data[userId].username = username; // keep cache username tetap update
  }
  return data[userId];
}

function startSession(userId, username) {
  ensureUser(userId, username);
  if (!activeSessions.has(userId)) {
    activeSessions.set(userId, Date.now());
  }
}

function endSession(userId) {
  const joinedAt = activeSessions.get(userId);
  if (!joinedAt) return;
  activeSessions.delete(userId);
  accumulate(userId, Date.now() - joinedAt);
}

function bumpStreak(user) {
  const today = getWibDateString();
  if (user.lastActiveDate === today) return; // udah dihitung hari ini

  const yesterday = getWibDateString(new Date(Date.now() - 24 * 60 * 60 * 1000));
  if (user.lastActiveDate === yesterday) {
    user.currentStreak += 1;
  } else {
    user.currentStreak = 1;
  }
  user.longestStreak = Math.max(user.longestStreak, user.currentStreak);
  user.lastActiveDate = today;
}

function accumulate(userId, elapsedMs) {
  const user = ensureUser(userId);
  if (elapsedMs > 0) {
    user.totalSeconds += Math.floor(elapsedMs / 1000);
  }
  // bumpStreak tetap jalan walau durasi sesi sangat singkat (dibulatkan ke 0
  // detik) -- yang penting user beneran join voice hari ini, itu udah cukup
  // buat streak, meski totalSeconds-nya nggak nambah signifikan.
  bumpStreak(user);
  saveSync();
}

/**
 * "Cairkan" durasi sesi yang lagi berjalan lama ke totalSeconds tanpa
 * mengakhiri sesinya -- dipanggil berkala biar data nggak ilang banyak
 * kalau proses tiba-tiba mati/crash di tengah sesi panjang.
 */
function checkpointAll() {
  const now = Date.now();
  for (const [userId, joinedAt] of activeSessions.entries()) {
    accumulate(userId, now - joinedAt);
    activeSessions.set(userId, now);
  }
}

const ACHIEVEMENT_TIERS = [
  { hours: 500, title: 'Penunggu Voice Channel' },
  { hours: 250, title: 'Voice God' },
  { hours: 100, title: 'Legenda Voice' },
  { hours: 50, title: 'Sesepuh Voice' },
  { hours: 20, title: 'Warga Tetap VC' },
  { hours: 5, title: 'Anak Nongkrong' },
  { hours: 1, title: 'Pendatang Baru' },
];

function getAchievementTitle(totalSeconds) {
  const hours = totalSeconds / 3600;
  for (const tier of ACHIEVEMENT_TIERS) {
    if (hours >= tier.hours) return tier.title;
  }
  return 'Belum Ada Title';
}

/**
 * Stats real-time: kalau member lagi aktif di voice sekarang, durasi sesi
 * yang lagi jalan ikut ditambahin (biar angkanya update live, bukan cuma
 * pas dia keluar VC).
 */
function getStats(userId) {
  const user = data[userId];
  if (!user) return null;

  let liveSeconds = user.totalSeconds;
  const joinedAt = activeSessions.get(userId);
  if (joinedAt) liveSeconds += Math.floor((Date.now() - joinedAt) / 1000);

  return { ...user, totalSeconds: liveSeconds, isActive: !!joinedAt };
}

function getLeaderboard(limit = 10) {
  const now = Date.now();
  return Object.entries(data)
    .map(([userId, user]) => {
      let liveSeconds = user.totalSeconds;
      const joinedAt = activeSessions.get(userId);
      if (joinedAt) liveSeconds += Math.floor((now - joinedAt) / 1000);
      return { userId, ...user, totalSeconds: liveSeconds };
    })
    .sort((a, b) => b.totalSeconds - a.totalSeconds)
    .slice(0, limit);
}

module.exports = {
  load,
  saveSync,
  startSession,
  endSession,
  checkpointAll,
  getStats,
  getLeaderboard,
  getAchievementTitle,
};
