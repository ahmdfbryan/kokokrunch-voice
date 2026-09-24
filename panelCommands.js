const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags, EmbedBuilder } = require('discord.js');
const panelStore = require('./panelStore');

const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('panel')
      .setDescription('Aktifkan panel akses fitur bot (sticky) di channel ini')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
    // `panelApi` (4th arg) di-suplai index.js -- cuma command ini yang pakai.
    async execute(interaction, log, allCommands, panelApi) {
      panelStore.setPanel(interaction.channelId);
      try {
        await panelApi.repositionChannelStack(interaction.guildId, interaction.channelId);
      } catch (err) {
        log(`[PANEL] Gagal aktifin panel: ${err?.stack || err}`);
      }
      await interaction.reply({
        embeds: [new EmbedBuilder().setColor(0x57f287).setDescription('Panel bot udah aktif di channel ini.')],
        flags: MessageFlags.Ephemeral,
      });
    },
  },

  {
    data: new SlashCommandBuilder()
      .setName('unpanel')
      .setDescription('Matikan panel bot di channel ini')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
    async execute(interaction) {
      const panel = panelStore.getPanel(interaction.channelId);
      const had = panelStore.removePanel(interaction.channelId);

      if (!had) {
        await interaction.reply({
          embeds: [new EmbedBuilder().setColor(0x99aab5).setDescription('Nggak ada panel aktif di channel ini.')],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (panel?.panelMessageId) {
        try {
          const channel = await interaction.client.channels.fetch(interaction.channelId);
          const msg = await channel.messages.fetch(panel.panelMessageId);
          await msg.delete();
        } catch {
          // udah kehapus / nggak ketemu, aman diabaikan
        }
      }

      await interaction.reply({
        embeds: [new EmbedBuilder().setColor(0x57f287).setDescription('Panel bot di channel ini udah dimatiin.')],
        flags: MessageFlags.Ephemeral,
      });
    },
  },
];

module.exports = commands;
