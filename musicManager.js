const { createAudioResource, StreamType } = require('@discordjs/voice');
const { createSilentAudioStream } = require('./silentstream');
const ytdlp = require('./ytdlp');

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
    queues.set(guildId, { tracks: [], current: null, currentProcess: null, textChannelId: null });
  }
  return queues.get(guildId);
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
  queue.tracks.push(track);
  log(
    `[MUSIC] Enqueue "${track.title}" buat guild ${guildId}. Antrian sekarang: ${queue.tracks.length} track, sedang main: ${queue.current ? `"${queue.current.title}"` : '(silent)'}`
  );

  const position = queue.tracks.length;
  if (!queue.current) {
    playNext(guildId);
    return { position: 0, startedImmediately: true }; // 0 = langsung main
  }
  return { position, startedImmediately: false };
}

/**
 * Mainkan track berikutnya di antrian. Kalau antrian kosong, balik ke
 * silent audio (supaya voice connection tetap "hidup" 24/7 tanpa musik).
 */
function playNext(guildId) {
  const queue = getQueue(guildId);
  const prevCurrent = queue.current ? queue.current.title : '(silent)';
  killCurrentProcess(queue);

  const next = queue.tracks.shift();
  log(
    `[MUSIC] playNext() dipanggil buat guild ${guildId}. Sebelumnya: "${prevCurrent}". Sisa di antrian sebelum shift: ${queue.tracks.length + (next ? 1 : 0)}. Diambil: ${next ? `"${next.title}"` : '(kosong, balik ke silent)'}`
  );

  if (!next) {
    queue.current = null;
    playSilence();
    if (onQueueEmpty) onQueueEmpty(guildId);
    return;
  }

  queue.current = next;

  try {
    const stream = ytdlp.streamAudio(next.url);
    queue.currentProcess = stream.ytDlpProcess;

    stream.on('error', (err) => {
      log(`[MUSIC] Stream error buat "${next.title}": ${err.message}`);
    });

    const resource = createAudioResource(stream, { inputType: StreamType.Arbitrary });
    player.play(resource);
    log(`[MUSIC] Now playing: ${next.title} (${next.durationText || '?'}) diminta oleh ${next.requestedBy}`);
    if (onTrackStart) onTrackStart(guildId, next);
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
  enqueue,
  playNext,
  playSilence,
  resyncAfterReconnect,
  skip,
  stop,
};
