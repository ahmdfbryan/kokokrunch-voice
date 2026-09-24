const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
} = require('discord.js');

const PANEL_COLOR = 0x2b2d31;
// Zero-width-space field dipakai sebagai "penyeimbang" biar 4 field inline
// kebagi rapi 2 baris x 2 kolom (bukan numpuk 3+1 kayak default Discord).
const SPACER_FIELD = { name: '​', value: '​', inline: true };

/**
 * Panel utama: embed "premium" bergaya dashboard -- title + tagline singkat,
 * lalu 4 fitur ditata sebagai grid 2x2 (tiap fitur = 1 field, biar rapi &
 * gampang dipindai), thumbnail & footer branded pakai avatar bot. Diikuti
 * 4 tombol kategori (Musik, Giveaway, Voice Stats, Info/Help). Tombol-tombol
 * ini SELALU membalas ephemeral (cuma keliatan yang klik), jadi panel
 * publik yang sticky ini nggak perlu berubah tampilan tiap kali ada yang
 * pencet tombol -- aman buat banyak orang mencet bersamaan tanpa saling
 * ganggu.
 *
 * `botAvatarURL` opsional -- dipakai buat author icon, thumbnail & footer
 * icon biar kelihatan lebih "branded", tapi tetap aman kalau nggak disuplai.
 */
function buildPanelCard(botAvatarURL) {
  const embed = new EmbedBuilder()
    .setColor(PANEL_COLOR)
    .setAuthor({ name: 'SATPAM VOICE', iconURL: botAvatarURL || undefined })
    .setTitle('🛡️ Control Panel')
    .setDescription('_Akses semua fitur bot cukup dari satu tempat ini._')
    .addFields(
      { name: '🎵  Musik', value: 'Play • Skip • Stop • Queue', inline: true },
      { name: '🎁  Giveaway', value: 'Buat & pantau giveaway', inline: true },
      SPACER_FIELD,
      { name: '📊  Voice Stats', value: 'Statistik & leaderboard', inline: true },
      { name: 'ℹ️  Info / Help', value: 'Daftar semua command', inline: true },
      SPACER_FIELD
    )
    .setThumbnail(botAvatarURL || null)
    .setFooter({ text: 'KokoKrunch Studios • Satpam Voice Panel', iconURL: botAvatarURL || undefined })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('panel_music').setLabel('Musik').setEmoji('🎵').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('panel_giveaway').setLabel('Giveaway').setEmoji('🎁').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('panel_voicestats').setLabel('Voice Stats').setEmoji('📊').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('panel_help').setLabel('Info/Help').setEmoji('ℹ️').setStyle(ButtonStyle.Secondary)
  );

  return { embed, components: [row] };
}

/**
 * Baris tombol kontrol musik cepat, dipakai di balasan ephemeral pas
 * tombol "Musik" di panel utama diklik.
 */
function buildMusicSubRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('panelmusic_play').setLabel('Play').setEmoji('▶️').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('panelmusic_skip').setLabel('Skip').setEmoji('⏭️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('panelmusic_stop').setLabel('Stop').setEmoji('⏹️').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('panelmusic_queue').setLabel('Queue').setEmoji('📜').setStyle(ButtonStyle.Secondary)
  );
}

/**
 * Dropdown pilihan Voice Stats / Leaderboard. Dipakai di balasan ephemeral
 * pas tombol "Voice Stats" di panel utama diklik -- hasil yang dipilih
 * ditampilkan PUBLIK ke channel (bukan cuma buat yang milih), lihat
 * handler-nya di index.js.
 */
function buildVoiceStatsSelectRow() {
  const menu = new StringSelectMenuBuilder()
    .setCustomId('panel_voicestats_select')
    .setPlaceholder('Mau tampilkan apa ke channel?')
    .addOptions(
      { label: 'Voice Stats Saya', description: 'Statistik aktivitas voice kamu sendiri', value: 'stats', emoji: '📊' },
      { label: 'Leaderboard', description: 'Ranking voice activity server ini', value: 'leaderboard', emoji: '🏆' }
    );
  return new ActionRowBuilder().addComponents(menu);
}

module.exports = { buildPanelCard, buildMusicSubRow, buildVoiceStatsSelectRow, PANEL_COLOR };
