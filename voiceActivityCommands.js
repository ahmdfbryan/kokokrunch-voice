const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const voiceActivity = require('./voiceActivity');

const LEADERBOARD_COLOR = 0xf1c40f;
const RANK_EMOJI = ['🥇', '🥈', '🥉'];

/**
 * Format durasi panjang (bisa berhari-hari) jadi teks yang enak dibaca,
 * misal "2 hari 5 jam 12 menit" atau "45 menit".
 */
function formatDurationLong(totalSeconds) {
  const totalMinutes = Math.floor(totalSeconds / 60);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;

  const parts = [];
  if (days > 0) parts.push(`${days} hari`);
  if (hours > 0) parts.push(`${hours} jam`);
  if (minutes > 0 || parts.length === 0) parts.push(`${minutes} menit`);
  return parts.join(' ');
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
        await interaction.reply({ embeds: [embed], ephemeral: true });
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
      const top = voiceActivity.getLeaderboard(10);

      if (top.length === 0) {
        const embed = new EmbedBuilder().setColor(0x99aab5).setDescription('📭 Belum ada data aktivitas voice sama sekali.');
        await interaction.reply({ embeds: [embed], ephemeral: true });
        return;
      }

      const lines = top.map((entry, i) => {
        const tier = voiceActivity.getTierInfo(entry.totalSeconds);
        const rank = RANK_EMOJI[i] || `${i + 1}.`;
        return `${rank} **${entry.username}** — ${formatDurationLong(entry.totalSeconds)}\n${tier.emoji} ${tier.title}`;
      });

      const embed = new EmbedBuilder()
        .setColor(LEADERBOARD_COLOR)
        .setTitle('🏆 Voice Leaderboard')
        .setDescription(lines.join('\n\n'));
      await interaction.reply({ embeds: [embed] });
    },
  },
];

module.exports = commands;
