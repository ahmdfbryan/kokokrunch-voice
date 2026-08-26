const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DATA_PATH = path.join(DATA_DIR, 'stickyMessages.json');

// { [channelId]: { content, embeds: [...json], stickyMessageId } }
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

function setSticky(channelId, { content, embeds }) {
  data[channelId] = { content: content || '', embeds: embeds || [], stickyMessageId: null };
  saveSync();
}

function removeSticky(channelId) {
  const had = !!data[channelId];
  delete data[channelId];
  saveSync();
  return had;
}

function getSticky(channelId) {
  return data[channelId] || null;
}

function setStickyMessageId(channelId, messageId) {
  if (!data[channelId]) return;
  data[channelId].stickyMessageId = messageId;
  saveSync();
}

module.exports = { load, setSticky, removeSticky, getSticky, setStickyMessageId };
