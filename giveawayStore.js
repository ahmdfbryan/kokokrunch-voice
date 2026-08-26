const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'giveaways.json');
let writeChain = Promise.resolve();

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '[]', 'utf8');
}

function loadAll() {
  ensureFile();
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8') || '[]');
  } catch (err) {
    console.error('[giveaway-storage] Gagal baca giveaways.json, mulai dari kosong:', err);
    return [];
  }
}

function saveAll(giveaways) {
  ensureFile();
  writeChain = writeChain.then(
    () =>
      new Promise((resolve, reject) => {
        const tmpFile = `${DATA_FILE}.tmp`;
        fs.writeFile(tmpFile, JSON.stringify(giveaways, null, 2), 'utf8', (err) => {
          if (err) return reject(err);
          fs.rename(tmpFile, DATA_FILE, (err2) => (err2 ? reject(err2) : resolve()));
        });
      })
  );
  return writeChain;
}

module.exports = { loadAll, saveAll };
