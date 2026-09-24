const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
} = require('discord.js');

const PANEL_COLOR = 0x2b2d31;

/**
 * Panel utama: embed "premium" tapi SENGAJA nggak pakai field inline sama
 * sekali -- Discord di HP selalu nge-stack field `inline` jadi satu kolom
 * penuh (beda dari desktop yang bisa 2-3 kolom sejajar), jadi trik "grid"
 * pakai field malah bikin jarak/baris kosong aneh di HP. Solusinya: semua
 * konten taro di description biasa (cuma teks yang wrap), yang render-nya
 * PERSIS SAMA di HP maupun laptop -- itu yang bikin tampilannya konsisten
 * bagus di kedua platform.
 *
 * `botAvatarURL` opsional -- dipakai buat author icon, thumbnail & footer
 * icon biar kelihatan lebih "branded", tapi tetap aman kalau nggak disuplai.
 */
function buildPanelCard(botAvatarURL) {
  const embed = new EmbedBuilder()
    .setColor(PANEL_COLOR)
    .setAuthor({ name: 'SATPAM PANEL', iconURL: botAvatarURL || undefined })
    .setDescription(
      [
        '_Akses semua fitur bot cukup dari satu tempat ini._',
        '',
        '🎵 **Musik** — Play • Skip • Stop • Queue',
        '🎁 **Giveaway** — Buat & pantau giveaway',
        '📊 **Voice Stats** — Statistik & leaderboard',
        'ℹ️ **Info / Help** — Daftar semua command',
      ].join('\n')
    )
    .setThumbnail(botAvatarURL || null)
    .setFooter({ text: 'KokoKrunch Studios', iconURL: botAvatarURL || undefined })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('panel_music').setLabel('Musik').setEmoji('🎵').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('panel_giveaway').setLabel('Giveaway').setEmoji('🎁').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('panel_voicestats').setLabel('Voice Stats').setEmoji('📊').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('panel_help').setLabel('Info/Help').setEmoji('ℹ️').setStyle(ButtonStyle.Secondary),
    // Tombol Link (bukan customId) -- diklik langsung buka profil Discord
    // pembuat bot, nggak lewat interactionCreate sama sekali.
    new ButtonBuilder().setLabel('Credit').setEmoji('👤').setStyle(ButtonStyle.Link).setURL('https://discord.com/users/1141222257604182020')
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
