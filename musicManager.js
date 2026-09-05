const { createAudioResource, StreamType } = require('@discordjs/voice');
const { createSilentAudioStream } = require('./silentstream');
const ytdlp = require('./ytdlp');
const trackResolver = require('./trackResolver');

// State antrian per guild. Bot ini didesain buat 1 guild/channel tetap,
// tapi tetap di-map per guildId biar rapi & gampang diperluas nanti.
const queues = new Map();

let player = null;
let log = console.log;
let onTrackStart = null; // (guildId, track) => void -- buat update status/notifikasi
let onQueueEmpty = null; // (guildId) => void -- dipanggil pas balik ke silent audio

/**
 * Wajib dipanggil sekali dari index.js setelah AudioPlayer dibuat, supaya
 * modul ini bisa play/stop lewat player yang sama dipakai buat silent audio.
 * `callbacks` opsional: { onTrackStart, onQueueEmpty } buat notifikasi
 * "Now Playing" ke luar modul ini (status bot, embed di channel, dll).
 */
function init(audioPlayer, logger, callbacks = {}) {
  player = audioPlayer;
  if (logger) log = logger;
  onTrackStart = callbacks.onTrackStart || null;
  onQueueEmpty = callbacks.onQueueEmpty || null;
}

function getQueue(guildId) {
  if (!queues.has(guildId)) {
    queues.set(guildId, {
      tracks: [],
      current: null,
      currentProcess: null,
      textChannelId: null,
      autoplayEnabled: false,
      recentAutoplayUrls: [],
      history: [], // track yang udah/lagi diputar di sesi ini -- basis buat fitur "Simpan Sesi jadi Playlist"
    });
  }
  return queues.get(guildId);
}

// Batas panjang histori sesi biar nggak numpuk mulu kalau bot nyala berhari-hari
const SESSION_HISTORY_LIMIT = 200;

/**
 * Gabungin histori (track yang udah/lagi diputar) + sisa antrian jadi 1
 * daftar urut tanpa duplikat (dedupe by URL, kemunculan pertama menang).
 * Ini yang dipakai fitur "Simpan Sesi jadi Playlist" (/playlist save) --
 * merepresentasikan seluruh sesi dengerin musik saat ini dari awal sampai
 * yang masih ngantri.
 */
function getSessionTracks(guildId) {
  const queue = getQueue(guildId);
  const seen = new Set();
  const combined = [];

  for (const t of queue.history) {
    if (!seen.has(t.url)) {
      seen.add(t.url);
      combined.push(t);
    }
  }
  for (const t of queue.tracks) {
    if (!seen.has(t.url)) {
      seen.add(t.url);
      combined.push(t);
    }
  }
  return combined;
}

/**
 * Nyalain/matiin autoplay buat 1 guild. Kalau nyala, begitu antrian abis
 * (bukan karena /stop), bot otomatis nyari & muterin lagu yang mirip dari
 * lagu terakhir yang diputar, jadi musik nggak berhenti-berhenti.
 */
function setAutoplay(guildId, enabled) {
  const queue = getQueue(guildId);
  queue.autoplayEnabled = enabled;
}

function isAutoplayEnabled(guildId) {
  return getQueue(guildId).autoplayEnabled === true;
}

/**
 * Simpan channel teks tempat terakhir kali /play dipanggil, buat kirim
 * notifikasi "Now Playing" otomatis ke situ.
 */
function setTextChannel(guildId, channelId) {
  const queue = getQueue(guildId);
  queue.textChannelId = channelId;
}

/**
 * Bunuh proses yt-dlp yang lagi jalan (kalau ada), supaya nggak jadi
 * proses nyangkut/zombie tiap kali skip/stop/ganti lagu.
 */
function killCurrentProcess(queue) {
  if (queue.currentProcess && !queue.currentProcess.killed) {
    queue.currentProcess.kill('SIGKILL');
  }
  queue.currentProcess = null;
}

/**
 * Tambah track ke antrian. Kalau lagi nggak ada yang muter (cuma silent
 * audio), langsung mulai muter track ini.
 */
function enqueue(guildId, track) {
  const queue = getQueue(guildId);

  // Hitung ETA SEBELUM di-push (durasi track yang lagi main + sisa antrian lama)
  let etaSeconds = queue.current?.durationSeconds || 0;
  for (const existing of queue.tracks) {
    etaSeconds += existing.durationSeconds || 0;
  }

  queue.tracks.push(track);
  log(
    `[MUSIC] Enqueue "${track.title}" buat guild ${guildId}. Antrian sekarang: ${queue.tracks.length} track, sedang main: ${queue.current ? `"${queue.current.title}"` : '(silent)'}`
  );

  const position = queue.tracks.length;
  if (!queue.current) {
    // silent: true -- jangan kirim notifikasi channel di sini, karena reply
    // dari command /play sendiri sudah bilang "Started playing". Status bot
    // (Activity) tetap di-update seperti biasa lewat callback onTrackStart.
    playNext(guildId, { silent: true });
    return { position: 0, startedImmediately: true, etaSeconds: 0 }; // 0 = langsung main
  }
  return { position, startedImmediately: false, etaSeconds };
}

/**
 * Tambah BANYAK track sekaligus (dipakai buat playlist). Balikin daftar
 * {track, etaSeconds} buat tiap track -- etaSeconds itu estimasi berapa
 * detik lagi sampai track itu mulai diputar, dihitung dari durasi track
 * yang lagi main (perkiraan durasi penuh, karena kita nggak nge-track
 * posisi playback saat ini) + semua track yang udah lebih dulu di antrian.
 */
function enqueueMany(guildId, tracks) {
  const queue = getQueue(guildId);

  // Hitung ETA tiap track SEBELUM benar-benar di-push, berdasarkan state
  // antrian saat ini (durasi track yang lagi main + sisa antrian lama).
  let cumulative = queue.current?.durationSeconds || 0;
  for (const existing of queue.tracks) {
    cumulative += existing.durationSeconds || 0;
  }

  const etaList = [];
  for (const track of tracks) {
    etaList.push({ track, etaSeconds: cumulative });
    cumulative += track.durationSeconds || 0;
  }

  queue.tracks.push(...tracks);
  log(`[MUSIC] Enqueue ${tracks.length} track sekaligus (playlist) buat guild ${guildId}. Total antrian sekarang: ${queue.tracks.length}.`);

  let startedImmediately = false;
  if (!queue.current) {
    playNext(guildId, { silent: true }); // sama kayak enqueue() biasa -- reply command sendiri udah kasih tau
    startedImmediately = true;
  }

  return { etaList, startedImmediately };
}

/**
 * Mainkan track berikutnya di antrian. Kalau antrian kosong, balik ke
 * silent audio (supaya voice connection tetap "hidup" 24/7 tanpa musik).
 * `options.silent`: true -> tetap update status bot, tapi skip notifikasi
 * channel (dipakai pas /play langsung main, biar nggak dobel sama reply-nya).
 */
function playNext(guildId, options = {}) {
  const queue = getQueue(guildId);
  const prevCurrent = queue.current ? queue.current.title : '(silent)';
  killCurrentProcess(queue);

  const next = queue.tracks.shift();
  log(
    `[MUSIC] playNext() dipanggil buat guild ${guildId}. Sebelumnya: "${prevCurrent}". Sisa di antrian sebelum shift: ${queue.tracks.length + (next ? 1 : 0)}. Diambil: ${next ? `"${next.title}"` : '(kosong, balik ke silent)'}`
  );

  if (!next) {
    const finishedTrack = queue.current; // track yang barusan abis, dipakai sebagai "biji" autoplay
    queue.current = null;

    // Kalau dipicu dari /stop, suppressAutoplay & suppressEmptyNotify udah
    // di-set true (biar nggak lanjut autoplay & nggak dobel notifikasi).
    const skipAutoplay = queue.suppressAutoplay === true;
    queue.suppressAutoplay = false;

    if (queue.autoplayEnabled && !skipAutoplay && finishedTrack) {
      tryAutoplay(guildId, finishedTrack);
      return;
    }

    fallbackToSilence(guildId);
    return;
  }

  queue.current = next;

  // Catat ke histori sesi (buat fitur "Simpan Sesi jadi Playlist"). Dicatat
  // begitu track mulai diputar -- termasuk track hasil autoplay, karena itu
  // tetap bagian dari "apa yang didengerin" di sesi ini.
  queue.history.push(next);
  if (queue.history.length > SESSION_HISTORY_LIMIT) {
    queue.history.shift();
  }

  try {
    const stream = ytdlp.streamAudio(next.url);
    queue.currentProcess = stream.ytDlpProcess;

    stream.on('error', (err) => {
      log(`[MUSIC] Stream error buat "${next.title}": ${err.message}`);
    });

    const resource = createAudioResource(stream, { inputType: StreamType.Arbitrary });
    player.play(resource);
    log(`[MUSIC] Now playing: ${next.title} (${next.durationText || '?'}) diminta oleh ${next.requestedBy}`);
    if (onTrackStart) onTrackStart(guildId, next, { silent: options.silent === true });
  } catch (err) {
    log(`[MUSIC] Gagal play "${next.title}": ${err.message}, skip ke berikutnya...`);
    playNext(guildId);
  }
}

function playSilence() {
  if (!player) return;
  const resource = createAudioResource(createSilentAudioStream(), { inputType: StreamType.Raw });
  player.play(resource);
}

/**
 * Balik ke silent audio + kirim notifikasi antrian-abis (kecuali lagi
 * di-suppress, misal dipicu dari /stop).
 */
function fallbackToSilence(guildId) {
  const queue = getQueue(guildId);
  playSilence();
  const silent = queue.suppressEmptyNotify === true;
  queue.suppressEmptyNotify = false;
  if (onQueueEmpty) onQueueEmpty(guildId, { silent });
}

/**
 * Coba cari & muterin 1 lagu yang mirip dari `seedTrack`. Kalau gagal
 * (nggak ketemu, Mix error, dll), fallback ke silent audio kayak biasa.
 */
async function tryAutoplay(guildId, seedTrack) {
  const queue = getQueue(guildId);
  try {
    const candidate = await trackResolver.getAutoplayTrack(seedTrack.url, queue.recentAutoplayUrls);
    if (!candidate) {
      log(`[MUSIC] Autoplay: nggak nemu lagu mirip buat "${seedTrack.title}", balik ke silent.`);
      fallbackToSilence(guildId);
      return;
    }

    candidate.requestedBy = 'Autoplay';
    candidate.isAutoplay = true;

    // Simpen histori kecil biar autoplay nggak muter-muter kepilih lagu yang sama
    queue.recentAutoplayUrls = [...queue.recentAutoplayUrls, candidate.url].slice(-20);

    queue.tracks.push(candidate);
    log(`[MUSIC] Autoplay: nemu "${candidate.title}" (mirip dari "${seedTrack.title}")`);
    playNext(guildId);
  } catch (err) {
    log(`[MUSIC] Autoplay gagal: ${err.message}, balik ke silent.`);
    fallbackToSilence(guildId);
  }
}

/**
 * Skip track yang lagi main. Return false kalau memang nggak ada yang main.
 * player.stop() akan trigger event 'Idle' di index.js, yang manggil
 * playNext() lagi -> otomatis lanjut ke track berikutnya atau silence.
 */
function skip(guildId) {
  const queue = getQueue(guildId);
  if (!queue.current) return false;
  player.stop();
  return true;
}

/**
 * Stop total: kosongin antrian + berhenti main. Sama seperti skip, transisi
 * ke silent audio ditangani otomatis lewat event 'Idle'.
 */
function stop(guildId) {
  const queue = getQueue(guildId);
  const hadSomething = queue.tracks.length > 0 || queue.current !== null;
  queue.tracks = [];
  if (queue.current) {
    queue.suppressEmptyNotify = true; // reply /stop sendiri udah kasih tau, jangan dobel
    queue.suppressAutoplay = true; // /stop artinya user emang mau berhenti, jangan lanjut autoplay
    player.stop();
  }
  return hadSomething;
}

/**
 * Dipanggil pas voice connection baru aja di-reconnect (jaringan putus,
 * dsb). Tujuannya: jangan biarin state antrian nyasar dari audio yang
 * beneran diputar. Kalau lagi ada track yang "harusnya" main, restart
 * track itu dari awal (nggak bisa resume dari posisi terakhir tanpa
 * kompleksitas tambahan). Kalau nggak ada, ya balik ke silent audio biasa.
 */
function resyncAfterReconnect(guildId) {
  const queue = getQueue(guildId);
  killCurrentProcess(queue);

  if (queue.current) {
    log(`[MUSIC] Reconnect terdeteksi, restart ulang track yang lagi main: "${queue.current.title}"`);
    queue.tracks.unshift(queue.current);
    queue.current = null;
    playNext(guildId);
  } else {
    playSilence();
  }
}

module.exports = {
  init,
  getQueue,
  setTextChannel,
  setAutoplay,
  isAutoplayEnabled,
  enqueue,
  enqueueMany,
  getSessionTracks,
  playNext,
  playSilence,
  resyncAfterReconnect,
  skip,
  stop,
};
