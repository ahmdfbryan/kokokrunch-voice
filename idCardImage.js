// Generator gambar "ID Card Satpam Voice" -- dipakai bareng idCardManager.js
// (yang nyimpen/nyusun datanya) buat bikin kartu identitas VISUAL (PNG),
// bukan cuma teks embed biasa. Digambar manual pake canvas (bukan
// nge-crop/nempel template gambar), jadi semua data dinamis (nama, foto
// profil Discord, tanggal, dst) beneran ke-render di kartunya.
//
// Font di-bundle sendiri di assets/fonts (lisensi OFL, bebas dipake) dan
// di-load eksplisit lewat GlobalFonts.registerFromPath -- SENGAJA nggak
// ngandelin font bawaan OS, soalnya VPS produksi (tempat bot ini jalan
// beneran) kemungkinan besar nggak punya font apa-apa ke-install, yang
// bikin teksnya bisa gagal/kosong kalau cuma pake `font-family` generik.
const path = require('path');
const fetch = require('node-fetch');
const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');
const { formatIdNo } = require('./idCardManager');

const FONTS_DIR = path.join(__dirname, 'assets', 'fonts');
GlobalFonts.registerFromPath(path.join(FONTS_DIR, 'BigShoulders-Bold.ttf'), 'ID Card Display');
GlobalFonts.registerFromPath(path.join(FONTS_DIR, 'BigShoulders-Regular.ttf'), 'ID Card Display Regular');
GlobalFonts.registerFromPath(path.join(FONTS_DIR, 'WorkSans-Regular.ttf'), 'ID Card Body');
GlobalFonts.registerFromPath(path.join(FONTS_DIR, 'WorkSans-Bold.ttf'), 'ID Card Body Bold');

const WIDTH = 1200;
const HEIGHT = 800;

const COLORS = {
  bg: '#0a0c11',
  bgGradientTop: '#0f131c',
  border: '#242938',
  accent: '#3b82f6', // biru "Satpam Voice"
  accentDark: '#1d4ed8',
  white: '#f5f6f8',
  muted: '#8892a0',
  divider: '#1d2230',
};

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

/**
 * Ikon perisai sederhana (tema "Satpam") digambar manual pake path, bukan
 * emoji/gambar -- biar nggak gantung ke font emoji yang belum tentu
 * ke-install di server.
 */
function drawShield(ctx, cx, cy, w, color) {
  const h = w * 1.2;
  const top = cy - h / 2;
  const bottom = cy + h / 2;
  ctx.beginPath();
  ctx.moveTo(cx - w / 2, top + h * 0.12);
  ctx.lineTo(cx, top);
  ctx.lineTo(cx + w / 2, top + h * 0.12);
  ctx.lineTo(cx + w / 2, top + h * 0.55);
  ctx.quadraticCurveTo(cx + w / 2, bottom - h * 0.05, cx, bottom);
  ctx.quadraticCurveTo(cx - w / 2, bottom - h * 0.05, cx - w / 2, top + h * 0.55);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

/**
 * Ikon kalender kecil (dipake di baris "Join Server" / "Dibuat Tanggal").
 */
function drawCalendarIcon(ctx, x, y, size, color) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = Math.max(2, size * 0.08);
  roundRectPath(ctx, x, y, size, size, size * 0.18);
  ctx.stroke();
  const headerH = size * 0.28;
  roundRectPath(ctx, x, y, size, headerH, [size * 0.18, size * 0.18, 0, 0]);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x + size * 0.25, y - size * 0.05, size * 0.05, 0, Math.PI * 2);
  ctx.arc(x + size * 0.75, y - size * 0.05, size * 0.05, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.rect(x + size * 0.2, y + size * 0.5, size * 0.2, size * 0.18);
  ctx.fill();
  ctx.restore();
}

function formatDate(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

/**
 * Ambil avatar Discord user sebagai Image object siap digambar. Kalau
 * gagal (network/format aneh), balikin null -- caller gambar placeholder
 * abu-abu polos biar kartunya tetep jadi walau fotonya nggak ke-load.
 */
async function fetchAvatarImage(avatarURL) {
  try {
    const res = await fetch(avatarURL);
    if (!res.ok) return null;
    const buf = await res.buffer();
    return await loadImage(buf);
  } catch {
    return null;
  }
}

/**
 * Gambar 1 baris "LABEL : value" di kolom kiri kartu, plus divider tipis
 * di bawahnya. Balikin y buat baris berikutnya.
 */
function drawFieldRow(ctx, label, value, x, y, valueMaxWidth) {
  ctx.textBaseline = 'alphabetic';
  ctx.font = '22px "ID Card Body"';
  ctx.fillStyle = COLORS.muted;
  ctx.fillText(label.toUpperCase(), x, y);

  ctx.font = 'bold 24px "ID Card Body Bold"';
  ctx.fillStyle = COLORS.accent;
  ctx.fillText(':', x + 230, y);

  ctx.font = 'bold 30px "ID Card Body Bold"';
  ctx.fillStyle = COLORS.white;
  let text = value;
  while (ctx.measureText(text).width > valueMaxWidth && text.length > 1) {
    text = text.slice(0, -1);
  }
  if (text !== value) text = text.replace(/.{3}$/, '...');
  ctx.fillText(text, x + 270, y);

  ctx.strokeStyle = COLORS.divider;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, y + 24);
  ctx.lineTo(x + 740, y + 24);
  ctx.stroke();
}

/**
 * Render 1 ID Card jadi PNG Buffer. `card` = hasil dari idCardStore
 * (idNo, nama, jenisKelamin, domisili, citaCita, hobi, joinServerAt,
 * createdAt). `discordUser` butuh `.displayAvatarURL()`. `guildName`
 * opsional, ditampilin kecil di pojok kanan atas.
 */
async function renderIdCardImage(card, discordUser, guildName) {
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext('2d');

  // Background gradient gelap + border tipis
  const bgGradient = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT);
  bgGradient.addColorStop(0, COLORS.bgGradientTop);
  bgGradient.addColorStop(1, COLORS.bg);
  roundRectPath(ctx, 0, 0, WIDTH, HEIGHT, 32);
  ctx.fillStyle = bgGradient;
  ctx.fill();
  ctx.strokeStyle = COLORS.border;
  ctx.lineWidth = 2;
  roundRectPath(ctx, 2, 2, WIDTH - 4, HEIGHT - 4, 30);
  ctx.stroke();

  // Watermark besar transparan "SV" di kanan bawah, biar kerasa "branded"
  // tanpa ganggu keterbacaan teks di atasnya.
  ctx.save();
  ctx.font = 'bold 340px "ID Card Display"';
  ctx.fillStyle = 'rgba(59, 130, 246, 0.05)';
  ctx.textAlign = 'right';
  ctx.fillText('SV', WIDTH - 40, HEIGHT - 40);
  ctx.restore();

  // Pita/ribbon biru pojok kiri atas + ikon perisai putih di atasnya
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(126, 0);
  ctx.lineTo(126, 176);
  ctx.lineTo(63, 208);
  ctx.lineTo(0, 176);
  ctx.closePath();
  const ribbonGradient = ctx.createLinearGradient(0, 0, 126, 0);
  ribbonGradient.addColorStop(0, COLORS.accentDark);
  ribbonGradient.addColorStop(1, COLORS.accent);
  ctx.fillStyle = ribbonGradient;
  ctx.fill();
  drawShield(ctx, 63, 88, 56, COLORS.white);

  // Judul "SATPAM" + "VOICE" (aksen biru) + "ID CARD"
  ctx.textAlign = 'left';
  ctx.font = 'bold 62px "ID Card Display"';
  ctx.fillStyle = COLORS.white;
  ctx.fillText('SATPAM ', 168, 108);
  const satpamWidth = ctx.measureText('SATPAM ').width;
  ctx.fillStyle = COLORS.accent;
  ctx.fillText('VOICE', 168 + satpamWidth, 108);

  ctx.font = '28px "ID Card Body"';
  ctx.fillStyle = COLORS.muted;
  ctx.fillText('K A R T U   I D E N T I T A S   M E M B E R', 172, 150);

  ctx.fillStyle = COLORS.accent;
  ctx.fillRect(172, 168, 90, 4);

  // Nama server, pojok kanan atas
  if (guildName) {
    ctx.textAlign = 'right';
    ctx.font = '24px "ID Card Body"';
    ctx.fillStyle = COLORS.muted;
    ctx.fillText(`${guildName.toUpperCase()}  |`, WIDTH - 50, 62);
    ctx.textAlign = 'left';
  }

  // Kolom kiri: field-field ID Card
  const leftX = 90;
  let rowY = 290;
  const rowGap = 78;
  drawFieldRow(ctx, 'ID No', formatIdNo(card.idNo), leftX, rowY, 480);
  rowY += rowGap;
  drawFieldRow(ctx, 'Nama', card.nama, leftX, rowY, 480);
  rowY += rowGap;
  drawFieldRow(ctx, 'Jenis Kelamin', card.jenisKelamin, leftX, rowY, 480);
  rowY += rowGap;
  drawFieldRow(ctx, 'Domisili', card.domisili, leftX, rowY, 480);
  rowY += rowGap;
  drawFieldRow(ctx, 'Cita - Cita', card.citaCita, leftX, rowY, 480);
  rowY += rowGap;
  drawFieldRow(ctx, 'Hobi', card.hobi, leftX, rowY, 480);

  // Kolom kanan: foto profil Discord dalam kotak rounded + border aksen
  const avatarSize = 260;
  const avatarX = WIDTH - 90 - avatarSize;
  const avatarY = 290;
  const avatarURL = discordUser.displayAvatarURL({ extension: 'png', size: 512 });
  const avatarImg = await fetchAvatarImage(avatarURL);

  ctx.save();
  roundRectPath(ctx, avatarX, avatarY, avatarSize, avatarSize, 24);
  ctx.clip();
  if (avatarImg) {
    const scale = Math.max(avatarSize / avatarImg.width, avatarSize / avatarImg.height);
    const drawW = avatarImg.width * scale;
    const drawH = avatarImg.height * scale;
    ctx.drawImage(avatarImg, avatarX + (avatarSize - drawW) / 2, avatarY + (avatarSize - drawH) / 2, drawW, drawH);
  } else {
    ctx.fillStyle = '#1c2230';
    ctx.fillRect(avatarX, avatarY, avatarSize, avatarSize);
    ctx.fillStyle = COLORS.muted;
    ctx.font = 'bold 100px "ID Card Display"';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText((card.nama || '?').charAt(0).toUpperCase(), avatarX + avatarSize / 2, avatarY + avatarSize / 2);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }
  ctx.restore();
  ctx.strokeStyle = COLORS.accent;
  ctx.lineWidth = 4;
  roundRectPath(ctx, avatarX, avatarY, avatarSize, avatarSize, 24);
  ctx.stroke();

  // Tanggal join server & dibuat, di bawah foto
  const dateBlockX = avatarX;
  let dateY = avatarY + avatarSize + 44;
  drawCalendarIcon(ctx, dateBlockX, dateY - 22, 30, COLORS.accent);
  ctx.font = '20px "ID Card Body"';
  ctx.fillStyle = COLORS.muted;
  ctx.fillText('JOIN SERVER', dateBlockX + 42, dateY - 4);
  ctx.font = 'bold 26px "ID Card Body Bold"';
  ctx.fillStyle = COLORS.white;
  ctx.fillText(formatDate(card.joinServerAt), dateBlockX + 42, dateY + 24);

  dateY += 76;
  drawCalendarIcon(ctx, dateBlockX, dateY - 22, 30, COLORS.accent);
  ctx.font = '20px "ID Card Body"';
  ctx.fillStyle = COLORS.muted;
  ctx.fillText('DIBUAT TANGGAL', dateBlockX + 42, dateY - 4);
  ctx.font = 'bold 26px "ID Card Body Bold"';
  ctx.fillStyle = COLORS.white;
  ctx.fillText(formatDate(card.createdAt), dateBlockX + 42, dateY + 24);

  // Footer kiri bawah: ikon perisai kecil + "KokoKrunch Studios"
  drawShield(ctx, 106, HEIGHT - 68, 30, COLORS.accent);
  ctx.font = '22px "ID Card Body"';
  ctx.fillStyle = COLORS.muted;
  ctx.fillText('|', 130, HEIGHT - 58);
  ctx.font = 'bold 24px "ID Card Body Bold"';
  ctx.fillStyle = COLORS.white;
  ctx.fillText('KokoKrunch Studios', 148, HEIGHT - 58);

  return canvas.toBuffer('image/png');
}

module.exports = { renderIdCardImage };
