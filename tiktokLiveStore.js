const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DATA_PATH = path.join(DATA_DIR, 'tiktokLive.json');

// Nyimpen username TikTok yang lagi dipantau buat fitur "!request" -- biar
// SIAPAPUN (bukan cuma pemilik bot) bisa ganti lewat tombol "TikTok" di
// panel utama tanpa perlu edit .env / restart bot, dan settingnya nempel
// (survive restart). { username, setByTag, setAt } atau semuanya null
// kalau fiturnya lagi dimatikan/belum pernah diisi siapa-siapa.
let data = { username: null, setByTag: null, setAt: null };

function load() {
  try {
    data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  } catch {
    data = { username: null, setByTag: null, setAt: null };
  }
}

function saveSync() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmpPath = `${DATA_PATH}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, DATA_PATH); // atomic replace, biar file nggak korup kalau proses mati pas nulis
}

function get() {
  return { ...data };
}

function set(username, setByTag) {
  data = { username, setByTag: setByTag || null, setAt: Date.now() };
  saveSync();
}

function clear() {
  data = { username: null, setByTag: null, setAt: null };
  saveSync();
}

module.exports = { load, get, set, clear };
