const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const aiChat = require('./aiChat');
const config = require('./config');

const EMBED_COLOR = 0x5865f2;
// Batas aman description embed (limit asli Discord 4096 karakter)
const MAX_EMBED_LEN = 4000;

const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('ask')
      .setDescription('Tanya sesuatu ke AI')
      .addStringOption((opt) => opt.setName('pertanyaan').setDescription('Pertanyaan kamu').setRequired(true)),
    async execute(interaction) {
      if (interaction.channelId !== config.voiceChannelId) {
        await interaction.reply({
          content: `Command ini cuma bisa dipakai di <#${config.voiceChannelId}>.`,
          ephemeral: true,
        });
        return;
      }

      await interaction.deferReply();
      const question = interaction.options.getString('pertanyaan', true);

      try {
        const answer = await aiChat.askOnce(question);
        const embed = new EmbedBuilder().setColor(EMBED_COLOR).setDescription(answer.slice(0, MAX_EMBED_LEN));
        await interaction.editReply({ embeds: [embed] });
      } catch (err) {
        await interaction.editReply(`Gagal minta jawaban dari AI: ${err.message}`);
      }
    },
  },
];

module.exports = commands;
