const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

const PANEL_COLOR = 0x5865f2;

/**
 * Panel utama: embed keterangan + 4 tombol kategori (Musik, Giveaway,
 * Voice Stats, Info/Help). Tombol-tombol ini SELALU membalas ephemeral
 * (cuma keliatan yang klik), jadi panel publik yang sticky ini nggak perlu
 * berubah tampilan tiap kali ada yang pencet tombol -- aman buat banyak
 * orang mencet bersamaan tanpa saling ganggu.
 */
function buildPanelCard() {
  const embed = new EmbedBuilder()
    .setColor(PANEL_COLOR)
    .setAuthor({ name: '🛡️ Satpam Voice — Panel' })
    .setDescription(
      [
        'Akses cepat fitur-fitur bot lewat tombol di bawah ini:',
        '',
        '🎵 **Musik** — Play, Skip, Stop, Queue',
        '🎁 **Giveaway** — Buat giveaway atau lihat yang aktif',
        '📊 **Voice Stats** — Statistik & leaderboard aktivitas voice',
        'ℹ️ **Info/Help** — Daftar semua command bot',
      ].join('\n')
    )
    .setFooter({ text: 'Klik salah satu tombol di bawah untuk mulai (balasan cuma keliatan buat kamu)' });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('panel_music').setLabel('Musik').setEmoji('🎵').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('panel_giveaway').setLabel('Giveaway').setEmoji('🎁').setStyle(ButtonStyle.Secondary),
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

module.exports = { buildPanelCard, buildMusicSubRow };
