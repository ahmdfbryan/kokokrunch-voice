const { SlashCommandBuilder } = require('discord.js');
const musicManager = require('./musicManager');
const { buildNowPlayingCard } = require('./nowPlayingCard');

const commands = [
  {
    data: new SlashCommandBuilder().setName('nowplaying').setDescription('Lihat & kontrol lagu yang lagi diputar'),
    async execute(interaction) {
      const { embed, components } = buildNowPlayingCard(interaction.guildId);
      const reply = await interaction.reply({ embeds: [embed], components, fetchReply: true });

      if (musicManager.getQueue(interaction.guildId).current) {
        musicManager.setNowPlayingMessage(interaction.guildId, interaction.channelId, reply.id);
      }
    },
  },
];

module.exports = commands;
