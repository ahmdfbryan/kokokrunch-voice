const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const musicManager = require('./musicManager');

const COLOR = 0x5865f2;

function formatTime(totalSeconds) {
  const total = Math.max(0, Math.floor(totalSeconds || 0));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Progress bar teks, misal "▬▬🔘▬▬▬". Dibikin pendek banget (bukan
 * puluhan karakter) biar nggak ke-wrap -- teks kode/monospace di Discord
 * ternyata lebih lebar dari perkiraan, jadi bar-nya sengaja diperkecil
 * dan waktu di kiri-kanan nggak lagi pakai format kode.
 */
function renderProgressBar(elapsed, total, length = 8) {
  if (!total || total <= 0) return '▬'.repeat(length);
  const ratio = Math.min(1, Math.max(0, elapsed / total));
  const filled = Math.round(ratio * (length - 1));
  return '▬'.repeat(filled) + '🔘' + '▬'.repeat(Math.max(0, length - filled - 1));
}

/**
 * Bangun embed + tombol buat card "Now Playing". Dipakai bareng-bareng
 * oleh command /nowplaying, handler tombol, dan refresh berkala (progress
 * bar jalan tiap ~15 detik) -- biar tampilannya selalu konsisten.
 */
function buildNowPlayingCard(guildId) {
  const queue = musicManager.getQueue(guildId);

  if (!queue.current) {
    return {
      embed: new EmbedBuilder()
        .setColor(0x2b2d31)
        .setAuthor({ name: '🎵 Satpam Voice' })
        .setDescription('No music is currently playing.'),
      components: [],
    };
  }

  const track = queue.current;
  const elapsed = musicManager.getElapsedSeconds(guildId);
  const total = track.durationSeconds || 0;
  const bar = renderProgressBar(elapsed, total);
  const paused = musicManager.isPaused();

  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setAuthor({ name: paused ? '⏸️  Paused' : '🎵  Now Playing' })
    .setTitle(track.title)
    .setDescription(`👤 Added by **${track.requestedBy}**${track.isAutoplay ? '  •  _via Autoplay_' : ''}`)
    .setThumbnail(track.thumbnail || null)
    .addFields({ name: '\u200b', value: `**${formatTime(elapsed)}** ${bar} **${formatTime(total)}**` });

  // Judul jadi link ke video aslinya -- tapi cuma kalau url-nya beneran
  // valid http(s), biar nggak crash kalau ada data track yang nggak lengkap.
  if (/^https?:\/\//i.test(track.url || '')) {
    embed.setURL(track.url);
  }

  // Dipecah jadi 2 row (maks 3 tombol/row) -- selain emang udah kena limit
  // asli Discord (5 tombol/row) begitu "Lirik" ditambahin, ini juga biar
  // konsisten sama aturan tampilan yang dipakai di panel utama.
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('music_pause')
      .setLabel(paused ? 'Resume' : 'Pause')
      .setEmoji(paused ? '▶️' : '⏸️')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('music_skip').setLabel('Skip').setEmoji('⏭️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('music_stop').setLabel('Stop').setEmoji('⏹️').setStyle(ButtonStyle.Danger)
  );
  const row2 = new ActionRowBuilder().addComponents(
    // Tombol info (nggak ngubah state lagu), jadi warnanya netral abu-abu.
    // Mode loop sendiri tetep bisa diatur lewat /loop, cuma nggak ada
    // tombol togglenya lagi di card ini.
    new ButtonBuilder().setCustomId('music_queue').setLabel('Queue').setEmoji('📜').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('music_autoplay')
      .setLabel(`AutoPlay: ${queue.autoplayEnabled ? 'On' : 'Off'}`)
      .setEmoji('🔀')
      .setStyle(queue.autoplayEnabled ? ButtonStyle.Success : ButtonStyle.Secondary),
    // Tombol info (nggak ngubah state lagu), jadi warnanya netral abu-abu.
    new ButtonBuilder().setCustomId('music_lyrics').setLabel('Lirik').setEmoji('🎤').setStyle(ButtonStyle.Secondary)
  );

  return { embed, components: [row1, row2] };
}

// Kunci per-guild buat operasi baca-tulis "pesan Now Playing yang lagi
// ke-track" -- diekspor dari sini (bukan didefinisiin lokal di index.js)
// biar SEMUA tempat yang bisa bikin/nge-update card (index.js buat ganti
// lagu otomatis/refresh/reposisi, DAN commands.js/musicPlaylistCommands.js/
// nowPlayingCommand.js buat /play, /playlist play, /nowplaying) make kunci
// yang SAMA. Kalau kuncinya kepisah-pisah per file, 2 proses masih bisa
// balapan bikin card dobel walau masing-masing "dikunci" versi sendiri.
const npLockChains = new Map();
function withNowPlayingLock(guildId, fn) {
  const previous = npLockChains.get(guildId) || Promise.resolve();
  const next = previous.then(fn, fn).catch((err) => {
    console.error(`[NOWPLAYING] Error dalam operasi terkunci: ${err?.message || err}`);
  });
  npLockChains.set(guildId, next);
  return next;
}

// ============================================================
// RETRY & "BENERAN HILANG vs GANGGUAN SESAAT": dulu, kalau fetch/edit pesan
// Now Playing GAGAL karena alasan APAPUN (rate limit, network blip, Discord
// lagi 500/503, dst), bot langsung nganggep "pesannya udah kehapus" dan
// lepas tangan (bikin card baru / berhenti nge-track) -- padahal pesan
// lamanya bisa aja masih ada, cuma gagal diedit SESAAT doang. Itu yang
// ninggalin "jejak" card lama yang beku nyangkut di channel. 2 helper di
// bawah ini misahin kasusnya:
//   - isMessageReallyGone: TRUE cuma kalau kode errornya KONFIRMED dari
//     Discord ("Unknown Message" / "Unknown Channel") -- selain itu
//     dianggap gangguan sesaat.
//   - withTransientRetry: bungkus operasi fetch/edit, retry otomatis (2x,
//     jeda singkat) KHUSUS buat error yang BUKAN konfirmed hilang. Kalau
//     ketemu error yang konfirmed hilang, langsung dilempar lagi tanpa
//     nunggu (nggak ada gunanya retry, pesannya DEFINITELY udah nggak ada).
//     Retry-nya dibatasi jumlahnya (bukan nunggu selamanya) dan nggak
//     nambah timer/listener baru -- jadi nggak ada risiko jadi loop kayak
//     masalah reposisi panel/Now Playing yang dulu (itu sumbernya beda,
//     dari `messageCreate` yang kedetect balik, bukan dari sini).
const TRANSIENT_RETRY_DELAYS_MS = [500, 1500]; // percobaan ke-2 & ke-3 doang yang pakai jeda, percobaan pertama langsung

function isMessageReallyGone(err) {
  return err?.code === 10008 || err?.code === 10003; // Unknown Message / Unknown Channel
}

async function withTransientRetry(fn) {
  let lastErr;
  for (let attempt = 0; attempt <= TRANSIENT_RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (isMessageReallyGone(err)) throw err; // konfirmed hilang -- nggak perlu nunggu, langsung nyerah
      lastErr = err;
      if (attempt < TRANSIENT_RETRY_DELAYS_MS.length) {
        await new Promise((resolve) => setTimeout(resolve, TRANSIENT_RETRY_DELAYS_MS[attempt]));
      }
    }
  }
  throw lastErr;
}

/**
 * Coba hapus 1 pesan (by channelId + messageId), best-effort -- dipakai pas
 * mau "lepas tangan" dari sebuah card Now Playing yang gagal di-edit
 * (walau udah di-retry) TAPI bukan karena konfirmed udah hilang. Jaga-jaga
 * biar pesan itu nggak nyangkut jadi jejak kalau ternyata masih ada di
 * channel, cuma kebetulan gagal diedit gara-gara gangguan sesaat.
 */
async function safeDeleteTrackedMessage(client, channelId, messageId) {
  try {
    const channel = await client.channels.fetch(channelId);
    const message = await channel.messages.fetch(messageId);
    await message.delete();
  } catch {
    // udah kehapus / nggak ketemu / gagal lagi -- diabaikan, ini emang cuma best-effort
  }
}

/**
 * Buat/timpa card Now Playing khusus lewat jalur COMMAND (/play langsung
 * main, /playlist play, /nowplaying) -- beda dari update yang dipicu
 * proses background di index.js (ganti lagu otomatis dll), soalnya di sini
 * kita WAJIB ngasih balesan ke interaction Discord-nya (nggak bisa "edit
 * pesan lain terus selesai tanpa reply" kayak proses background bisa).
 * Makanya card lama (kalau ada) langsung DIHAPUS dulu, baru kirim yang
 * baru lewat `sendFn` -- tetep di bawah kunci yang sama biar nggak pernah
 * race sama proses lain yang juga lagi megang card ini.
 *
 * `sendFn(embed, components)` harus resolve ke Message yang baru dikirim,
 * misal lewat `interaction.editReply(...)` atau `channel.send(...)`.
 */
async function claimNowPlayingCard(guildId, client, sendFn) {
  return withNowPlayingLock(guildId, async () => {
    const oldMsg = musicManager.getNowPlayingMessage(guildId);
    if (oldMsg) {
      try {
        await withTransientRetry(async () => {
          const oldChannel = await client.channels.fetch(oldMsg.channelId);
          const oldMessage = await oldChannel.messages.fetch(oldMsg.messageId);
          await oldMessage.delete();
        });
      } catch {
        // udah kehapus / nggak ketemu, ATAU gagal lagi walau udah di-retry --
        // kedua kasus ini aman diabaikan (best-effort), lanjut kirim card baru di bawah
      }
    }

    const { embed, components } = buildNowPlayingCard(guildId);
    const sentMessage = await sendFn(embed, components);
    musicManager.setNowPlayingMessage(guildId, sentMessage.channelId, sentMessage.id);
    return sentMessage;
  });
}

module.exports = {
  buildNowPlayingCard,
  withNowPlayingLock,
  claimNowPlayingCard,
  isMessageReallyGone,
  withTransientRetry,
  safeDeleteTrackedMessage,
};
