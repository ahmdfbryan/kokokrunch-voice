const { Readable } = require('stream');

// Discord voice pakai raw PCM: 48kHz, 16-bit signed, stereo.
// Satu frame Opus = 20ms -> 48000 * 0.02 * 2 channel * 2 byte = 3840 byte per frame.
const FRAME_SIZE = 3840;
const FRAME_INTERVAL_MS = 20;

/**
 * Readable stream yang terus-menerus mengeluarkan silence (buffer nol)
 * setiap 20ms, meniru cadence real-time audio agar @discordjs/voice
 * menganggap ada aktivitas audio dan koneksi voice tetap alive.
 */
function createSilentAudioStream() {
  let timer = null;

  const stream = new Readable({
    read() {
      // Pacing dilakukan lewat setInterval di bawah, bukan di sini,
      // supaya throughput-nya konsisten 20ms per frame.
    },
  });

  timer = setInterval(() => {
    const silence = Buffer.alloc(FRAME_SIZE, 0);
    if (!stream.push(silence)) {
      clearInterval(timer);
    }
  }, FRAME_INTERVAL_MS);

  stream.on('close', () => clearInterval(timer));
  stream._destroy = (err, callback) => {
    clearInterval(timer);
    callback(err);
  };

  return stream;
}

module.exports = { createSilentAudioStream };