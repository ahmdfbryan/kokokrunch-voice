const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DATA_PATH = path.join(DATA_DIR, 'panels.json');

// { [channelId]: { panelMessageId, screen } } -- satu panel per channel,
// diaktifkan manual lewat /panel (mirip pola sticky message). `screen`
// nyimpen SNAPSHOT (embed + components, hasil .toJSON()) dari layar panel
// yang lagi kebuka (Featured, Streak, Musik, dst) -- null kalau lagi di
// Panel Utama (Home). Dipakai pas reposisi panel (chat rame -> panel
// dikirim ulang di bawah) biar user nggak ke-reset balik ke Home tiap kali
// ada chat baru, tetep di layar yang lagi mereka buka.
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

function setPanel(channelId) {
  data[channelId] = { panelMessageId: null, screen: null, v2: true };
  saveSync();
}

function removePanel(channelId) {
  const had = !!data[channelId];
  delete data[channelId];
  saveSync();
  return had;
}

function getPanel(channelId) {
  return data[channelId] || null;
}

function setPanelMessageId(channelId, messageId) {
  if (!data[channelId]) return;
  data[channelId].panelMessageId = messageId;
  saveSync();
}

/**
 * Simpan snapshot layar panel yang lagi kebuka di channel ini (atau null
 * buat nandain "lagi di Home", yang sengaja NGGAK disnapshot biar stats-nya
 * -- uptime/ping -- tetep fresh tiap kali panel direposisi/dikirim ulang).
 */
function setPanelScreen(channelId, screen) {
  if (!data[channelId]) return;
  data[channelId].screen = screen;
  saveSync();
}

function getPanelScreen(channelId) {
  return data[channelId]?.screen || null;
}

/**
 * Migrasi ke Components V2: pesan panel LAMA (format embed) nggak bisa
 * di-edit jadi V2 -- harus dikirim ulang. Panel dianggap "sudah V2" kalau
 * ada flag `v2` di datanya (dibuat otomatis oleh setPanel / markPanelV2).
 */
function listPanelsNeedingV2() {
  return Object.entries(data)
    .filter(([, panel]) => panel && !panel.v2)
    .map(([channelId]) => channelId);
}

function markPanelV2(channelId) {
  if (!data[channelId]) return;
  data[channelId].v2 = true;
  data[channelId].screen = null; // snapshot layar lama (format embed) dibuang, balik ke Home
  saveSync();
}

module.exports = { listPanelsNeedingV2, markPanelV2, load, setPanel, removePanel, getPanel, setPanelMessageId, setPanelScreen, getPanelScreen };
