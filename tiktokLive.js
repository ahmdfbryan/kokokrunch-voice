const { EmbedBuilder } = require('discord.js');
const botBranding = require('./botBranding');
const tiktokLiveStore = require('./tiktokLiveStore');

// Integrasi TikTok LIVE: nangkep comment "!request <judul lagu>" dari live
// TikTok, terus otomatis nge-play lagu itu di voice channel Discord (persis
// kayak /play). CUMA fitur request ini yang diaktifin -- nggak nyentuh
// gift/follow/like/comment lain sama sekali.
//
// Username yang dipantau BISA DIGANTI SIAPA AJA lewat tombol "TikTok" di
// panel utama (bukan cuma lewat .env) -- jadi kalau pemilik bot lagi nggak
// live, member lain yang lagi live TikTok bisa pasang username mereka
// sendiri biar fitur request-nya kepake juga. Cuma 1 live yang bisa
// dipantau dalam satu waktu (ganti username otomatis mutusin yang lama).
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
// Username TikTok: huruf/angka/titik/underscore, 2-24 karakter (aturan
// resmi TikTok panjangnya maks 24).
const USERNAME_REGEX = /^[a-zA-Z0-9_.]{2,24}$/;

let log = console.log;
function setLogger(fn) {
  log = fn || console.log;
}

let tiktokUsername = null;
let setByTag = null;
let onRequestCallback = null;
let connection = null;
let connected = false;
let stopped = true;
let retryTimer = null;
let lastError = null;
let connectAttemptInFlight = false;
let healthCheckStarted = false;

function getStatus() {
  return {
    enabled: !!tiktokUsername,
    connected,
    username: tiktokUsername,
    setByTag,
    lastError,
  };
}

function normalizeUsername(raw) {
  return (raw || '').trim().replace(/^@/, '');
}

function scheduleRetry() {
  if (stopped || retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    attemptConnect();
  }, RETRY_DELAY_MS);
}

function disconnectCurrent() {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  if (connection) {
    try {
      connection.removeAllListeners?.();
      connection.disconnect();
    } catch {
      // aman diabaikan
    }
  }
  connection = null;
  connected = false;
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
  const usernameAtStart = tiktokUsername; // jaga-jaga kalau username diganti pas lagi di tengah proses connect

  try {
    // Library-nya ESM-only ("type":"module"), sedangkan project kita
    // CommonJS -- dynamic import() ini interop paling aman/portable
    // (nggak bergantung ke fitur require(esm) yang cuma ada di Node baru).
    const { TikTokLiveConnection, WebcastEvent } = await import('tiktok-live-connector');

    if (usernameAtStart !== tiktokUsername || stopped) return; // keburu diganti/dimatiin

    connection = new TikTokLiveConnection(usernameAtStart);
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
    if (usernameAtStart !== tiktokUsername || stopped) {
      // Username diganti/dimatiin PAS lagi proses connect -- buang hasilnya.
      try {
        connection.disconnect();
      } catch {
        // aman diabaikan
      }
      return;
    }
    connected = true;
    lastError = null;
    log(`[TIKTOK] Berhasil connect ke live @${usernameAtStart} (roomId: ${state?.roomId ?? '?'}). Fitur request aktif.`);
  } catch (err) {
    connected = false;
    lastError = err?.message || String(err);
    log(`[TIKTOK] Belum bisa connect ke live @${usernameAtStart} (${lastError}). Coba lagi ${RETRY_DELAY_MS / 1000} detik.`);
  } finally {
    connectAttemptInFlight = false;
    if (!connected && !stopped && usernameAtStart === tiktokUsername) scheduleRetry();
  }
}

function startHealthCheck() {
  if (healthCheckStarted) return;
  healthCheckStarted = true;
  // Health-check berkala -- selain reconnect yang dipicu event, ini jaga-jaga
  // kalau event disconnect/error dari library nggak kepanggil sama sekali
  // (nama event versi lain, race condition, dll) biar tetep nyoba reconnect.
  setInterval(() => {
    if (!stopped && tiktokUsername && !connected) attemptConnect();
  }, RETRY_DELAY_MS);
}

/**
 * Dipanggil sekali dari index.js pas bot ready. Username yang dipantau
 * diambil dari penyimpanan (`tiktokLiveStore`, diisi lewat tombol TikTok di
 * panel -- bisa siapa aja) kalau ada, atau fallback ke `defaultUsername`
 * (dari `.env`, dipakai kalau belum ada yang set apa-apa lewat panel sama
 * sekali). `onRequest(query, requester)` dipanggil tiap ada comment
 * "!request <judul>" valid yang ketangkep.
 */
function init(defaultUsername, onRequest) {
  onRequestCallback = onRequest;
  stopped = false;

  tiktokLiveStore.load();
  const stored = tiktokLiveStore.get();
  tiktokUsername = stored.username || normalizeUsername(defaultUsername) || null;
  setByTag = stored.username ? stored.setByTag : null;

  if (!tiktokUsername) {
    log('[TIKTOK] Belum ada username TikTok yang di-set (lewat tombol TikTok di panel, atau TIKTOK_USERNAME di .env), fitur request musik nonaktif.');
    startHealthCheck();
    return;
  }

  log(`[TIKTOK] Mulai mencoba connect ke live TikTok @${tiktokUsername}...`);
  attemptConnect();
  startHealthCheck();
}

/**
 * Ganti username yang dipantau -- dipanggil dari tombol "Ganti Username" di
 * panel, BISA SIAPA AJA (bukan cuma owner bot). Mutusin koneksi live yang
 * lama (kalau ada) dan langsung nyoba connect ke yang baru.
 */
function setUsername(rawUsername, requesterTag) {
  const username = normalizeUsername(rawUsername);
  if (!USERNAME_REGEX.test(username)) {
    return { ok: false, reason: 'invalid' };
  }

  disconnectCurrent();
  tiktokUsername = username;
  setByTag = requesterTag || null;
  lastError = null;
  stopped = false;
  tiktokLiveStore.set(username, requesterTag || null);

  log(`[TIKTOK] Username diganti ke @${username} oleh ${requesterTag || '(tidak diketahui)'}.`);
  attemptConnect();
  startHealthCheck();
  return { ok: true, username };
}

/**
 * Matiin fitur ini total (dipanggil dari tombol "Matikan" di panel) --
 * mutusin koneksi live yang aktif dan bersihin penyimpanan, biar pas bot
 * restart juga tetap mati sampai ada yang nge-set username lagi.
 */
function clearUsername() {
  disconnectCurrent();
  tiktokUsername = null;
  setByTag = null;
  lastError = null;
  tiktokLiveStore.clear();
  log('[TIKTOK] Fitur request musik TikTok LIVE dimatikan.');
}

function shutdown() {
  stopped = true;
  disconnectCurrent();
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
        'Belum ada live TikTok yang dipantau.',
        '',
        'Klik **Set Username** di bawah buat mulai -- kamu (atau siapapun) bisa pasang username TikTok kamu sendiri sewaktu-waktu, nggak harus pemilik bot.',
      ].join('\n')
    );
    return botBranding.applyBrandFooter(embed);
  }

  const statusLine = status.connected
    ? `🟢 Lagi connect ke live **@${status.username}**`
    : `🔴 Belum connect ke live **@${status.username}** (nunggu live mulai, dicoba otomatis tiap 30 detik)`;
  const setByLine = status.setByTag ? `\n_Di-set oleh **${status.setByTag}**_` : '';

  embed.setDescription(
    [
      statusLine + setByLine,
      '',
      'Pas live, siapapun bisa request lagu lewat kolom komentar:',
      '```!request <judul lagu>```',
      'Contoh: `!request Virgoun - Bukti`',
      '',
      'Lagunya bakal otomatis masuk antrian musik bot ini, sama persis kayak `/play`.',
      '',
      '_Ganti ke username lain kapan aja lewat tombol **Set Username** di bawah._',
    ].join('\n')
  );
  return botBranding.applyBrandFooter(embed);
}

module.exports = {
  init,
  getStatus,
  setLogger,
  shutdown,
  buildTiktokInfoEmbed,
  setUsername,
  clearUsername,
  USERNAME_REGEX,
};
