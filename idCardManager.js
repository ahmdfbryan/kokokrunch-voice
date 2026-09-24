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
 * Embed pembungkus buat gambar ID Card yang digambar canvas (lihat
 * idCardImage.js) -- semua data (nama, foto, tanggal, dst) udah tampil di
 * GAMBARNYA, jadi embed ini sengaja cuma judul singkat + attachment
 * gambarnya, nggak ngulang isi field lagi dalam bentuk teks.
 * `attachmentFileName` harus SAMA PERSIS kayak nama file yang dipasang di
 * AttachmentBuilder pas dikirim (lihat index.js).
 */
function buildIdCardEmbed(card, attachmentFileName) {
  return new EmbedBuilder()
    .setColor(ID_CARD_COLOR)
    .setAuthor({ name: `🪪  ID Card — ${formatIdNo(card.idNo)}` })
    .setImage(`attachment://${attachmentFileName}`)
    .setFooter({ text: 'KokoKrunch Studios' });
}

module.exports = {
  ID_CARD_COLOR,
  FIELD_MAX_LENGTH,
  INPUT_FIELDS,
  sanitizeField,
  formatIdNo,
  buildIdCardEmbed,
};
