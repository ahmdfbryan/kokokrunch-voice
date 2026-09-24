const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DATA_PATH = path.join(DATA_DIR, 'panels.json');

// { [channelId]: { panelMessageId } } -- satu panel per channel, diaktifkan
// manual lewat /panel (mirip pola sticky message).
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
  data[channelId] = { panelMessageId: null };
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

module.exports = { load, setPanel, removePanel, getPanel, setPanelMessageId };
