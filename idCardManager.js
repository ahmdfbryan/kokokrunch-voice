// Fitur "ID Card Satpam Voice" -- kartu identitas member yang dibikin
// sendiri (Nama, Jenis Kelamin, Domisili, Cita-Cita, Hobi lewat modal),
// sisanya (ID No, Join Server, Dibuat Tanggal, foto profil Discord)
// digenerate otomatis sama bot.

const { EmbedBuilder } = require('discord.js');

const ID_CARD_COLOR = 0x1b2838; // navy gelap, senada branding "Satpam Voice"
const FIELD_MAX_LENGTH = 100;

// Urutan & label field yang diinput lewat modal "Buat ID" -- dipakai juga
// buat mapping customId TextInput <-> nama field di objek card.
const INPUT_FIELDS = [
  { key: 'nama', customId: 'panelid_nama', label: 'Nama' },
  { key: 'jenisKelamin', customId: 'panelid_jekel', label: 'Jenis Kelamin' },
  { key: 'domisili', customId: 'panelid_domisili', label: 'Domisili' },
  { key: 'citaCita', customId: 'panelid_citacita', label: 'Cita-Cita' },
  { key: 'hobi', customId: 'panelid_hobi', label: 'Hobi' },
];

/**
 * Validasi & bersihin 1 nilai input field ID Card. Balikin `{ ok, value }`
 * atau `{ ok:false, reason }`.
 */
function sanitizeField(rawValue) {
  const trimmed = (rawValue || '').trim();
  if (!trimmed) return { ok: false, reason: 'empty' };
  if (trimmed.length > FIELD_MAX_LENGTH) return { ok: false, reason: 'too_long' };
  return { ok: true, value: trimmed };
}

/**
 * ID No ditampilin format "SV-0001" biar kerasa kayak nomor identitas
 * beneran, bukan cuma angka polos.
 */
function formatIdNo(idNo) {
  return `SV-${String(idNo).padStart(4, '0')}`;
}

/**
 * Embed "ID Card" -- sengaja full teks di description (BUKAN field
 * inline), biar render-nya konsisten sama persis di HP maupun desktop
 * (pelajaran yang sama kayak layout panel utama -- field inline suka
 * bikin jarak aneh di HP).
 */
function buildIdCardEmbed(card, discordUser, guildName) {
  const avatarURL = discordUser.displayAvatarURL({ extension: 'png', size: 512 });
  const joinDate = card.joinServerAt ? `<t:${Math.floor(card.joinServerAt / 1000)}:D>` : '-';
  const createdDate = `<t:${Math.floor(card.createdAt / 1000)}:D>`;

  return new EmbedBuilder()
    .setColor(ID_CARD_COLOR)
    .setAuthor({ name: '🪪  ID CARD — SATPAM VOICE' })
    .setThumbnail(avatarURL)
    .setDescription(
      [
        `**ID No:** \`${formatIdNo(card.idNo)}\``,
        `**Nama:** ${card.nama}`,
        `**Jenis Kelamin:** ${card.jenisKelamin}`,
        `**Domisili:** ${card.domisili}`,
        `**Cita-Cita:** ${card.citaCita}`,
        `**Hobi:** ${card.hobi}`,
        '',
        `**Join Server:** ${joinDate}`,
        `**Dibuat Tanggal:** ${createdDate}`,
      ].join('\n')
    )
    .setFooter({ text: guildName ? `${guildName} • KokoKrunch Studios` : 'KokoKrunch Studios' });
}

module.exports = {
  ID_CARD_COLOR,
  FIELD_MAX_LENGTH,
  INPUT_FIELDS,
  sanitizeField,
  formatIdNo,
  buildIdCardEmbed,
};
