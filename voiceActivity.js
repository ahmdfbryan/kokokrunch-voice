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

// Urutan ASCENDING (dari 0 jam ke tertinggi) -- beda dari sebelumnya, biar
// gampang dipakai buat cari "tier berikutnya" pas hitung progress bar.
const ACHIEVEMENT_TIERS = [
  { hours: 0, title: 'Belum Ada Title', emoji: '🌱', color: 0x99aab5 },
  { hours: 1, title: 'Pendatang Baru', emoji: '🔰', color: 0x57f287 },
  { hours: 5, title: 'Anak Nongkrong', emoji: '🎧', color: 0x5865f2 },
  { hours: 20, title: 'Warga Tetap VC', emoji: '🏠', color: 0x1abc9c },
  { hours: 50, title: 'Sesepuh Voice', emoji: '🧓', color: 0x9b59b6 },
  { hours: 100, title: 'Legenda Voice', emoji: '⭐', color: 0xfee75c },
  { hours: 250, title: 'Voice God', emoji: '👑', color: 0xed4245 },
  { hours: 500, title: 'Penunggu Voice Channel', emoji: '👻', color: 0x2c2f33 },
];

function getTierInfo(totalSeconds) {
  const hours = totalSeconds / 3600;
  let tier = ACHIEVEMENT_TIERS[0];
  for (const t of ACHIEVEMENT_TIERS) {
    if (hours >= t.hours) tier = t;
    else break;
  }
  return tier;
}

function getAchievementTitle(totalSeconds) {
  return getTierInfo(totalSeconds).title;
}

/**
 * Info progress menuju tier berikutnya: tier sekarang, tier berikutnya
 * (null kalau udah tier maksimal), persentase progress (0-1), dan sisa
 * jam yang dibutuhkan.
 */
function getProgress(totalSeconds) {
  const hours = totalSeconds / 3600;
  const currentIndex = ACHIEVEMENT_TIERS.findIndex((t) => t === getTierInfo(totalSeconds));
  const current = ACHIEVEMENT_TIERS[currentIndex];
  const next = ACHIEVEMENT_TIERS[currentIndex + 1] || null;

  if (!next) {
    return { current, next: null, percent: 1, isMax: true, hoursRemaining: 0 };
  }

  const percent = Math.min(1, Math.max(0, (hours - current.hours) / (next.hours - current.hours)));
  return { current, next, percent, isMax: false, hoursRemaining: Math.max(0, next.hours - hours) };
}

/**
 * Render progress bar visual pakai blok unicode, misal "▰▰▰▰▰▱▱▱▱▱".
 */
function renderProgressBar(percent, length = 10) {
  const filled = Math.round(percent * length);
  return '▰'.repeat(filled) + '▱'.repeat(length - filled);
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
  getTierInfo,
  getProgress,
  renderProgressBar,
};
