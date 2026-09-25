const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
} = require('discord.js');

const PANEL_COLOR = 0x3b82f6; // biru, senada sama warna ID Card & tema Satpam Voice

/**
 * Panel utama: embed "premium" tapi SENGAJA nggak pakai field inline sama
 * sekali -- Discord di HP selalu nge-stack field `inline` jadi satu kolom
 * penuh (beda dari desktop yang bisa 2-3 kolom sejajar), jadi trik "grid"
 * pakai field malah bikin jarak/baris kosong aneh di HP. Solusinya: semua
 * konten taro di description biasa (cuma teks yang wrap), yang render-nya
 * PERSIS SAMA di HP maupun laptop -- itu yang bikin tampilannya konsisten
 * bagus di kedua platform.
 *
 * Tiap baris fitur sengaja dibikin PENDEK (di bawah ~30 karakter kata-kata
 * sesudah emoji) biar nggak ke-wrap ke baris ke-2 di layar HP yang sempit --
 * makanya deskripsinya singkat banget per fitur, bukan kalimat lengkap.
 * Ini yang bikin panelnya keliatan ringkas/modern padahal isinya sama
 * lengkapnya, dibanding versi lama yang tiap baris wrap jadi 2x lebih
 * panjang dari yang seharusnya.
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
        'Semua fitur dalam satu panel ✨',
        '🎵 **Musik** — Play • Skip • Stop',
        '🎁 **Giveaway** — Buat & pantau',
        '🔥 **Streak** — Grup chat harian',
        '📊 **Voice Stats** — Aktivitas kamu',
        '🤖 **Tanya AI** — Ngobrol sama AI',
        'ℹ️ **Info/Help** — Semua command',
        '🪪 **ID Card** — Kartu identitas',
        '📱 **TikTok** — Request lagu live',
      ].join('\n')
    )
    .setThumbnail(botAvatarURL || null)
    .setFooter({ text: 'Satpam Voice', iconURL: botAvatarURL || undefined })
    .setTimestamp();

  // Discord bakal WRAP tombol dalam 1 row ke baris baru kalau total lebar
  // labelnya kepanjangan buat layar (kejadian di row isi 4 tombol -- tombol
  // ke-4 "Voice Stats" jadi kepental sendirian ke baris berikutnya). Biar
  // rapi & konsisten di semua ukuran layar, tiap row dibatasin maks 3
  // tombol aja (bukan 5), dan Credit sengaja berdiri sendiri di row
  // terakhir (bukan numpang di row lain) biar bukan wrap yang nggak
  // disengaja.
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('panel_music').setLabel('Musik').setEmoji('🎵').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('panel_giveaway').setLabel('Giveaway').setEmoji('🎁').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('panel_streak').setLabel('Streak').setEmoji('🔥').setStyle(ButtonStyle.Danger)
  );
  // Warna tombol disesuaikan sama TEMA masing-masing fitur (bukan
  // disamain semua), sama kayak Streak=merah (fire) & Musik=biru:
  // Voice Stats abu-abu netral (statistik/data, sama kayak Info/Help),
  // ID Card biru (nyocokin sama warna aksen di gambar ID Card-nya sendiri).
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('panel_ask').setLabel('Tanya AI').setEmoji('🤖').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('panel_idcard').setLabel('ID Card').setEmoji('🪪').setStyle(ButtonStyle.Primary),
    // Tombol info/status doang (bukan ngubah state apa-apa), jadi abu-abu netral.
    new ButtonBuilder().setCustomId('panel_tiktok').setLabel('TikTok').setEmoji('📱').setStyle(ButtonStyle.Secondary)
  );
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('panel_voicestats').setLabel('Voice Stats').setEmoji('📊').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('panel_help').setLabel('Info/Help').setEmoji('ℹ️').setStyle(ButtonStyle.Secondary),
    // Tombol Link (bukan customId) -- diklik langsung buka profil Discord
    // pembuat bot, nggak lewat interactionCreate sama sekali.
    new ButtonBuilder().setLabel('CC').setEmoji('👤').setStyle(ButtonStyle.Link).setURL('https://discord.com/users/1141222257604182020')
  );

  return { embed, components: [row1, row2, row3] };
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

/**
 * Baris tombol pilihan buat fitur Streak, dipakai di balasan ephemeral pas
 * tombol "Streak" di panel utama diklik. "Leaderboard" nampilin ranking
 * semua grup streak di server ini (dikirim publik ke channel).
 */
function buildStreakSubRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('panelstreak_info').setLabel('Info Streak').setEmoji('🔥').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('panelstreak_create').setLabel('Buat Grup').setEmoji('➕').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('panelstreak_mygroup').setLabel('Grup Saya').setEmoji('👥').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('panelstreak_leaderboard').setLabel('Leaderboard').setEmoji('🏆').setStyle(ButtonStyle.Secondary)
  );
}

/**
 * Baris 2 tombol pilihan buat fitur ID Card, dipakai di balasan ephemeral
 * pas tombol "ID Card" di panel utama diklik.
 */
function buildIdCardSubRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('panelid_create').setLabel('Buat ID').setEmoji('🆕').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('panelid_view').setLabel('Lihat ID Saya').setEmoji('🪪').setStyle(ButtonStyle.Secondary)
  );
}

/**
 * Baris tombol buat fitur TikTok LIVE, dipakai di balasan ephemeral pas
 * tombol "TikTok" di panel utama diklik. "Matikan" cuma aktif/kelihatan
 * berguna kalau fiturnya lagi nyala (disabled kalau belum ada yang di-set).
 */
function buildTiktokSubRow(status) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('panel_tiktok_setusername')
      .setLabel(status?.enabled ? 'Ganti Username' : 'Set Username')
      .setEmoji('📱')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('panel_tiktok_disable')
      .setLabel('Matikan')
      .setEmoji('⛔')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!status?.enabled)
  );
}

module.exports = {
  buildPanelCard,
  buildMusicSubRow,
  buildVoiceStatsSelectRow,
  buildStreakSubRow,
  buildIdCardSubRow,
  buildTiktokSubRow,
  PANEL_COLOR,
};
