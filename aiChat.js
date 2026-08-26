const { GoogleGenAI } = require('@google/genai');
const config = require('./config');

const ai = new GoogleGenAI({ apiKey: config.geminiApiKey });
const MODEL = config.geminiModel;

// Maksimal berapa "pertukaran" (user+model) yang disimpan per user, biar
// konteks percakapan nggak membengkak terus (biaya token + relevansi).
const MAX_HISTORY_TURNS = 12;
// Kalau user nggak chat lagi selama ini, percakapannya dianggap "selesai"
// dan mulai dari nol lagi pas dia nyapa lagi.
const IDLE_RESET_MS = 30 * 60 * 1000;

// userId -> { history: Content[], lastActive: number }
const sessions = new Map();

function getSession(userId) {
  const now = Date.now();
  const existing = sessions.get(userId);
  if (existing && now - existing.lastActive < IDLE_RESET_MS) {
    existing.lastActive = now;
    return existing;
  }
  const fresh = { history: [], lastActive: now };
  sessions.set(userId, fresh);
  return fresh;
}

function trimHistory(history) {
  const maxItems = MAX_HISTORY_TURNS * 2; // user + model per turn
  if (history.length > maxItems) {
    history.splice(0, history.length - maxItems);
  }
}

/**
 * Tanya-jawab sekali, tanpa nyimpen konteks percakapan. Dipakai buat /ask.
 */
async function askOnce(prompt) {
  const response = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
  });
  return response.text || '(Gemini tidak memberikan balasan.)';
}

/**
 * Chat multi-turn per user (inget percakapan sebelumnya). Dipakai buat
 * fitur mention-chat.
 */
async function chatReply(userId, message) {
  const session = getSession(userId);
  session.history.push({ role: 'user', parts: [{ text: message }] });

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: session.history,
  });

  const replyText = response.text || '(Gemini tidak memberikan balasan.)';
  session.history.push({ role: 'model', parts: [{ text: replyText }] });
  trimHistory(session.history);

  return replyText;
}

function resetSession(userId) {
  sessions.delete(userId);
}

/**
 * Discord batasin pesan biasa maks 2000 karakter -- pecah jadi beberapa
 * bagian kalau jawaban AI-nya lebih panjang dari itu, sebisa mungkin motong
 * di baris baru biar nggak motong kalimat di tengah-tengah.
 */
function splitIntoChunks(text, maxLen = 2000) {
  if (text.length <= maxLen) return [text];

  const chunks = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    const newlineIdx = remaining.lastIndexOf('\n', maxLen);
    const cut = newlineIdx > 0 ? Math.min(newlineIdx + 1, maxLen) : maxLen;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

module.exports = { askOnce, chatReply, resetSession, splitIntoChunks };
