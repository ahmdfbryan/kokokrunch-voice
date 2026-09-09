const { EmbedBuilder } = require('discord.js');

const COLOR = 0x5865f2;

/**
 * Bikin embed teks polos: cuma garis + background biru di kiri, tanpa
 * judul/thumbnail/footer. Dipakai buat semua pesan singkat bot.
 */
function textEmbed(text) {
  return new EmbedBuilder().setColor(COLOR).setDescription(text);
}

/**
 * Format detik jadi teks panjang gampang dibaca, misal "1 jam 5 menit"
 * atau "Sekarang" buat ETA 0.
 */
function formatEta(totalSeconds) {
  if (totalSeconds <= 0) return 'Sekarang';
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  const parts = [];
  if (h > 0) parts.push(`${h} jam`);
  if (m > 0) parts.push(`${m} menit`);
  if (h === 0 && m === 0) parts.push(`${s} detik`);
  return parts.join(' ');
}

function formatTotalDuration(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const parts = [];
  if (h > 0) parts.push(`${h} jam`);
  parts.push(`${m} menit`);
  return parts.join(' ');
}

module.exports = { COLOR, textEmbed, formatEta, formatTotalDuration };
