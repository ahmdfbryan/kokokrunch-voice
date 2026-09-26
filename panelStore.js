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
  data[channelId] = { panelMessageId: null, screen: null };
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

module.exports = { load, setPanel, removePanel, getPanel, setPanelMessageId, setPanelScreen, getPanelScreen };
