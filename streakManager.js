// Sistem "Grup Streak Chat": beberapa orang bikin grup, lalu tiap hari
// (window mulai jam 23:00 WIB, tetap aktif sampai jam segitu lagi besok)
// streak-nya nyala kalau minimal REQUIRED_CHECKINS member grup itu ngirim
// pesan APAPUN di channel manapun di server (nggak perlu thread khusus).
// Grup baru mulai dihitung setelah anggotanya nyampe MIN_MEMBERS_TO_START.

const { EmbedBuilder } = require('discord.js');
const streakStore = require('./streakStore');

const MIN_MEMBERS_TO_START = 3;
const REQUIRED_CHECKINS = 2;
const MAX_MEMBERS = 15;
const MAX_NAME_LENGTH = 32;
const STREAK_COLOR = 0x3b82f6; // biru, senada sama warna panel & ID Card
const LEADERBOARD_RANK_ICONS = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

/**
 * Nama tampilan grup -- kalau owner belum kasih nama (grup lama sebelum
 * fitur ini ada, atau sengaja dikosongin), fallback ke "Grup <mention
 * owner>" biar tetep jelas punya siapa.
 */
function getGroupDisplayName(group) {
  return group.name || `Grup <@${group.ownerId}>`;
}

/**
 * Validasi & bersihin nama grup dari input user (modal "Buat Grup" /
 * "Ganti Nama"). Balikin `{ ok, name }` atau `{ ok:false, reason }`.
 */
function sanitizeGroupName(rawName) {
  const trimmed = (rawName || '').trim();
  if (!trimmed) return { ok: false, reason: 'empty' };
  if (trimmed.length > MAX_NAME_LENGTH) return { ok: false, reason: 'too_long' };
  return { ok: true, name: trimmed };
}

/**
 * "Hari streak" dihitung dari jam 23:00 WIB, bukan jam 00:00 -- window
 * buat tanggal D itu D 23:00 sampai (D+1) 23:00. Jadi kalau sekarang jam
 * WIB-nya masih di bawah 23:00, itu masih bagian dari window yang dimulai
 * KEMARIN jam 23:00.
 */
function getStreakDayKey(date = new Date()) {
  const wib = new Date(date.getTime() + 7 * 60 * 60 * 1000);
  const hour = wib.getUTCHours();
  const shifted = hour < 23 ? new Date(wib.getTime() - 24 * 60 * 60 * 1000) : wib;
  return shifted.toISOString().slice(0, 10);
}

function nextDayKey(dayKey) {
  const d = new Date(`${dayKey}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function isActive(group) {
  return group.memberIds.length >= MIN_MEMBERS_TO_START;
}

/**
 * Dipanggil dari messageCreate (index.js) tiap ada pesan non-bot di guild.
 * Kalau pengirimnya anggota grup streak yang udah aktif, catet dia
 * "checkin" buat window yang lagi berjalan sekarang.
 */
function handleMessageForStreak(guildId, userId) {
  const groups = streakStore.getAllGroups(guildId).filter((g) => isActive(g) && g.memberIds.includes(userId));
  if (groups.length === 0) return;
  const dayKey = getStreakDayKey();
  for (const g of groups) {
    streakStore.recordCheckin(g.id, dayKey, userId);
  }
}

/**
 * Finalisasi window yang udah lewat buat SEMUA grup di semua guild --
 * dipanggil berkala (interval) + sekali pas startup. Grup yang belum aktif
 * (member < MIN_MEMBERS_TO_START) di-skip, checkin lamanya dibersihin biar
 * nggak numpuk.
 */
function tickAllGroups() {
  const nowKey = getStreakDayKey();
  const all = streakStore.getAllGroups();

  for (const group of all) {
    if (!isActive(group)) {
      if (group.lastFinalizedDayKey !== nowKey) {
        group.checkins = {};
        group.lastFinalizedDayKey = nowKey;
        streakStore.saveGroup(group);
      }
      continue;
    }

    let cursor = group.lastFinalizedDayKey;
    let changed = false;
    let guard = 0;
    while (cursor !== nowKey && guard < 3650) {
      const checkinCount = (group.checkins[cursor] || []).length;
      if (checkinCount >= REQUIRED_CHECKINS) {
        group.currentStreak += 1;
        group.longestStreak = Math.max(group.longestStreak, group.currentStreak);
      } else {
        group.currentStreak = 0;
      }
      delete group.checkins[cursor];
      cursor = nextDayKey(cursor);
      guard += 1;
      changed = true;
    }
    if (changed) {
      group.lastFinalizedDayKey = nowKey;
      streakStore.saveGroup(group);
    }
  }
}

/**
 * Embed penjelasan fitur ("Grup Streak Chat") -- konten statis, ditampilkan
 * pas tombol "Streak" di sub-menu panel diklik.
 */
function buildStreakInfoEmbed() {
  return new EmbedBuilder()
    .setColor(STREAK_COLOR)
    .setTitle('🔥 Grup Streak Chat')
    .setDescription(
      [
        'Bikin atau kelola grup buat ikutan Daily Streak Chat.',
        '',
        '**Cara kerja:**',
        '• Anggota grup bebas ngobrol di channel MANAPUN di server -- nggak perlu thread khusus.',
        '• Pas bikin grup, kamu kasih **nama grup** sendiri -- bisa diganti kapan aja lewat tombol **Ganti Nama** di **Grup Saya** (owner only).',
        `• Grup butuh minimal **${MIN_MEMBERS_TO_START} member** (maks ${MAX_MEMBERS}) buat bisa mulai nyalain streak.`,
        '• Invite member lain lewat tombol **Grup Saya** (owner only).',
        '• Window baru muncul tiap hari jam **23:00 WIB**, dan tetap aktif (bisa chat kapan aja) sampai jam segitu lagi besok.',
        `• Streak nyala kalau ada minimal **${REQUIRED_CHECKINS} member** grup yang chat dalam 1 window itu.`,
        '• Kalau belum nyala pas window besok muncul, streak grup balik ke 0.',
        '• Cek ranking semua grup lewat tombol **Leaderboard**.',
      ].join('\n')
    )
    .setFooter({ text: 'KokoKrunch Studios' })
    .setTimestamp();
}

/**
 * Embed status satu grup -- dipakai pas tombol "Grup Saya" diklik.
 */
function buildGroupStatusEmbed(group, requestingUserId) {
  const isOwner = group.ownerId === requestingUserId;
  const dayKey = getStreakDayKey();
  const todaysCheckins = group.checkins[dayKey] || [];
  const active = isActive(group);

  const memberList = group.memberIds.map((id) => `<@${id}>`).join(', ');

  let statusLine;
  if (!active) {
    const needed = MIN_MEMBERS_TO_START - group.memberIds.length;
    statusLine = `⏳ Belum aktif -- butuh **${needed} member** lagi buat mulai nyalain streak.`;
  } else if (todaysCheckins.length >= REQUIRED_CHECKINS) {
    statusLine = `🔥 Window ini **UDAH NYALA** (${todaysCheckins.length}/${REQUIRED_CHECKINS} member udah chat)`;
  } else {
    const needed = REQUIRED_CHECKINS - todaysCheckins.length;
    statusLine = `⚠️ Butuh **${needed} checkin** lagi buat nyalain window ini (${todaysCheckins.length}/${REQUIRED_CHECKINS} udah chat)`;
  }

  return new EmbedBuilder()
    .setColor(STREAK_COLOR)
    .setAuthor({ name: `${isOwner ? '👑' : '👥'} ${getGroupDisplayName(group)}` })
    .setDescription(
      [
        `**Anggota (${group.memberIds.length}/${MAX_MEMBERS}):** ${memberList}`,
        '',
        `🔥 **Streak Sekarang:** ${group.currentStreak} hari`,
        `🏆 **Streak Terpanjang:** ${group.longestStreak} hari`,
        '',
        statusLine,
        '',
        '_Window reset tiap jam 23:00 WIB._',
      ].join('\n')
    );
}

/**
 * Embed "Leaderboard Streak" -- ranking grup streak di server ini,
 * diurutkan dari streak SEKARANG paling tinggi (tie-break streak
 * terpanjang). Dipakai dari tombol "Leaderboard" di sub-menu panel Streak,
 * hasilnya ditampilkan publik ke channel (sama kayak Voice Leaderboard).
 */
function buildStreakLeaderboardEmbed(guildId) {
  const groups = streakStore.getAllGroups(guildId);

  if (groups.length === 0) {
    return new EmbedBuilder().setColor(0x99aab5).setDescription('📭 Belum ada grup streak sama sekali di server ini.');
  }

  const sorted = [...groups].sort((a, b) => b.currentStreak - a.currentStreak || b.longestStreak - a.longestStreak);

  const blocks = sorted.slice(0, 10).map((group, i) => {
    const icon = LEADERBOARD_RANK_ICONS[i] || `#${i + 1}`;
    const statusEmoji = isActive(group) ? '🔥' : '⏳';
    return [
      `${icon}  ➜  **${getGroupDisplayName(group)}**`,
      `${statusEmoji} Streak Sekarang: **${group.currentStreak} hari** • Terpanjang: **${group.longestStreak} hari**`,
      `👥 Anggota: ${group.memberIds.length}/${MAX_MEMBERS}`,
    ].join('\n');
  });

  return new EmbedBuilder()
    .setColor(STREAK_COLOR)
    .setTitle('🏆 Leaderboard Streak')
    .setDescription(blocks.join('\n\n'))
    .setFooter({ text: 'KokoKrunch Studios' });
}

module.exports = {
  MIN_MEMBERS_TO_START,
  REQUIRED_CHECKINS,
  MAX_MEMBERS,
  MAX_NAME_LENGTH,
  getStreakDayKey,
  isActive,
  handleMessageForStreak,
  tickAllGroups,
  getGroupDisplayName,
  sanitizeGroupName,
  buildStreakInfoEmbed,
  buildGroupStatusEmbed,
  buildStreakLeaderboardEmbed,
};
