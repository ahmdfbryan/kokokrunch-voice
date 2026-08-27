const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const musicManager = require('./musicManager');
const { resolveTrack, isPlaylistUrl, resolvePlaylist } = require('./trackResolver');

const COLOR = 0x5865f2;
const PLAYLIST_MAX_TRACKS = 100;
const PLAYLIST_PREVIEW_COUNT = 10;

/**
 * Bikin embed teks polos: cuma garis + background biru di kiri, tanpa
 * judul/thumbnail/footer. Dipakai buat semua pesan singkat bot.
 */
function textEmbed(text) {
  return new EmbedBuilder().setColor(COLOR).setDescription(text);
}

/**
 * Format detik jadi teks panjang gampang dibaca, misal "1 jam 5 menit"
 * atau "Sekarang" buat ETA 0.
 */
function formatEta(totalSeconds) {
  if (totalSeconds <= 0) return 'Sekarang';
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  const parts = [];
  if (h > 0) parts.push(`${h} jam`);
  if (m > 0) parts.push(`${m} menit`);
  if (h === 0 && m === 0) parts.push(`${s} detik`);
  return parts.join(' ');
}

function formatTotalDuration(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const parts = [];
  if (h > 0) parts.push(`${h} jam`);
  parts.push(`${m} menit`);
  return parts.join(' ');
}

const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('play')
      .setDescription('Putar musik dari link YouTube, link Spotify, atau kata kunci judul lagu')
      .addStringOption((opt) =>
        opt.setName('input').setDescription('Link YouTube/Spotify, link playlist, atau judul lagu').setRequired(true)
      ),
    async execute(interaction, log) {
      await interaction.deferReply();

      const input = interaction.options.getString('input', true);

      // Playlist YouTube: tambahin SEMUA lagu di dalamnya sekaligus, beda
      // alur dari single track biasa.
      if (isPlaylistUrl(input)) {
        let tracks;
        try {
          tracks = await resolvePlaylist(input, PLAYLIST_MAX_TRACKS);
        } catch (err) {
          log(`[MUSIC] Resolve playlist gagal: ${err.message}`);
          await interaction.editReply({ embeds: [textEmbed(err.message)] });
          return;
        }

        tracks.forEach((t) => {
          t.requestedBy = interaction.user.tag;
        });

        musicManager.setTextChannel(interaction.guildId, interaction.channelId);
        const { etaList } = musicManager.enqueueMany(interaction.guildId, tracks);

        const totalSeconds = tracks.reduce((sum, t) => sum + (t.durationSeconds || 0), 0);
        const firstEtaSeconds = etaList[0]?.etaSeconds ?? 0;

        const titleList = etaList
          .slice(0, PLAYLIST_PREVIEW_COUNT)
          .map((e, i) => `${i + 1}. ${e.track.title}`)
          .join('\n');
        const extra = etaList.length > PLAYLIST_PREVIEW_COUNT ? `\n...dan ${etaList.length - PLAYLIST_PREVIEW_COUNT} lagu lainnya` : '';

        const embed = new EmbedBuilder()
          .setColor(COLOR)
          .setTitle('Playlist Ditambahkan')
          .setDescription(
            `${tracks.length} lagu dari playlist ditambahkan ke antrian.\n\n` +
              `${titleList}${extra}\n\n` +
              `Track Length: ${formatTotalDuration(totalSeconds)}\n` +
              `Estimated time until played: ${formatEta(firstEtaSeconds)}`
          );
        await interaction.editReply({ embeds: [embed] });
        return;
      }

      let track;
      try {
        track = await resolveTrack(input);
      } catch (err) {
        log(`[MUSIC] Resolve gagal: ${err.message}`);
        await interaction.editReply({ embeds: [textEmbed(err.message)] });
        return;
      }

      track.requestedBy = interaction.user.tag;

      musicManager.setTextChannel(interaction.guildId, interaction.channelId);
      const { position, startedImmediately } = musicManager.enqueue(interaction.guildId, track);

      if (startedImmediately) {
        await interaction.editReply({ embeds: [textEmbed(`Started playing **${track.title}**`)] });
      } else {
        await interaction.editReply({
          embeds: [textEmbed(`**${track.title}** ditambahkan ke antrian (posisi #${position})`)],
        });
      }
    },
  },

  {
    data: new SlashCommandBuilder().setName('skip').setDescription('Skip lagu yang lagi diputar'),
    async execute(interaction) {
      const queue = musicManager.getQueue(interaction.guildId);
      const skippedTrack = queue.current;

      const skipped = musicManager.skip(interaction.guildId);
      if (!skipped) {
        await interaction.reply({ embeds: [textEmbed('Nggak ada lagu yang lagi diputar.')], ephemeral: true });
        return;
      }
      await interaction.reply({
        embeds: [textEmbed(`**${skippedTrack.title}** has been skipped by <@${interaction.user.id}>`)],
      });
    },
  },

  {
    data: new SlashCommandBuilder().setName('stop').setDescription('Stop musik dan kosongkan antrian'),
    async execute(interaction) {
      const hadSomething = musicManager.stop(interaction.guildId);
      if (!hadSomething) {
        await interaction.reply({
          embeds: [textEmbed('Nggak ada musik yang lagi diputar atau diantrikan.')],
          ephemeral: true,
        });
        return;
      }
      await interaction.reply({ embeds: [textEmbed('Musik dihentikan, antrian dikosongkan.')] });
    },
  },

  {
    data: new SlashCommandBuilder().setName('queue').setDescription('Lihat antrian musik saat ini'),
    async execute(interaction) {
      const queue = musicManager.getQueue(interaction.guildId);

      if (!queue.current && queue.tracks.length === 0) {
        await interaction.reply({
          embeds: [textEmbed('Antrian kosong, nggak ada musik yang diputar.')],
          ephemeral: true,
        });
        return;
      }

      const embed = new EmbedBuilder().setColor(COLOR).setTitle('Antrian Musik');

      if (queue.current) {
        embed.addFields({
          name: 'Sedang Diputar',
          value: `**${queue.current.title}** — diminta oleh ${queue.current.requestedBy}`,
        });
      }

      if (queue.tracks.length > 0) {
        const list = queue.tracks
          .slice(0, 10)
          .map((t, i) => `${i + 1}. **${t.title}** — diminta oleh ${t.requestedBy}`)
          .join('\n');
        const extra = queue.tracks.length > 10 ? `\n...dan ${queue.tracks.length - 10} lagu lainnya` : '';
        embed.addFields({ name: 'Berikutnya', value: list + extra });
      }

      await interaction.reply({ embeds: [embed] });
    },
  },
];

module.exports = [
  ...commands,
  ...require('./voiceActivityCommands'),
  ...require('./stickyCommands'),
  ...require('./giveawayCommands'),
  ...require('./aiCommands'),
  ...require('./commandsList'),
];
