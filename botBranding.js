// Footer brand standar dipakai di SEMUA fitur -- logo bot (foto profil
// Discord bot-nya sendiri) + teks "Satpam Voice" + timestamp NATIVE Discord
// (otomatis dirender client jadi "Satpam Voice • Today at HH:MM AM/PM").
// Disatuin di 1 modul kecil ini biar semua fitur (Panel, ID Card, Streak,
// Welcome Message, Now Playing, Giveaway, dst) konsisten formatnya & gampang
// diganti sekaligus kalau suatu saat mau diubah lagi -- daripada nulis
// `.setFooter({text: '...'})` sendiri-sendiri di tiap file fitur.

const BRAND_FOOTER_TEXT = 'Satpam Voice';

let botAvatarURL = null;

/**
 * Dipanggil SEKALI dari index.js pas bot ready (dan boleh dipanggil ulang
 * kapan aja kalau avatar bot ganti) -- biar semua modul fitur lain bisa
 * pakai foto profil bot yang sama tanpa perlu di-passing manual ke tiap
 * fungsi builder embed.
 */
function setBotAvatarURL(url) {
  botAvatarURL = url || null;
}

/**
 * Terapkan footer brand standar (logo bot + "Satpam Voice") + timestamp ke
 * sebuah EmbedBuilder yang udah dibikin. Balikin embed yang sama (chainable)
 * biar gampang dipakai di akhir fungsi builder embed manapun.
 */
function applyBrandFooter(embed) {
  return embed.setFooter({ text: BRAND_FOOTER_TEXT, iconURL: botAvatarURL || undefined }).setTimestamp();
}

module.exports = { setBotAvatarURL, applyBrandFooter, BRAND_FOOTER_TEXT };
