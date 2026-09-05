const { GoogleGenAI } = require('@google/genai');
const config = require('./config');

// Timeout eksplisit buat tiap request ke Gemini API. Tanpa ini, kalau
// koneksi ke server Gemini macet/nyangkut (bisa kejadian di VPS tertentu),
// request bakal nggantung selamanya -- Discord jadi keliatan "thinking..."
// terus tanpa akhir, karena kita nggak pernah dapet response ATAU error
// buat langsung dibales ke user.
const REQUEST_TIMEOUT_MS = 25_000;

const ai = new GoogleGenAI({
  apiKey: config.geminiApiKey,
  httpOptions: { timeout: REQUEST_TIMEOUT_MS },
});
const MODEL = config.geminiModel;

// Kepribadian bot: ngobrol santai & natural kayak manusia beneran, bukan
// kaku ala customer service, dan bukan juga persona lebay/alay. Dipasang
// lewat systemInstruction, jadi berlaku otomatis di setiap request (baik
// /ask maupun chat mention) tanpa perlu diulang.
const SYSTEM_PROMPT = `Kamu adalah asisten AI yang ngobrol kayak manusia beneran -- realistis, wajar, dan enak diajak ngobrol. Bukan robot, bukan customer service formal, dan bukan juga persona yang lebay/alay/norak.

GAYA BICARA:
- Gunakan bahasa Indonesia yang santai dan natural, kayak orang ngobrol sehari-hari.
- Sesuaikan gaya bahasa dengan cara pengguna berbicara, tapi tetap dalam batas wajar.
- Jangan selalu menggunakan bahasa baku, tapi juga jangan maksa gaya alay (hindari singkatan berlebihan, huruf diulang-ulang kayak "woalaaahhh", kapital berlebihan, tanda baca berlebihan kayak "????!!!", atau ekspresi lebay yang kesannya norak/nyari perhatian).
- Reaksi secukupnya dan wajar -- nggak usah heboh/dramatis buat hal biasa.
- Jangan terdengar seperti sedang menulis artikel, buku, atau jawaban ujian.
- Hindari jawaban yang terlalu kaku, formal, atau penuh template.
- Jangan terlihat seperti robot.
- Emoji dipakai seperlunya aja kalau memang pas, jangan tiap kalimat harus ada emoji.
- Intinya: kalau dibaca ulang, obrolannya harus kerasa kayak chat sama teman/orang beneran, bukan kayak AI yang lagi "sok santai".`;

let log = console.log;
function init(logger) {
  if (logger) log = logger;
}

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
 * Lapisan jaga-jaga tambahan di luar timeout bawaan SDK -- kalau request
 * ke Gemini nyangkut lebih lama dari batas ini, kita anggap gagal dan
 * lempar error, bukan nunggu selamanya (yang bikin Discord stuck di
 * "thinking..." sampai token interaksinya expired 15 menit).
 */
function withTimeout(promise, ms, label) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} tidak merespons dalam ${ms / 1000} detik (kemungkinan koneksi ke Gemini bermasalah).`)),
      ms
    );
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

// Beberapa error dari Gemini API sifatnya SEMENTARA (server Google lagi
// sibuk/lambat), bukan masalah permanen -- biasanya berhasil kalau dicoba
// ulang. Kode-kode ini paling sering muncul di tier gratis karena prioritas
// request-nya lebih rendah dibanding yang berbayar.
const TRANSIENT_ERROR_PATTERNS = [
  'DEADLINE_EXCEEDED',
  '"code":504',
  '"code":503',
  '"code":429',
  'UNAVAILABLE',
  'RESOURCE_EXHAUSTED',
  'ECONNRESET',
  'ETIMEDOUT',
];

function isTransientError(err) {
  const msg = String(err?.message || err);
  return TRANSIENT_ERROR_PATTERNS.some((pattern) => msg.includes(pattern));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const MAX_RETRIES = 3;
const RETRY_DELAYS_MS = [1500, 3000, 5000]; // delay sebelum percobaan ke-2, ke-3, ke-4

/**
 * Panggil Gemini API dengan retry otomatis kalau errornya sifatnya
 * sementara (504/503/429/dll). Error yang BUKAN transient (misal API key
 * salah, atau prompt ditolak) langsung dilempar tanpa retry -- percuma
 * dicoba ulang kalau memang salahnya bukan di sisi koneksi/server.
 */
async function callGeminiWithRetry(requestFn) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await withTimeout(requestFn(), REQUEST_TIMEOUT_MS, 'Gemini API');
      if (attempt > 0) {
        log(`[AI] Berhasil di percobaan ke-${attempt + 1} (model: ${MODEL}).`);
      }
      return result;
    } catch (err) {
      lastErr = err;
      const isLastAttempt = attempt === MAX_RETRIES;
      const transient = isTransientError(err);
      log(
        `[AI] Percobaan ke-${attempt + 1}/${MAX_RETRIES + 1} gagal (model: ${MODEL}, transient: ${transient}): ${err.message}`
      );
      if (isLastAttempt || !transient) {
        throw err;
      }
      await sleep(RETRY_DELAYS_MS[attempt] || 3000);
    }
  }
  throw lastErr;
}

/**
 * Tanya-jawab sekali, tanpa nyimpen konteks percakapan. Dipakai buat /ask.
 */
async function askOnce(prompt) {
  const response = await callGeminiWithRetry(() =>
    ai.models.generateContent({
      model: MODEL,
      contents: prompt,
      config: { systemInstruction: SYSTEM_PROMPT },
    })
  );
  return response.text || '(Gemini tidak memberikan balasan.)';
}

/**
 * Chat multi-turn per user (inget percakapan sebelumnya). Dipakai buat
 * fitur mention-chat.
 */
async function chatReply(userId, message) {
  const session = getSession(userId);
  session.history.push({ role: 'user', parts: [{ text: message }] });

  const response = await callGeminiWithRetry(() =>
    ai.models.generateContent({
      model: MODEL,
      contents: session.history,
      config: { systemInstruction: SYSTEM_PROMPT },
    })
  );

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

module.exports = { init, askOnce, chatReply, resetSession, splitIntoChunks };
