const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DATA_PATH = path.join(DATA_DIR, 'idCards.json');

// {
//   cards: { [guildId]: { [userId]: {
//     idNo, nama, jenisKelamin, domisili, citaCita, hobi,
//     joinServerAt, createdAt
//   } } },
//   counters: { [guildId]: number }  -- ID No terakhir yang kepake di guild itu,
//                                        biar tiap ID No unik & jalan urut per server
// }
let data = { cards: {}, counters: {} };

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
    data = { cards: parsed.cards || {}, counters: parsed.counters || {} };
  } catch {
    data = { cards: {}, counters: {} };
  }
}

function saveSync() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmpPath = `${DATA_PATH}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, DATA_PATH); // atomic replace, biar file nggak korup kalau proses mati pas nulis
}

function getCard(guildId, userId) {
  return (data.cards[guildId] && data.cards[guildId][userId]) || null;
}

function hasCard(guildId, userId) {
  return !!getCard(guildId, userId);
}

function nextIdNo(guildId) {
  const current = data.counters[guildId] || 0;
  const next = current + 1;
  data.counters[guildId] = next;
  return next;
}

/**
 * Bikin ID Card baru buat 1 user di 1 guild. `fields` = { nama,
 * jenisKelamin, domisili, citaCita, hobi } (udah divalidasi di
 * idCardManager sebelum sampe sini). Cuma boleh 1 ID Card per user per
 * guild -- pengecekan `hasCard` dilakuin di caller (index.js) sebelum
 * modal ditampilin.
 */
function createCard(guildId, userId, fields, joinServerAt) {
  if (!data.cards[guildId]) data.cards[guildId] = {};
  const idNo = nextIdNo(guildId);
  const card = {
    idNo,
    ...fields,
    joinServerAt: joinServerAt || null,
    createdAt: Date.now(),
  };
  data.cards[guildId][userId] = card;
  saveSync();
  return card;
}

module.exports = {
  load,
  getCard,
  hasCard,
  createCard,
};
