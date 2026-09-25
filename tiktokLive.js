const { EmbedBuilder } = require('discord.js');
const botBranding = require('./botBranding');

// Integrasi TikTok LIVE: nangkep comment "!request <judul lagu>" dari live
// TikTok kamu, terus otomatis nge-play lagu itu di voice channel Discord
// (persis kayak /play). CUMA fitur request ini yang diaktifin -- nggak
// nyentuh gift/follow/like/comment lain sama sekali.
//
// Dipakai library "tiktok-live-connector" (unofficial/reverse-engineered --
// TikTok nggak punya API resmi publik buat baca live chat). Konsekuensinya:
// - Fitur ini CUMA bisa nyambung kalau akun TikTok itu LAGI LIVE beneran.
//   Kalau nggak lagi live, koneksi bakal gagal terus dan otomatis dicoba
//   lagi tiap RETRY_DELAY_MS -- ini NORMAL, bukan bug.
// - Library ini bisa aja berhenti kerja sewaktu-waktu kalau TikTok ubah
//   protokol internal mereka, di luar kendali kita.

const REQUEST_REGEX = /^!request\s+(.+)$/i;
const RETRY_DELAY_MS = 30_000;

let log = console.log;
function setLogger(fn) {
  log = fn || console.log;
}

let tiktokUsername = null;
let onRequestCallback = null;
let connection = null;
let connected = false;
let stopped = true;
let retryTimer = null;
let lastError = null;
let connectAttemptInFlight = false;

function getStatus() {
  return {
    enabled: !!tiktokUsername,
    connected,
    username: tiktokUsername,
    lastError,
  };
}

function scheduleRetry() {
  if (stopped || retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    attemptConnect();
  }, RETRY_DELAY_MS);
}

function handleChatComment(data) {
  try {
    const comment = (data?.comment || '').trim();
    const match = comment.match(REQUEST_REGEX);
    if (!match) return;
    const query = match[1].trim();
    if (!query) return;
    const requester = data?.user?.uniqueId || data?.user?.nickname || 'penonton TikTok';
    log(`[TIKTOK] Request dari @${requester}: "${query}"`);
    if (onRequestCallback) onRequestCallback(query, requester);
  } catch (err) {
    log(`[TIKTOK] Gagal proses comment: ${err?.message || err}`);
  }
}

async function attemptConnect() {
  if (stopped || !tiktokUsername || connectAttemptInFlight || connected) return;
  connectAttemptInFlight = true;

  try {
    // Library-nya ESM-only ("type":"module"), sedangkan project kita
    // CommonJS -- dynamic import() ini interop paling aman/portable
    // (nggak bergantung ke fitur require(esm) yang cuma ada di Node baru).
    const { TikTokLiveConnection, WebcastEvent } = await import('tiktok-live-connector');

    connection = new TikTokLiveConnection(tiktokUsername);
    connection.on(WebcastEvent.CHAT, handleChatComment);
    connection.on('disconnected', () => {
      connected = false;
      log('[TIKTOK] Koneksi ke live TikTok terputus, bakal dicoba reconnect otomatis.');
    });
    connection.on('streamEnd', () => {
      connected = false;
      log('[TIKTOK] Live TikTok kelihatannya udah berakhir.');
    });
    connection.on('error', (err) => {
      log(`[TIKTOK] Error koneksi: ${err?.message || err}`);
    });

    const state = await connection.connect();
    connected = true;
    lastError = null;
    log(`[TIKTOK] Berhasil connect ke live @${tiktokUsername} (roomId: ${state?.roomId ?? '?'}). Fitur request aktif.`);
  } catch (err) {
    connected = false;
    lastError = err?.message || String(err);
    log(`[TIKTOK] Belum bisa connect ke live @${tiktokUsername} (${lastError}). Coba lagi ${RETRY_DELAY_MS / 1000} detik.`);
  } finally {
    connectAttemptInFlight = false;
    if (!connected) scheduleRetry();
  }
}

/**
 * Dipanggil sekali dari index.js pas bot ready. `onRequest(query, requester)`
 * dipanggil tiap ada comment "!request <judul>" valid yang ketangkep.
 */
function init(username, onRequest) {
  tiktokUsername = (username || '').trim().replace(/^@/, '') || null;
  onRequestCallback = onRequest;
  stopped = false;

  if (!tiktokUsername) {
    log('[TIKTOK] TIKTOK_USERNAME belum diisi di .env, fitur request musik TikTok LIVE nonaktif.');
    return;
  }

  log(`[TIKTOK] Mulai mencoba connect ke live TikTok @${tiktokUsername}...`);
  attemptConnect();

  // Health-check berkala -- selain reconnect yang dipicu event, ini jaga-jaga
  // kalau event disconnect/error dari library nggak kepanggil sama sekali
  // (nama event versi lain, race condition, dll) biar tetep nyoba reconnect.
  setInterval(() => {
    if (!stopped && tiktokUsername && !connected) attemptConnect();
  }, RETRY_DELAY_MS);
}

function shutdown() {
  stopped = true;
  if (retryTimer) clearTimeout(retryTimer);
  if (connection) {
    try {
      connection.disconnect();
    } catch {
      // aman diabaikan
    }
  }
  connected = false;
}

/**
 * Embed info + status, ditampilkan ephemeral pas tombol "TikTok" di panel
 * utama diklik.
 */
function buildTiktokInfoEmbed() {
  const status = getStatus();
  const embed = new EmbedBuilder().setColor(0x000000).setAuthor({ name: '📱 Request Musik via TikTok LIVE' });

  if (!status.enabled) {
    embed.setDescription(
      [
        'Fitur ini belum diaktifin di server ini.',
        '',
        '_(Butuh `TIKTOK_USERNAME` diisi di konfigurasi bot dulu.)_',
      ].join('\n')
    );
    return botBranding.applyBrandFooter(embed);
  }

  const statusLine = status.connected
    ? `🟢 Lagi connect ke live **@${status.username}**`
    : `🔴 Belum connect ke live **@${status.username}** (nunggu kamu mulai live, dicoba otomatis tiap 30 detik)`;

  embed.setDescription(
    [
      statusLine,
      '',
      'Pas live, siapapun bisa request lagu lewat kolom komentar:',
      '```!request <judul lagu>```',
      'Contoh: `!request Virgoun - Bukti`',
      '',
      'Lagunya bakal otomatis masuk antrian musik bot ini, sama persis kayak `/play`.',
    ].join('\n')
  );
  return botBranding.applyBrandFooter(embed);
}

module.exports = { init, getStatus, setLogger, shutdown, buildTiktokInfoEmbed };
