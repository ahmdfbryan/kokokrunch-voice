const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const musicManager = require('./musicManager');
const { resolveTrack } = require('./trackResolver');

const COLOR = 0x5865f2;

/**
 * Bikin embed teks polos: cuma garis + background biru di kiri, tanpa
 * judul/thumbnail/footer. Dipakai buat semua pesan singkat bot.
 */
function textEmbed(text) {
  return new EmbedBuilder().setColor(COLOR).setDescription(text);
}

const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('play')
      .setDescription('Putar musik dari link YouTube, link Spotify, atau kata kunci judul lagu')
      .addStringOption((opt) =>
        opt.setName('input').setDescription('Link YouTube/Spotify atau judul lagu').setRequired(true)
      ),
    async execute(interaction, log) {
      await interaction.deferReply();

      const input = interaction.options.getString('input', true);

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

module.exports = [...commands, ...require('./voiceActivityCommands')];
