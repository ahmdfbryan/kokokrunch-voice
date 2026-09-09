const { SlashCommandBuilder } = require('discord.js');
const musicManager = require('./musicManager');
const { buildNowPlayingCard, claimNowPlayingCard } = require('./nowPlayingCard');

const commands = [
  {
    data: new SlashCommandBuilder().setName('nowplaying').setDescription('Lihat & kontrol lagu yang lagi diputar'),
    async execute(interaction) {
      // Kalau nggak ada musik yang main, nggak perlu klaim/nge-track apa-apa --
      // cukup tampilin embed "nggak ada musik" biasa, sekali doang.
      if (!musicManager.getQueue(interaction.guildId).current) {
        const { embed } = buildNowPlayingCard(interaction.guildId);
        await interaction.reply({ embeds: [embed] });
        return;
      }

      await claimNowPlayingCard(interaction.guildId, interaction.client, (embed, components) =>
        interaction.reply({ embeds: [embed], components, fetchReply: true })
      );
    },
  },
];

module.exports = commands;
