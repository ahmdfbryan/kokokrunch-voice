const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
} = require('discord.js');

const PANEL_COLOR = 0x3b82f6; // biru, senada sama warna ID Card & tema Satpam Voice

/**
 * Format durasi uptime bot jadi teks singkat, misal "2 hari 5 jam 12 menit"
 * atau "45 menit". Sengaja versi lokal sendiri (bukan pinjam dari
 * voiceActivity.js) biar panelCard.js nggak nambah dependency baru cuma
 * buat 1 fungsi kecil ini.
 */
function formatUptime(ms) {
  const totalSeconds = Math.max(0, Math.floor((ms || 0) / 1000));
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

/**
 * Tombol "Home" -- dipakai di HAMPIR SEMUA layar panel biar user selalu
 * bisa balik ke Panel Utama dari mana aja, dalam 1 embed/pesan yang sama
 * (lihat index.js: respondPanelScreen, yang selalu interaction.update()
 * pesan panel yang sama, nggak pernah bikin balasan baru). Tetap bisa
 * diklik walau lagi di layar Home sendiri -- klik di situ cuma nge-refresh
 * Home (nggak pindah kemana-mana), jadi kerasa "gak ada aksi apa-apa".
 * Warna hijau (Success) jadi ciri khas tombol Home di semua layar.
 */
function buildHomeButton() {
  return new ButtonBuilder().setCustomId('panel_home').setLabel('Home').setEmoji('🏠').setStyle(ButtonStyle.Success);
}

/** Row isi 1 tombol Home doang -- dipakai di layar-layar yang cuma butuh itu (Bantuan, Voice Stats, dll). */
function buildHomeOnlyRow() {
  return new ActionRowBuilder().addComponents(buildHomeButton());
}

/**
 * Layar PANEL UTAMA (Home): embed "premium" tapi SENGAJA nggak pakai field
 * inline sama sekali -- Discord di HP selalu nge-stack field `inline` jadi
 * satu kolom penuh (beda dari desktop yang bisa 2-3 kolom sejajar), jadi
 * trik "grid" pakai field malah bikin jarak/baris kosong aneh di HP.
 * Solusinya: semua konten taro di description biasa (cuma teks yang wrap),
 * yang render-nya PERSIS SAMA di HP maupun laptop.
 *
 * Bagian Stats (Commands, Uptime, Ping, Status, Made by) dirender pakai
 * blockquote (`> `) biar keliatan kayak "kartu info" terpisah dari
 * deskripsi bot di atasnya. Judul section-nya sendiri sengaja polos tanpa
 * icon -- icon-nya dipindah ke depan tiap baris stat-nya masing-masing.
 *
 * `client` dipakai buat ambil avatar bot, uptime (client.uptime) & ping
 * (client.ws.ping). `commandCount` jumlah total command yang kedaftar.
 */
function buildHomeEmbed(client, commandCount) {
  const botAvatarURL = client?.user?.displayAvatarURL?.({ size: 256 }) || null;
  const pingMs = Math.max(0, Math.round(client?.ws?.ping || 0));
  const uptimeText = formatUptime(client?.uptime);

  return new EmbedBuilder()
    .setColor(PANEL_COLOR)
    // Author (bukan Title) -- ini satu-satunya field embed yang bisa
    // nampilin logo/icon bot di samping teksnya. Discord nggak nge-render
    // markdown ** di author.name, jadi teksnya nggak bold beneran, tapi
    // fontnya sendiri udah lumayan tegas/semi-bold secara default.
    .setAuthor({ name: 'SATPAM VOICE', iconURL: botAvatarURL || undefined })
    .setDescription(
      [
        '**Mau menggunakan fitur Satpam Voice? Semua kontrolnya sudah tersedia di panel ini.**',
        '',
        '**Stats**',
        `> **📜 \`${commandCount ?? 0}\` Commands**`,
        `> **⏱️ \`${uptimeText}\` Uptime**`,
        `> **📶 \`${pingMs}ms\` Ping**`,
        '> **🟢 `Online` Status**',
        '> **Made by `Satpam Voice`**',
      ].join('\n')
    )
    .setThumbnail(botAvatarURL || null)
    .setFooter({ text: 'Satpam Voice', iconURL: botAvatarURL || undefined })
    .setTimestamp();
}

/**
 * Tombol-tombol di layar Home: Home, Musik, Featured (buka daftar fitur),
 * Bantuan (akses cepat), dan CC (link, bukan bagian dari sistem navigasi
 * 1-embed).
 */
function buildHomeButtons() {
  const row = new ActionRowBuilder().addComponents(
    buildHomeButton(),
    new ButtonBuilder().setCustomId('panel_music').setLabel('Musik').setEmoji('🎵').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('panel_featured').setLabel('Featured').setEmoji('✨').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('panel_help').setLabel('Bantuan').setEmoji('ℹ️').setStyle(ButtonStyle.Secondary),
    // Tombol Link (bukan customId) -- diklik langsung buka profil Discord
    // pembuat bot, nggak lewat interactionCreate sama sekali.
    new ButtonBuilder().setLabel('CC').setEmoji('👤').setStyle(ButtonStyle.Link).setURL('https://discord.com/users/1141222257604182020')
  );
  return [row];
}

/**
 * Entry point lama yang masih dipakai buat ngirim/reposisi panel sticky
 * (lihat index.js `repositionChannelStack`) -- sekarang isinya SELALU
 * state Home (Panel Utama), karena mulai dari sini semua navigasi ke
 * fitur lain terjadi di 1 pesan ephemeral yang sama (lihat panel_home /
 * panel_featured / respondPanelScreen di index.js), bukan lewat panel
 * publik yang sticky ini.
 */
function buildPanelCard(client, commandCount) {
  return { embed: buildHomeEmbed(client, commandCount), components: buildHomeButtons() };
}

/** Layar "Featured": daftar semua fitur bot + tombol Home buat balik. */
function buildFeaturedEmbed() {
  return new EmbedBuilder()
    .setColor(PANEL_COLOR)
    .setAuthor({ name: '✨  Fitur Bot' })
    .setDescription('Pilih fitur yang mau kamu pakai di bawah ini.');
}

function buildFeaturedButtons() {
  // Semua tombol fitur di sini SENGAJA dibikin netral (Secondary/abu-abu,
  // nggak ada warna beda-beda per fitur) -- biar Home (hijau) jadi satu-
  // satunya tombol yang "menonjol" warnanya di layar ini.
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('panel_giveaway').setLabel('Giveaway').setEmoji('🎁').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('panel_streak').setLabel('Streak').setEmoji('🔥').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('panel_ask').setLabel('Tanya AI').setEmoji('🤖').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('panel_idcard').setLabel('ID Card').setEmoji('🪪').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('panel_tiktok').setLabel('TikTok').setEmoji('📱').setStyle(ButtonStyle.Secondary)
  );
  // Voice Stats gabung bareng Home di baris ke-2 (dipisah row sendiri kurang
  // enak dipandang, jadi disatuin lagi).
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('panel_voicestats').setLabel('Voice Stats').setEmoji('📊').setStyle(ButtonStyle.Secondary),
    buildHomeButton()
  );
  return [row1, row2];
}

/**
 * Baris tombol kontrol musik cepat, dipakai di balasan ephemeral pas
 * tombol "Musik" di panel utama diklik. 6 tombol dibagi rata 3-3: baris 1
 * Play/Skip/Stop, baris 2 Queue/Playlist/Home.
 */
function buildMusicSubRow() {
  // Sama kayak layar Featured -- tombol aksinya dibikin netral (Secondary)
  // semua, Home (hijau) yang jadi penanda warna satu-satunya.
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('panelmusic_play').setLabel('Play').setEmoji('▶️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('panelmusic_skip').setLabel('Skip').setEmoji('⏭️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('panelmusic_stop').setLabel('Stop').setEmoji('⏹️').setStyle(ButtonStyle.Secondary)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('panelmusic_queue').setLabel('Queue').setEmoji('📜').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('panelmusic_playlist').setLabel('Playlist').setEmoji('📁').setStyle(ButtonStyle.Secondary),
    buildHomeButton()
  );
  return [row1, row2];
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
    new ButtonBuilder().setCustomId('panelstreak_leaderboard').setLabel('Leaderboard').setEmoji('🏆').setStyle(ButtonStyle.Secondary),
    buildHomeButton()
  );
}

/**
 * Baris 3 tombol pilihan buat fitur ID Card, dipakai di balasan ephemeral
 * pas tombol "ID Card" di panel utama diklik.
 */
function buildIdCardSubRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('panelid_create').setLabel('Buat ID').setEmoji('🆕').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('panelid_view').setLabel('Lihat ID Saya').setEmoji('🪪').setStyle(ButtonStyle.Secondary),
    buildHomeButton()
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
      .setDisabled(!status?.enabled),
    buildHomeButton()
  );
}

/**
 * Baris tombol pilihan buat fitur Giveaway, dipakai di balasan ephemeral
 * pas tombol "Giveaway" di panel utama diklik. "Buat Giveaway" cuma
 * dimunculin kalau clicker punya izin Manage Server.
 */
function buildGiveawaySubRow(canManage) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('panelgw_list').setLabel('Lihat Aktif').setEmoji('📋').setStyle(ButtonStyle.Secondary),
    ...(canManage
      ? [new ButtonBuilder().setCustomId('panelgw_create').setLabel('Buat Giveaway').setEmoji('🎁').setStyle(ButtonStyle.Success)]
      : []),
    buildHomeButton()
  );
}

/**
 * Baris tombol buat fitur Tanya AI. Modal Discord nggak bisa nampilin
 * tombol Home di dalamnya, jadi alurnya 2 langkah: tombol "Tanya AI" di
 * panel dulu nampilin layar mini-menu ini (dengan tombol Home kelihatan),
 * baru klik "Buka Form" yang munculin Modal-nya.
 */
function buildAskRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('panel_ask_open').setLabel('Buka Form').setEmoji('📝').setStyle(ButtonStyle.Primary),
    buildHomeButton()
  );
}

module.exports = {
  buildPanelCard,
  buildHomeEmbed,
  buildHomeButtons,
  buildHomeButton,
  buildHomeOnlyRow,
  buildFeaturedEmbed,
  buildFeaturedButtons,
  buildMusicSubRow,
  buildVoiceStatsSelectRow,
  buildStreakSubRow,
  buildIdCardSubRow,
  buildTiktokSubRow,
  buildGiveawaySubRow,
  buildAskRow,
  PANEL_COLOR,
};
