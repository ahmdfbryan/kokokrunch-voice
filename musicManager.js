const { createAudioResource, StreamType } = require('@discordjs/voice');
const ytdl = require('@distube/ytdl-core');
const { createSilentAudioStream } = require('./silentStream');

// State antrian per guild. Bot ini didesain buat 1 guild/channel tetap,
// tapi tetap di-map per guildId biar rapi & gampang diperluas nanti.
const queues = new Map();

let player = null;
let log = console.log;

/**
 * Wajib dipanggil sekali dari index.js setelah AudioPlayer dibuat, supaya
 * modul ini bisa play/stop lewat player yang sama dipakai buat silent audio.
 */
function init(audioPlayer, logger) {
  player = audioPlayer;
  if (logger) log = logger;
}

function getQueue(guildId) {
  if (!queues.has(guildId)) {
    queues.set(guildId, { tracks: [], current: null });
  }
  return queues.get(guildId);
}

/**
 * Tambah track ke antrian. Kalau lagi nggak ada yang muter (cuma silent
 * audio), langsung mulai muter track ini.
 */
function enqueue(guildId, track) {
  const queue = getQueue(guildId);
  queue.tracks.push(track);

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
  const next = queue.tracks.shift();

  if (!next) {
    queue.current = null;
    playSilence();
    return;
  }

  queue.current = next;

  try {
    const stream = ytdl(next.url, {
      filter: 'audioonly',
      quality: 'highestaudio',
      highWaterMark: 1 << 25,
    });
    stream.on('error', (err) => {
      log(`[MUSIC] Stream error buat "${next.title}": ${err.message}`);
    });

    const resource = createAudioResource(stream, { inputType: StreamType.Arbitrary });
    player.play(resource);
    log(`[MUSIC] Now playing: ${next.title} (${next.durationText || '?'}) diminta oleh ${next.requestedBy}`);
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

module.exports = { init, getQueue, enqueue, playNext, playSilence, skip, stop };
