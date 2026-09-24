const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const voiceActivity = require('./voiceActivity');

const LEADERBOARD_COLOR = 0xf1c40f;
// 3 besar pakai medali, sisanya pakai angka bulat biru -- mirip gaya
// leaderboard channel voice yang dicontohin user (rank -> nama -> title ->
// durasi, masing-masing baris sendiri per entry).
const RANK_ICONS = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
const { formatDurationLong } = voiceActivity;

/**
 * Bikin embed "Voice Leaderboard" -- dipakai baik dari /voiceleaderboard
 * maupun dari dropdown "Leaderboard" di panel bot, biar tampilannya selalu
 * konsisten satu sumber. Tiap entry ditulis 3 baris terpisah (rank+nama,
 * title/tier, durasi) dipisah baris kosong antar entry, biar render-nya
 * SAMA PERSIS baik di HP maupun laptop (murni teks description, bukan
 * field inline yang suka berantakan di HP).
 */
function buildLeaderboardEmbed() {
  const top = voiceActivity.getLeaderboard(10);

  if (top.length === 0) {
    return new EmbedBuilder().setColor(0x99aab5).setDescription('📭 Belum ada data aktivitas voice sama sekali.');
  }

  const blocks = top.map((entry, i) => {
    const tier = voiceActivity.getTierInfo(entry.totalSeconds);
    const icon = RANK_ICONS[i] || `#${i + 1}`;
    return [
      `${icon}  ➜  **${entry.username}**`,
      `👑 Title: ${tier.emoji} ${tier.title}`,
      `⏱️ Durasi: ${formatDurationLong(entry.totalSeconds)}`,
    ].join('\n');
  });

  return new EmbedBuilder().setColor(LEADERBOARD_COLOR).setTitle('🏆 Voice Leaderboard').setDescription(blocks.join('\n\n'));
}

const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('voicestats')
      .setDescription('Lihat statistik aktivitas voice channel')
      .addUserOption((opt) =>
        opt.setName('user').setDescription('Member yang mau dilihat (default: kamu sendiri)').setRequired(false)
      ),
    async execute(interaction) {
      const target = interaction.options.getUser('user') || interaction.user;
      const stats = voiceActivity.getStats(target.id);

      if (!stats) {
        const who = target.id === interaction.user.id ? 'Kamu' : target.username;
        const embed = new EmbedBuilder()
          .setColor(0x99aab5)
          .setDescription(`📭 ${who} belum pernah tercatat aktivitas voice-nya.`);
        await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
        return;
      }

      const tier = voiceActivity.getTierInfo(stats.totalSeconds);
      const progress = voiceActivity.getProgress(stats.totalSeconds);
      const bar = voiceActivity.renderProgressBar(progress.percent);

      const progressText = progress.isMax
        ? `${bar} 100%\nTier tertinggi tercapai! 🎉`
        : `${bar} ${Math.round(progress.percent * 100)}%\n${progress.hoursRemaining.toFixed(1)} jam lagi menuju ${progress.next.emoji} **${progress.next.title}**`;

      const embed = new EmbedBuilder()
        .setColor(tier.color)
        .setAuthor({ name: `Voice Stats — ${target.username}`, iconURL: target.displayAvatarURL() })
        .setThumbnail(target.displayAvatarURL())
        .addFields(
          { name: '🎧 Total Voice Time', value: formatDurationLong(stats.totalSeconds), inline: true },
          { name: '🔥 Streak Sekarang', value: `${stats.currentStreak} hari`, inline: true },
          { name: '🏆 Streak Terpanjang', value: `${stats.longestStreak} hari`, inline: true },
          { name: 'Title', value: `${tier.emoji} **${tier.title}**`, inline: false },
          { name: 'Progress ke Tier Berikutnya', value: progressText, inline: false }
        );
      if (stats.isActive) embed.setFooter({ text: '🟢 Lagi aktif di voice sekarang' });

      await interaction.reply({ embeds: [embed] });
    },
  },

  {
    data: new SlashCommandBuilder().setName('voiceleaderboard').setDescription('Lihat leaderboard voice activity server ini'),
    async execute(interaction) {
      const isEmpty = voiceActivity.getLeaderboard(10).length === 0;
      const embed = buildLeaderboardEmbed();
      await interaction.reply({ embeds: [embed], flags: isEmpty ? MessageFlags.Ephemeral : undefined });
    },
  },
];

module.exports = commands;
module.exports.buildLeaderboardEmbed = buildLeaderboardEmbed;
