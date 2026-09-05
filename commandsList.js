const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

const EMBED_COLOR = 0x5865f2;

// Pengelompokan command biar rapi ditampilin. Command context-menu (kayak
// "Jadikan Sticky") ditandai beda karena caranya beda (klik kanan pesan,
// bukan diketik). Deskripsinya sendiri diambil otomatis dari masing-masing
// command, jadi kalau deskripsi command berubah, /commands ikut update
// tanpa perlu diedit manual di sini.
const CATEGORIES = [
  { label: 'Musik', commandNames: ['play', 'skip', 'stop', 'queue', 'autoplay', 'playlist'] },
  { label: 'Voice Activity', commandNames: ['voicestats', 'voiceleaderboard'] },
  { label: 'Sticky Message', commandNames: ['Jadikan Sticky', 'unsticky'] },
  { label: 'Giveaway', commandNames: ['giveaway'] },
  { label: 'AI', commandNames: ['ask'] },
  { label: 'Lainnya', commandNames: ['commands'] },
];

// Tipe option ACS Discord: 1 = subcommand, 2 = subcommand group
const OPTION_TYPE_SUBCOMMAND = 1;

/**
 * Bikin baris teks buat 1 command di /commands. Kalau command itu punya
 * subcommand (kayak /playlist atau /giveaway), tiap subcommand dijabarin
 * baris sendiri-sendiri lengkap sama deskripsinya, bukan cuma 1 baris induk.
 */
function formatCommandLines(name, json) {
  if (json.type === 3) {
    // Context-menu command (tipe 3), nggak punya deskripsi bawaan
    return [`**${name}** — klik kanan pesan → Apps → ${name}`];
  }

  const subcommands = (json.options || []).filter((opt) => opt.type === OPTION_TYPE_SUBCOMMAND);
  if (subcommands.length > 0) {
    return subcommands.map((sub) => `**/${name} ${sub.name}** — ${sub.description}`);
  }

  return [`**/${name}** — ${json.description}`];
}

const commands = [
  {
    data: new SlashCommandBuilder().setName('commands').setDescription('Lihat semua command yang tersedia di bot ini'),
    async execute(interaction, log, allCommands) {
      const embed = new EmbedBuilder().setColor(EMBED_COLOR).setTitle('Daftar Command');

      for (const category of CATEGORIES) {
        const lines = [];
        for (const name of category.commandNames) {
          const cmd = allCommands.find((c) => c.data.name === name);
          if (!cmd) continue;

          const json = cmd.data.toJSON();
          lines.push(...formatCommandLines(name, json));
        }
        if (lines.length > 0) {
          embed.addFields({ name: category.label, value: lines.join('\n') });
        }
      }

      await interaction.reply({ embeds: [embed], ephemeral: true });
    },
  },
];

module.exports = commands;
