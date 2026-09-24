const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');

const EMBED_COLOR = 0x5865f2;

// Pengelompokan command biar rapi ditampilin. Command context-menu (kayak
// "Jadikan Sticky") ditandai beda karena caranya beda (klik kanan pesan,
// bukan diketik). Deskripsinya sendiri diambil otomatis dari masing-masing
// command, jadi kalau deskripsi command berubah, /commands ikut update
// tanpa perlu diedit manual di sini.
const CATEGORIES = [
  {
    label: 'Musik',
    commandNames: ['play', 'skip', 'stop', 'queue', 'autoplay', 'playlist', 'pause', 'resume', 'volume', 'loop', 'nowplaying'],
  },
  { label: 'Voice Activity', commandNames: ['voicestats', 'voiceleaderboard'] },
  { label: 'Sticky Message', commandNames: ['Jadikan Sticky', 'unsticky'] },
  { label: 'Panel', commandNames: ['panel', 'unpanel'] },
  { label: 'Giveaway', commandNames: ['giveaway'] },
  { label: 'AI', commandNames: ['ask'] },
  { label: 'Lainnya', commandNames: ['commands'] },
];

/**
 * Bikin embed "Daftar Command" -- dipakai baik dari /commands maupun dari
 * tombol "Info/Help" di panel bot, biar isinya selalu konsisten satu sumber.
 */
function buildCommandsListEmbed(allCommands) {
  const embed = new EmbedBuilder().setColor(EMBED_COLOR).setTitle('Daftar Command');

  for (const category of CATEGORIES) {
    const lines = [];
    for (const name of category.commandNames) {
      const cmd = allCommands.find((c) => c.data.name === name);
      if (!cmd) continue;

      const json = cmd.data.toJSON();
      if (json.type === 3) {
        // Context-menu command (tipe 3), nggak punya deskripsi bawaan
        lines.push(`**${name}** — klik kanan pesan → Apps → ${name}`);
      } else {
        lines.push(`**/${name}** — ${json.description}`);
      }
    }
    if (lines.length > 0) {
      embed.addFields({ name: category.label, value: lines.join('\n') });
    }
  }

  embed.setFooter({
    text: 'Command musik & playlist juga bisa dipakai lewat prefix, misal s!play, s!skip, s!playlist save <nama>',
  });

  return embed;
}

const commands = [
  {
    data: new SlashCommandBuilder().setName('commands').setDescription('Lihat semua command yang tersedia di bot ini'),
    async execute(interaction, log, allCommands) {
      const embed = buildCommandsListEmbed(allCommands);
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    },
  },
];

module.exports = commands;
module.exports.buildCommandsListEmbed = buildCommandsListEmbed;
