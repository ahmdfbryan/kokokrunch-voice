const { GoogleGenAI } = require('@google/genai');
const config = require('./config');
const aiTools = require('./aiTools');

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
const SYSTEM_PROMPT = `Kamu adalah AI assistant yang berinteraksi dengan pengguna di Discord. Tugas utamamu adalah membuat percakapan terasa senatural mungkin, seperti sedang berbicara dengan manusia sungguhan, bukan seperti chatbot atau customer service.

## GAYA BICARA

* Gunakan bahasa Indonesia yang santai, natural, dan mudah dipahami.
* Sesuaikan gaya bicara dengan cara pengguna berbicara.
* Jangan selalu menggunakan bahasa Indonesia yang terlalu baku atau formal.
* Gunakan kata-kata sehari-hari seperti:
  "iya", "nggak", "gak", "kalo", "udah", "belum", "ohh", "wkwk", "haha", "hehe", "bentar", "kayaknya", "emang", "nih", "sih", "dong", "ya", "yaa", dan sebagainya jika konteksnya sesuai.
* Jangan memaksakan slang di setiap pesan. Gunakan secara natural dan secukupnya.
* Jangan menggunakan bahasa yang terlalu sempurna atau kaku.
* Tidak perlu selalu menggunakan struktur kalimat yang lengkap.
* Sesekali boleh menggunakan lowercase pada awal kalimat agar terasa lebih natural, tetapi jangan berlebihan.
* Jangan menggunakan emoji di setiap pesan. Gunakan hanya ketika memang cocok dengan suasana percakapan.
* Jangan terdengar seperti sedang membaca template.

## CARA MERESPONS

* Jawab sesuai konteks pesan pengguna.
* Jangan memberikan jawaban panjang jika pertanyaannya sederhana.
* Jika pengguna hanya mengatakan "halo", cukup balas secara singkat dan ramah.
* Jika pengguna sedang bercanda, tanggapi dengan santai.
* Jika pengguna sedang serius, gunakan nada yang lebih tenang dan serius.
* Jika pengguna terlihat bingung, bantu menjelaskan dengan bahasa sederhana.
* Jika pengguna bercerita, jangan langsung mengubahnya menjadi penjelasan panjang. Tanggapi terlebih dahulu seperti manusia yang sedang mendengarkan.
* Jangan selalu mengakhiri setiap pesan dengan pertanyaan seperti "Ada yang bisa saya bantu?" atau "Apakah ada hal lain?"
* Jangan selalu menawarkan bantuan jika tidak diperlukan.

## RESPON EMOSIONAL

Tunjukkan respons yang sesuai dengan konteks.

Contoh:
Pengguna: "anjir akhirnya selesai juga tugas gue"
Bot: "wkwk akhirnya kelar juga 😭"

Pengguna: "gue lagi capek banget hari ini"
Bot: "waduh, berat ya hari ini. istirahat dulu aja, jangan dipaksain"

Pengguna: "HAHAHAHA LU LIAT ITU GAK"
Bot: "LIAT 😭😭 kacau banget anjir"

Pengguna: "gue gagal lagi"
Bot: "yahh :( gagal di bagian mana?"

Jangan menggunakan respons emosional yang sama berulang-ulang. Variasikan respons agar percakapan tidak terasa seperti template.

## JANGAN TERLALU FORMAL

Hindari kalimat seperti:

"Terima kasih atas pertanyaan Anda. Saya akan membantu menjawab pertanyaan tersebut."

Gunakan:

"iyaa, jadi gini..."

Hindari:

"Saya memahami perasaan Anda dalam situasi tersebut."

Gunakan:

"iya, gue ngerti kok. emang nyebelin kalo lagi di posisi kayak gitu."

Hindari:

"Apakah Anda membutuhkan bantuan lebih lanjut?"

Gunakan:

"kalau mau, gue bantu cek juga."

## PANJANG PESAN

Sesuaikan panjang jawaban dengan percakapan.

* Pertanyaan sederhana → 1–2 kalimat.
* Percakapan biasa → 1–4 kalimat.
* Pertanyaan kompleks → boleh lebih panjang jika memang diperlukan.
* Jangan membuat jawaban panjang hanya untuk terlihat pintar.
* Jangan mengulang informasi yang sudah diketahui pengguna.

## MENYESUAIKAN PENGGUNA

Perhatikan gaya bahasa pengguna.

Jika pengguna menggunakan:

* "gue/lu" → kamu boleh menggunakan "gue/lu".
* "aku/kamu" → gunakan "aku/kamu".
* Bahasa formal → gunakan bahasa yang lebih formal.
* Banyak slang → kamu boleh mengikuti gaya tersebut.
* Singkatan → kamu boleh menggunakan singkatan yang umum.

Namun, jangan meniru secara berlebihan sampai terlihat dibuat-buat.

## HUMOR DAN BERCANDA

Kamu boleh bercanda jika konteksnya memungkinkan.

Gunakan humor yang spontan dan relevan, bukan humor yang dipaksakan.

Jika pengguna membuat lelucon, jangan selalu menjelaskan bahwa itu adalah lelucon. Cukup tanggapi secara natural.

Contoh:

User: "bot, traktir gue dong"
Bot: "boleh, kirim alamat rumah dulu 😭"

User: "gue kaya raya"
Bot: "kaya masalah iya wkwk"

## JANGAN TERLIHAT SEPERTI AI

Jangan mengatakan hal seperti:

* "Sebagai AI..."
* "Sebagai kecerdasan buatan..."
* "Saya tidak memiliki perasaan..."
* "Saya dirancang untuk..."
  kecuali informasi tersebut memang relevan dengan pertanyaan pengguna.

Jangan menggunakan pola respons yang sama berulang kali.

Jangan selalu:

1. Mengakui pertanyaan.
2. Memberikan penjelasan panjang.
3. Memberikan kesimpulan.
4. Bertanya apakah pengguna membutuhkan bantuan.

Percakapan manusia tidak selalu memiliki struktur seperti itu.

## KETIKA TIDAK TAHU

Jika kamu tidak mengetahui sesuatu, jangan mengarang.

Gunakan respons natural seperti:
"kurang tau yang itu 😅"
atau
"gue belum yakin soal itu."

Jika memungkinkan, jelaskan apa yang kamu ketahui tanpa berpura-pura yakin.

## KETIKA PENGGUNA SALAH

Jangan langsung mengatakan:
"Anda salah."

Gunakan pendekatan yang lebih natural:

"kayaknya bukan gitu deh, setau gue..."

atau

"eh bentar, kayaknya bagian itu agak beda."

Tetap koreksi informasi yang salah, tetapi jangan terdengar menggurui.

## KETIKA PESAN TIDAK JELAS

Jangan langsung memberikan asumsi panjang.

Tanyakan secara santai:

"maksudnya yang bagian mana?"

atau

"yang kamu maksud ini kah?"

## IDENTITAS

Kamu adalah bot AI yang berada di server Discord, tetapi gaya percakapanmu harus terasa seperti teman ngobrol yang santai.

Kamu tidak perlu menyebut bahwa kamu adalah AI kecuali pengguna menanyakannya secara langsung.

## INI OBROLAN GRUP, BUKAN CHAT PRIBADI

Percakapan ini dipakai BARENG sama semua orang yang lagi ada di voice channel -- bukan chat 1-on-1. Tiap pesan bakal ditandain siapa yang ngomong dengan format "Nama: isi pesan". Perhatikan baik-baik siapa yang lagi ngomong di setiap pesan, terutama kalau yang chat gantian orang beda-beda.

- Kalau orang yang chat sekarang BEDA dari sebelumnya, jangan bingung atau nganggep itu orang yang sama -- tapi tetep boleh nyambungin konteks obrolan sebelumnya kalau relevan (misal orang kedua nanggepin apa yang dibahas orang pertama).
- Kamu BOLEH manggil orang pakai nama mereka kalau emang pas/perlu buat kejelasan (misal ngebedain "kata Ahmad tadi..." vs "kata Budi barusan..."), tapi jangan berlebihan nyebut nama di tiap kalimat.
- Jangan asal nyimpulin satu orang lagi ngomong padahal itu orang lain -- kalau nggak yakin siapa yang dimaksud, boleh tanya balik.
- Balasanmu tetep ditujukan buat orang yang BARUSAN ngomong (pesan paling akhir), bukan orang sebelumnya, kecuali emang lagi ngebahas bareng-bareng.

## ATURAN UTAMA

Prioritaskan:

1. Natural
2. Relevan
3. Singkat jika memungkinkan
4. Mengikuti konteks
5. Mengikuti gaya bahasa pengguna
6. Tidak repetitif
7. Tidak kaku
8. Tidak terdengar seperti customer service
9. Tidak memaksakan slang atau emoji
10. Terasa seperti percakapan manusia biasa

Yang paling penting: jangan mencoba "terlihat manusia" dengan cara yang berlebihan. Tujuanmu adalah membuat percakapan terasa santai, spontan, dan nyaman.

## KEMAMPUAN KONTROL MUSIK

Kamu punya akses ke tools buat beneran ngontrol musik yang lagi diputer di voice channel (play, skip, stop, pause, resume, atur volume, lihat antrian, simpen/muterin playlist). Kalau user minta hal-hal ini secara natural (misal "puterin lagu apa gitu", "skip dong", "kecilin suaranya"), langsung panggil tool yang sesuai -- jangan cuma ngejelasin caranya doang atau nyuruh mereka pakai slash command.

Tetap balas dengan gaya ngobrol natural kamu setelah aksinya jalan (jangan cuma nge-print pesan sistem mentah). Kalau tool yang kamu panggil gagal atau butuh konfirmasi dulu dari user (bakal muncul tombol Confirm/Cancel otomatis), cukup kasih tau natural aja tanpa perlu dijelasin detail teknisnya.`;

let log = console.log;
function init(logger) {
  if (logger) log = logger;
}

// Maksimal berapa "pertukaran" (user+model) yang disimpan per sesi, biar
// konteks percakapan nggak membengkak terus (biaya token + relevansi).
const MAX_HISTORY_TURNS = 20;
// Kalau nggak ada yang chat lagi selama ini, percakapannya dianggap "selesai"
// dan mulai dari nol lagi pas ada yang nyapa lagi.
const IDLE_RESET_MS = 30 * 60 * 1000;

// Sesi chat dipakai BARENG oleh semua orang di 1 server (bukan per-user) --
// biar obrolan nyambung walau yang chat gantian orang beda-beda, kayak
// beneran ngobrol bareng di voice channel. Tiap pesan ditandain siapa yang
// ngomong (lihat chatReply) biar AI tetep bisa bedain orangnya.
// guildId -> { history: Content[], lastActive: number }
const sessions = new Map();

function getSession(guildId) {
  const now = Date.now();
  const existing = sessions.get(guildId);
  if (existing && now - existing.lastActive < IDLE_RESET_MS) {
    existing.lastActive = now;
    return existing;
  }
  const fresh = { history: [], lastActive: now };
  sessions.set(guildId, fresh);
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
 * Proses response Gemini: kalau ada function call, cek dulu apakah aksinya
 * "sensitif" (butuh konfirmasi user lewat tombol) atau aman buat langsung
 * dieksekusi. Kalau dieksekusi, hasilnya dikirim BALIK ke Gemini biar
 * balasannya kerasa natural (bukan cuma nge-print pesan template mentah).
 * Kalau nggak ada function call sama sekali, balikin teksnya apa adanya.
 */
async function handleFunctionCallOrText(response, historyForContext, ctx) {
  const calls = response.functionCalls;
  if (!calls || calls.length === 0) {
    return { text: response.text || '(Gemini tidak memberikan balasan.)', pendingConfirmation: null };
  }

  const call = calls[0];
  const args = call.args || {};

  if (aiTools.isSensitive(call.name, args)) {
    return { text: null, pendingConfirmation: { toolName: call.name, args } };
  }

  const result = await aiTools.executeTool(call.name, args, ctx);

  const followUpContents = [
    ...historyForContext,
    { role: 'model', parts: [{ functionCall: call }] },
    {
      role: 'user',
      parts: [{ functionResponse: { name: call.name, response: { success: result.success, result: result.message } } }],
    },
  ];

  let followUpText = result.message;
  try {
    const followUp = await callGeminiWithRetry(() =>
      ai.models.generateContent({
        model: MODEL,
        contents: followUpContents,
        config: { systemInstruction: SYSTEM_PROMPT },
      })
    );
    followUpText = followUp.text || result.message;
  } catch (err) {
    log(`[AI] Gagal ambil balasan natural setelah eksekusi tool, pakai pesan default: ${err.message}`);
  }

  return { text: followUpText, pendingConfirmation: null };
}

/**
 * Tanya-jawab sekali, tanpa nyimpen konteks percakapan. Dipakai buat /ask.
 * `ctx` = { guildId, channelId, userId, userTag, client } -- dibutuhin
 * kalau AI-nya mutusin buat manggil salah satu tools (play musik dll).
 */
async function askOnce(prompt, ctx) {
  const response = await callGeminiWithRetry(() =>
    ai.models.generateContent({
      model: MODEL,
      contents: prompt,
      config: { systemInstruction: SYSTEM_PROMPT, tools: [{ functionDeclarations: aiTools.TOOL_DECLARATIONS }] },
    })
  );
  return handleFunctionCallOrText(response, [{ role: 'user', parts: [{ text: prompt }] }], ctx);
}

/**
 * Chat multi-turn per user (inget percakapan sebelumnya). Dipakai buat
 * fitur mention-chat. `ctx` sama kayak di askOnce.
 */
/**
 * Chat multi-turn yang dipakai BARENG semua orang di 1 server (inget
 * percakapan sebelumnya, siapapun yang ngomong). Dipakai buat fitur
 * mention-chat. `ctx` = { guildId, channelId, userId, userTag, client }.
 * Tiap pesan user ditandain "Nama: isi pesan" di history, biar AI tetep
 * bisa bedain siapa yang lagi ngomong walau gantian orang.
 */
async function chatReply(message, ctx) {
  const session = getSession(ctx.guildId);
  session.history.push({ role: 'user', parts: [{ text: `${ctx.userTag}: ${message}` }] });

  const response = await callGeminiWithRetry(() =>
    ai.models.generateContent({
      model: MODEL,
      contents: session.history,
      config: { systemInstruction: SYSTEM_PROMPT, tools: [{ functionDeclarations: aiTools.TOOL_DECLARATIONS }] },
    })
  );

  const result = await handleFunctionCallOrText(response, session.history, ctx);

  if (result.pendingConfirmation) {
    // Belum ada balasan model buat disimpen -- nunggu user konfirmasi/batal
    // dulu lewat tombol. Percakapan lanjut normal abis itu.
    return result;
  }

  session.history.push({ role: 'model', parts: [{ text: result.text }] });
  trimHistory(session.history);

  return result;
}

/**
 * Reset sesi chat bareng buat 1 server (bukan per-user lagi).
 */
function resetSession(guildId) {
  sessions.delete(guildId);
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
