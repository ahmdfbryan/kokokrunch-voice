const { createAudioResource, StreamType, AudioPlayerStatus } = require('@discordjs/voice');
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
      currentResource: null,
      currentStartedAt: null, // timestamp (ms) pas track sekarang mulai diputar
      textChannelId: null,
      autoplayEnabled: false,
      recentAutoplayUrls: [],
      volume: 1, // 1 = 100%. Disimpen logaritmik lewat setVolumeLogarithmic.
      loopMode: 'off', // 'off' | 'track' | 'queue'
      nowPlayingMessage: null, // { channelId, messageId } -- buat refresh progress bar berkala
    });
  }
  return queues.get(guildId);
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
  const finishedTrack = queue.current;
  const wasSkipped = queue.skipRequested === true;
  queue.skipRequested = false;

  killCurrentProcess(queue);

  // Loop-track: kalau abis NATURAL (bukan di-skip) dan mode-nya 'track',
  // muterin ulang track yang sama, bukan lanjut ke antrian.
  if (finishedTrack && !wasSkipped && queue.loopMode === 'track') {
    log(`[MUSIC] Loop track: mengulang "${finishedTrack.title}"`);
    playTrackNow(guildId, finishedTrack, options);
    return;
  }

  // Loop-queue: taro track yang abis (natural) ke belakang antrian biar
  // nanti gilirannya muter lagi setelah semua track lain kelar.
  if (finishedTrack && !wasSkipped && queue.loopMode === 'queue') {
    queue.tracks.push(finishedTrack);
  }

  const next = queue.tracks.shift();
  log(
    `[MUSIC] playNext() dipanggil buat guild ${guildId}. Sebelumnya: "${prevCurrent}". Sisa di antrian sebelum shift: ${queue.tracks.length + (next ? 1 : 0)}. Diambil: ${next ? `"${next.title}"` : '(kosong, balik ke silent)'}`
  );

  if (!next) {
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

  playTrackNow(guildId, next, options);
}

/**
 * Beneran mulai muterin 1 track (spawn stream yt-dlp, bikin AudioResource
 * dengan volume yang bisa diatur, play, catet waktu mulai, trigger callback).
 * Dipisah dari playNext() biar bisa dipakai ulang buat loop-track (replay
 * track yang sama tanpa perlu shift dari antrian).
 */
function playTrackNow(guildId, track, options = {}) {
  const queue = getQueue(guildId);
  queue.current = track;

  try {
    const stream = ytdlp.streamAudio(track.url);
    queue.currentProcess = stream.ytDlpProcess;

    stream.on('error', (err) => {
      log(`[MUSIC] Stream error buat "${track.title}": ${err.message}`);
    });

    const resource = createAudioResource(stream, { inputType: StreamType.Arbitrary, inlineVolume: true });
    resource.volume.setVolumeLogarithmic(queue.volume);
    queue.currentResource = resource;
    queue.currentStartedAt = Date.now();

    player.play(resource);
    log(`[MUSIC] Now playing: ${track.title} (${track.durationText || '?'}) diminta oleh ${track.requestedBy}`);
    if (onTrackStart) onTrackStart(guildId, track, { silent: options.silent === true });
  } catch (err) {
    log(`[MUSIC] Gagal play "${track.title}": ${err.message}, skip ke berikutnya...`);
    playNext(guildId);
  }
}

function playSilence(guildId) {
  if (!player) return;
  if (guildId) {
    const queue = getQueue(guildId);
    queue.currentStartedAt = null;
    queue.currentResource = null;
  }
  const resource = createAudioResource(createSilentAudioStream(), { inputType: StreamType.Raw });
  player.play(resource);
}

/**
 * Balik ke silent audio + kirim notifikasi antrian-abis (kecuali lagi
 * di-suppress, misal dipicu dari /stop).
 */
function fallbackToSilence(guildId) {
  const queue = getQueue(guildId);
  playSilence(guildId);
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
  queue.skipRequested = true; // biar loop-track nggak muter ulang track yang di-skip
  player.stop();
  return true;
}

/**
 * Set volume (0 - 2, dengan 1 = 100%). Langsung berlaku ke track yang lagi
 * main (kalau ada) via VolumeTransformer, dan disimpen buat track berikutnya.
 */
function setVolume(guildId, volume) {
  const queue = getQueue(guildId);
  queue.volume = volume;
  if (queue.currentResource?.volume) {
    queue.currentResource.volume.setVolumeLogarithmic(volume);
  }
}

function getVolume(guildId) {
  return getQueue(guildId).volume;
}

/**
 * Set mode loop: 'off' | 'track' | 'queue'. Logic pengulangannya sendiri
 * ada di playNext().
 */
function setLoopMode(guildId, mode) {
  const queue = getQueue(guildId);
  queue.loopMode = mode;
}

function getLoopMode(guildId) {
  return getQueue(guildId).loopMode;
}

/**
 * Pause/resume playback. Return false kalau nggak ada yang lagi main.
 */
function pause(guildId) {
  const queue = getQueue(guildId);
  if (!queue.current || !player) return false;
  return player.pause();
}

function resume(guildId) {
  const queue = getQueue(guildId);
  if (!queue.current || !player) return false;
  return player.unpause();
}

function isPaused() {
  return player?.state?.status === AudioPlayerStatus.Paused;
}

/**
 * Berapa detik track sekarang udah jalan (dipakai buat progress bar).
 * 0 kalau nggak ada yang main / belum sempet nyatet waktu mulai.
 */
function getElapsedSeconds(guildId) {
  const queue = getQueue(guildId);
  if (!queue.current || !queue.currentStartedAt) return 0;
  return Math.floor((Date.now() - queue.currentStartedAt) / 1000);
}

/**
 * Simpen referensi pesan "Now Playing" biar bisa di-refresh berkala
 * (progress bar jalan) tanpa perlu tau channel/message ID dari luar modul.
 */
function setNowPlayingMessage(guildId, channelId, messageId) {
  const queue = getQueue(guildId);
  queue.nowPlayingMessage = messageId ? { channelId, messageId } : null;
}

function getNowPlayingMessage(guildId) {
  return getQueue(guildId).nowPlayingMessage;
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
    playSilence(guildId);
  }
}

module.exports = {
  init,
  getQueue,
  setTextChannel,
  setAutoplay,
  isAutoplayEnabled,
  setVolume,
  getVolume,
  setLoopMode,
  getLoopMode,
  pause,
  resume,
  isPaused,
  getElapsedSeconds,
  setNowPlayingMessage,
  getNowPlayingMessage,
  enqueue,
  enqueueMany,
  playNext,
  playSilence,
  resyncAfterReconnect,
  skip,
  stop,
};
