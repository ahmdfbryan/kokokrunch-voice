const {
  ContextMenuCommandBuilder,
  ApplicationCommandType,
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
} = require('discord.js');
const stickyStore = require('./stickyMessage');
const stickyManager = require('./stickyManager');

const commands = [
  {
    data: new ContextMenuCommandBuilder()
      .setName('Jadikan Sticky')
      .setType(ApplicationCommandType.Message)
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
    async execute(interaction) {
      const target = interaction.targetMessage;

      if (!target.content && target.embeds.length === 0) {
        const embed = new EmbedBuilder()
          .setColor(0x99aab5)
          .setDescription('Pesan ini kosong (nggak ada teks/embed), nggak bisa dijadiin sticky.');
        await interaction.reply({ embeds: [embed], ephemeral: true });
        return;
      }

      const embedsJson = target.embeds.map((e) => e.toJSON());

      // Kalau pesan aslinya punya gambar (attachment) tapi belum ada embed,
      // ikutan tampilin gambarnya lewat embed baru. Attachment asli nggak
      // bisa "dipindah", tapi URL gambarnya masih valid buat ditampilkan.
      const imageAttachment = target.attachments.find((a) => a.contentType?.startsWith('image/'));
      if (imageAttachment && embedsJson.length === 0) {
        embedsJson.push({ image: { url: imageAttachment.url } });
      }

      stickyStore.setSticky(interaction.channelId, { content: target.content, embeds: embedsJson });
      stickyManager.scheduleRepost(interaction.channelId);

      const embed = new EmbedBuilder().setColor(0x57f287).setDescription('Pesan ini sekarang jadi sticky message di channel ini.');
      await interaction.reply({ embeds: [embed], ephemeral: true });
    },
  },

  {
    data: new SlashCommandBuilder()
      .setName('unsticky')
      .setDescription('Matikan sticky message di channel ini')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
    async execute(interaction) {
      const sticky = stickyStore.getSticky(interaction.channelId);
      const had = stickyStore.removeSticky(interaction.channelId);

      if (!had) {
        const embed = new EmbedBuilder().setColor(0x99aab5).setDescription('Nggak ada sticky message aktif di channel ini.');
        await interaction.reply({ embeds: [embed], ephemeral: true });
        return;
      }

      if (sticky?.stickyMessageId) {
        try {
          const channel = await interaction.client.channels.fetch(interaction.channelId);
          const msg = await channel.messages.fetch(sticky.stickyMessageId);
          await msg.delete();
        } catch {
          // udah kehapus / nggak ketemu, aman diabaikan
        }
      }

      const embed = new EmbedBuilder().setColor(0x57f287).setDescription('Sticky message di channel ini udah dimatiin.');
      await interaction.reply({ embeds: [embed], ephemeral: true });
    },
  },
];

module.exports = commands;
