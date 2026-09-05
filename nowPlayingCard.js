const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const musicManager = require('./musicManager');

const COLOR = 0x5865f2;
const LOOP_CYCLE = ['off', 'track', 'queue'];
const LOOP_META = {
  off: { label: 'Loop: Off', emoji: '➡️', fieldValue: 'Off' },
  track: { label: 'Loop: Track', emoji: '🔂', fieldValue: 'Lagu Ini' },
  queue: { label: 'Loop: Queue', emoji: '🔁', fieldValue: 'Antrian' },
};

function formatTime(totalSeconds) {
  const total = Math.max(0, Math.floor(totalSeconds || 0));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Progress bar teks, misal "▬▬▬▬▬🔘▬▬▬▬▬▬▬▬▬". Kalau durasi total nggak
 * diketahui (durationSeconds null), tampilin bar kosong aja.
 */
function renderProgressBar(elapsed, total, length = 18) {
  if (!total || total <= 0) return '▬'.repeat(length);
  const ratio = Math.min(1, Math.max(0, elapsed / total));
  const filled = Math.round(ratio * (length - 1));
  return '▬'.repeat(filled) + '🔘' + '▬'.repeat(Math.max(0, length - filled - 1));
}

/**
 * Loop mode berikutnya kalau tombol Loop diklik: off -> track -> queue -> off -> ...
 */
function cycleLoopMode(current) {
  const idx = LOOP_CYCLE.indexOf(current);
  return LOOP_CYCLE[(idx + 1) % LOOP_CYCLE.length];
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
        .setDescription('Nggak ada musik yang lagi diputar.'),
      components: [],
    };
  }

  const track = queue.current;
  const elapsed = musicManager.getElapsedSeconds(guildId);
  const total = track.durationSeconds || 0;
  const bar = renderProgressBar(elapsed, total);
  const paused = musicManager.isPaused();
  const volumePercent = Math.round(musicManager.getVolume(guildId) * 100);
  const loopMode = musicManager.getLoopMode(guildId);
  const loopMeta = LOOP_META[loopMode] || LOOP_META.off;
  const volumeIcon = volumePercent === 0 ? '🔇' : volumePercent < 50 ? '🔉' : '🔊';

  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setAuthor({ name: paused ? '⏸️  Paused' : '🎵  Now Playing' })
    .setTitle(track.title)
    .setDescription(
      `👤 Added by **${track.requestedBy}**${track.isAutoplay ? '  •  _via Autoplay_' : ''}\n` +
        `\`${formatTime(elapsed)}\`  ${bar}  \`${formatTime(total)}\``
    )
    .setThumbnail(track.thumbnail || null)
    .addFields(
      { name: '📜 Queue', value: `${queue.tracks.length} song${queue.tracks.length === 1 ? '' : 's'}`, inline: true },
      { name: `${volumeIcon} Volume`, value: `${volumePercent}%`, inline: true },
      { name: `${loopMeta.emoji} Loop`, value: loopMeta.fieldValue, inline: true }
    )
    .setFooter({ text: 'Satpam Voice • Music Player' })
    .setTimestamp();

  // Judul jadi link ke video aslinya -- tapi cuma kalau url-nya beneran
  // valid http(s), biar nggak crash kalau ada data track yang nggak lengkap.
  if (/^https?:\/\//i.test(track.url || '')) {
    embed.setURL(track.url);
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('music_pause')
      .setLabel(paused ? 'Resume' : 'Pause')
      .setEmoji(paused ? '▶️' : '⏸️')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('music_skip').setLabel('Skip').setEmoji('⏭️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('music_stop').setLabel('Stop').setEmoji('⏹️').setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('music_loop')
      .setLabel(loopMeta.label)
      .setEmoji(loopMeta.emoji)
      .setStyle(loopMode === 'off' ? ButtonStyle.Secondary : ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('music_autoplay')
      .setLabel(`AutoPlay: ${queue.autoplayEnabled ? 'On' : 'Off'}`)
      .setEmoji('🔀')
      .setStyle(queue.autoplayEnabled ? ButtonStyle.Success : ButtonStyle.Secondary)
  );

  return { embed, components: [row] };
}

module.exports = { buildNowPlayingCard, cycleLoopMode };
