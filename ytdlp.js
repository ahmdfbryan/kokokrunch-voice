const { spawn, execFile } = require('child_process');

const YT_DLP_BIN = 'yt-dlp';

/**
 * Ambil metadata (judul, durasi, thumbnail) dari link YouTube tanpa
 * download audio-nya, pakai `yt-dlp --dump-json`.
 */
function getInfo(url) {
  return new Promise((resolve, reject) => {
    execFile(
      YT_DLP_BIN,
      ['--dump-json', '--no-warnings', '--skip-download', '--no-playlist', url],
      { maxBuffer: 1024 * 1024 * 10, timeout: 20_000 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(describeYtDlpError(err, stderr)));
          return;
        }
        try {
          const data = JSON.parse(stdout);
          resolve({
            title: data.title,
            url: data.webpage_url || url,
            durationText: formatDuration(data.duration),
            thumbnail: data.thumbnail || null,
          });
        } catch (parseErr) {
          reject(new Error(`Gagal parsing info video: ${parseErr.message}`));
        }
      }
    );
  });
}

/**
 * Buka stream audio (readable) dari link YouTube. yt-dlp yang milih format
 * audio terbaik dan nge-stream langsung ke stdout ("-o -"), tanpa nyimpen
 * file sementara ke disk.
 */
function streamAudio(url) {
  const proc = spawn(
    YT_DLP_BIN,
    [
      '-f',
      'bestaudio/best',
      '-o',
      '-',
      '--no-playlist',
      '--no-warnings',
      '--quiet',
      url,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );

  let stderrBuffer = '';
  proc.stderr.on('data', (chunk) => {
    stderrBuffer += chunk.toString();
    if (stderrBuffer.length > 4000) stderrBuffer = stderrBuffer.slice(-4000); // cegah membengkak
  });

  proc.on('error', (err) => {
    proc.stdout.emit('error', new Error(`Gagal menjalankan yt-dlp: ${err.message}`));
  });

  proc.on('close', (code) => {
    if (code !== 0 && code !== null) {
      proc.stdout.emit('error', new Error(describeYtDlpError({ code }, stderrBuffer)));
    }
  });

  // Simpan referensi proses di stream-nya supaya bisa di-kill kalau lagu di-skip
  proc.stdout.ytDlpProcess = proc;
  return proc.stdout;
}

function describeYtDlpError(err, stderr) {
  if (err.code === 'ENOENT') {
    return (
      'Binary "yt-dlp" tidak ditemukan di server. Install dulu: pip install -U yt-dlp ' +
      '(lihat README.md bagian "Setup yt-dlp").'
    );
  }
  const trimmedStderr = (stderr || '').trim();
  if (trimmedStderr) {
    // Ambil baris ERROR paling relevan aja, biar nggak spam ke user
    const lastErrorLine =
      trimmedStderr
        .split('\n')
        .reverse()
        .find((line) => line.includes('ERROR')) || trimmedStderr.split('\n').pop();
    return lastErrorLine.replace(/^ERROR:\s*/, '');
  }
  return `yt-dlp keluar dengan kode error ${err.code}`;
}

function formatDuration(totalSeconds) {
  if (!totalSeconds || Number.isNaN(totalSeconds)) return null;
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  const mm = String(m).padStart(h > 0 ? 2 : 1, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

module.exports = { getInfo, streamAudio };
