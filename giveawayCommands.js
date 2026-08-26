const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const giveawayManager = require('./giveawayManager');

const REQUIRED_PERMS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];

const giveawayCommand = {
  data: new SlashCommandBuilder()
    .setName('giveaway')
    .setDescription('Kelola giveaway di server ini')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      sub
        .setName('create')
        .setDescription('Mulai giveaway baru')
        .addStringOption((opt) =>
          opt.setName('prize').setDescription('Hadiah giveaway, misal: 550 ROBUX VIA PAYOUT').setRequired(true)
        )
        .addStringOption((opt) => opt.setName('duration').setDescription('Durasi, misal: 30m, 1h, 2d, 1h30m').setRequired(true))
        .addIntegerOption((opt) => opt.setName('winners').setDescription('Jumlah pemenang (default 1)').setMinValue(1).setMaxValue(50))
        .addChannelOption((opt) => opt.setName('channel').setDescription('Channel tujuan (default: channel ini)'))
    )
    .addSubcommand((sub) =>
      sub
        .setName('end')
        .setDescription('Akhiri giveaway sekarang juga')
        .addStringOption((opt) => opt.setName('message_id').setDescription('Message ID giveaway').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('reroll')
        .setDescription('Undi ulang pemenang untuk giveaway yang sudah selesai')
        .addStringOption((opt) => opt.setName('message_id').setDescription('Message ID giveaway').setRequired(true))
    )
    .addSubcommand((sub) => sub.setName('list').setDescription('Lihat semua giveaway aktif di server ini')),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'create') {
      const prize = interaction.options.getString('prize', true);
      const durationStr = interaction.options.getString('duration', true);
      const winnerCount = interaction.options.getInteger('winners') ?? 1;
      const channel = interaction.options.getChannel('channel') ?? interaction.channel;

      const durationMs = giveawayManager.parseDuration(durationStr);
      if (!durationMs || durationMs < 10_000) {
        return interaction.reply({
          content: 'Durasi tidak valid. Gunakan format seperti `30m`, `1h`, `2d`, atau `1h30m` (minimum 10 detik).',
          flags: MessageFlags.Ephemeral,
        });
      }
      if (!channel?.isTextBased?.()) {
        return interaction.reply({ content: 'Channel yang dipilih bukan text channel.', flags: MessageFlags.Ephemeral });
      }

      const botPerms = channel.permissionsFor(interaction.client.user);
      const missing = botPerms ? botPerms.missing(REQUIRED_PERMS) : REQUIRED_PERMS;
      if (missing.length > 0) {
        return interaction.reply({
          content: `Bot tidak punya izin \`${missing.join(', ')}\` di <#${channel.id}>. Tambahkan izin View Channel, Send Messages, dan Embed Links untuk role bot di channel tersebut, lalu coba lagi.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const giveaway = await giveawayManager.createGiveaway({ channel, host: interaction.user, prize, winnerCount, durationMs });
      return interaction.editReply({
        content: `Giveaway dibuat di <#${channel.id}>! Berakhir dalam ${giveawayManager.formatDuration(durationMs)}. (ID: \`${giveaway.id}\`)`,
      });
    }

    if (sub === 'end') {
      const messageId = interaction.options.getString('message_id', true);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const result = await giveawayManager.endGiveaway(interaction.client, messageId);
      if (!result.ok) return interaction.editReply({ content: `Gagal mengakhiri giveaway: \`${result.reason}\`` });
      return interaction.editReply({ content: `Giveaway \`${messageId}\` telah diakhiri.` });
    }

    if (sub === 'reroll') {
      const messageId = interaction.options.getString('message_id', true);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const result = await giveawayManager.rerollGiveaway(interaction.client, messageId);
      if (!result.ok) return interaction.editReply({ content: `Gagal reroll: \`${result.reason}\`` });
      return interaction.editReply({ content: `Pemenang baru sudah diundi untuk giveaway \`${messageId}\`.` });
    }

    if (sub === 'list') {
      const all = giveawayManager.loadAll();
      const active = all.filter((g) => g.guildId === interaction.guildId && !g.ended);
      if (active.length === 0) {
        return interaction.reply({ content: 'Tidak ada giveaway aktif saat ini.', flags: MessageFlags.Ephemeral });
      }
      const lines = active.map(
        (g) =>
          `• **${g.prize}** — ID \`${g.id}\` — <#${g.channelId}> — berakhir <t:${Math.floor(g.endTime / 1000)}:R> — ${g.participants.length} peserta`
      );
      return interaction.reply({ content: lines.join('\n'), flags: MessageFlags.Ephemeral });
    }
  },
};

module.exports = [giveawayCommand];
