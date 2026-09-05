const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const musicManager = require('./musicManager');

const COLOR = 0x5865f2;
const LOOP_LABELS = { off: 'Off', track: 'Lagu Ini', queue: 'Antrian' };

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
function renderProgressBar(elapsed, total, length = 15) {
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
      embed: new EmbedBuilder().setColor(COLOR).setDescription('Nggak ada musik yang lagi diputar.'),
      components: [],
    };
  }

  const track = queue.current;
  const elapsed = musicManager.getElapsedSeconds(guildId);
  const total = track.durationSeconds || 0;
  const bar = renderProgressBar(elapsed, total);
  const paused = musicManager.isPaused();
  const volumePercent = Math.round(musicManager.getVolume(guildId) * 100);
  const loopLabel = LOOP_LABELS[musicManager.getLoopMode(guildId)] || 'Off';

  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle('Now Playing')
    .setDescription(`**${track.title}**${track.isAutoplay ? ' _(Autoplay)_' : ''}\nAdded by ${track.requestedBy}`)
    .setThumbnail(track.thumbnail || null)
    .addFields(
      { name: 'Queue Size', value: `${queue.tracks.length}`, inline: true },
      { name: 'Volume', value: `${volumePercent}%`, inline: true },
      { name: 'Loop', value: loopLabel, inline: true },
      { name: '\u200b', value: `\`${formatTime(elapsed)}\` ${bar} \`${formatTime(total)}\`` }
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('music_pause')
      .setLabel(paused ? 'Resume' : 'Pause')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('music_skip').setLabel('Skip').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('music_stop').setLabel('Stop').setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('music_autoplay')
      .setLabel(`AutoPlay: ${queue.autoplayEnabled ? 'On' : 'Off'}`)
      .setStyle(queue.autoplayEnabled ? ButtonStyle.Success : ButtonStyle.Secondary)
  );

  return { embed, components: [row] };
}

module.exports = { buildNowPlayingCard };
