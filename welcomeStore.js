const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DATA_PATH = path.join(DATA_DIR, 'welcomed.json');

// Daftar userId yang UDAH PERNAH dapet pesan sambutan di voice channel
// target -- biar pesan sambutannya cuma dikirim SEKALI seumur hidup per
// member (pas pertama kali join), bukan tiap kali dia join lagi.
let welcomedUserIds = new Set();

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
    welcomedUserIds = new Set(Array.isArray(raw) ? raw : []);
  } catch {
    welcomedUserIds = new Set();
  }
}

function saveSync() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmpPath = `${DATA_PATH}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify([...welcomedUserIds], null, 2));
  fs.renameSync(tmpPath, DATA_PATH); // atomic replace, biar file nggak korup kalau proses mati pas nulis
}

function hasBeenWelcomed(userId) {
  return welcomedUserIds.has(userId);
}

function markWelcomed(userId) {
  if (welcomedUserIds.has(userId)) return;
  welcomedUserIds.add(userId);
  saveSync();
}

module.exports = { load, hasBeenWelcomed, markWelcomed };
