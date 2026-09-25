const dns = require('dns');
// Fix umum untuk error "operation was aborted" saat connect voice di VPS:
// Node 18+ default prefer IPv6 (Happy Eyeballs), tapi banyak VPS punya routing
// IPv6 yang rusak untuk UDP voice server Discord walau HTTPS/WSS biasa tetap normal.
// Paksa resolusi DNS IPv4 dulu supaya voice connection nggak nyangkut di IPv6 yang mati.
dns.setDefaultResultOrder('ipv4first');

const {
  Client,
  GatewayIntentBits,
  ActivityType,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
  AttachmentBuilder,
} = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
} = require('@discordjs/voice');

const config = require('./config');
const musicManager = require('./musicManager');
const musicPlaylistStore = require('./musicPlaylistStore');
const lyricsManager = require('./lyricsManager');
const { buildNowPlayingCard, cycleLoopMode, withNowPlayingLock } = require('./nowPlayingCard');
const voiceActivity = require('./voiceActivity');
const welcomeManager = require('./welcomeManager');
const botBranding = require('./botBranding');
const tiktokLive = require('./tiktokLive');
const { handleTikTokRequest } = require('./tiktokRequestManager');
const stickyMessage = require('./stickyMessage');
const stickyManager = require('./stickyManager');
const { handlePrefixCommand } = require('./prefixCommands');
const giveawayManager = require('./giveawayManager');
const aiChat = require('./aiChat');
const aiTools = require('./aiTools');
const aiCommands = require('./aiCommands');
const permissions = require('./permissions');
const voteManager = require('./voteManager');
const commands = require('./commands');
const panelStore = require('./panelStore');
const {
  buildPanelCard,
  buildMusicSubRow,
  buildVoiceStatsSelectRow,
  buildStreakSubRow,
  buildIdCardSubRow,
  PANEL_COLOR,
} = require('./panelCard');
const streakStore = require('./streakStore');
const streakManager = require('./streakManager');
const idCardStore = require('./idCardStore');
const idCardManager = require('./idCardManager');
const { renderIdCardImage } = require('./idCardImage');
const { COLOR, textEmbed } = require('./musicFormat');
const { buildCommandsListEmbed } = require('./commandsList');
const { buildLeaderboardEmbed } = require('./voiceActivityCommands');

const EMBED_COLOR = 0x5865f2;
// Catatan: URL ini dikoreksi dari input asli yang ada teks "hyphenhyphen"
// di tengahnya (kemungkinan artefak text-processing yang nulis ulang "--"
// jadi kata), diganti balik jadi "--". Kalau gambar nggak muncul, cek ulang
// URL aslinya dari Blogger.
const QUEUE_FINISHED_IMAGE_URL =
  'https://blogger.googleusercontent.com/img/b/R29vZ2xl/AVvXsEieKReLQzN9jM64iFPWGbSLGlfCTaUyiHs_4auI98QmIUi8qFugjbXAw5sDu-t4FtJAH3L6v1IjRX2Y0doddGenaZxHZh9Q_MRek9aYaURbf2XwVz6agkyzIcM20P4JLu2NkqCHPvDP0md7cndFY2R--0MENXfWl2JVjPaG4yZCvX1JqK5d9hcaDhXAoZ8/s1627/ChatGPT%20Image%2027%20Agu%202026,%2019.56.40.png';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

let connection = null;
let player = null;
let reconnecting = false;
let shuttingDown = false;
let consecutiveFailures = 0;
let connectedAt = null; // timestamp (ms) pas terakhir kali berhasil Ready -- dipakai buat nentuin backoff
let currentGuildId = null;

// Callback dipanggil musicManager pas track baru mulai diputar --
// update status "Now Playing" bot + kirim notifikasi ke channel tempat /play dipanggil.
// opts.silent: true -> skip kirim pesan channel (reply command /play sendiri
// sudah kasih tau), tapi status bot (Activity) tetap di-update seperti biasa.
// Kunci `withNowPlayingLock` (di-import dari nowPlayingCard.js, dipakai
// bareng-bareng sama commands.js dkk) masukin SEMUA operasi yang nyentuh
// "pesan Now Playing yang lagi ke-track" ke antrian, satu-satu per guild --
// baik yang dari proses background di sini (ganti lagu, refresh, reposisi)
// maupun dari command (/play, /playlist play, /nowplaying) -- biar nggak
// pernah ada 2 proses beda balapan bikin/nge-edit card yang sama.

async function onTrackStart(guildId, track, opts = {}) {
  try {
    client.user.setActivity(track.title, { type: ActivityType.Listening });
  } catch (err) {
    log(`[STATUS] Gagal update activity: ${err.message}`);
  }

  if (opts.silent) return; // /play sendiri yang urus card-nya (lihat commands.js)

  const queue = musicManager.getQueue(guildId);
  if (!queue.textChannelId) return;

  await withNowPlayingLock(guildId, async () => {
    // Card "Now Playing" dibikin TETAP di posisi/pesan yang sama selama musik
    // masih nyambung terus (edit di tempat pas ganti lagu) -- bukan dihapus &
    // dikirim ulang tiap ganti lagu. Cuma bikin pesan baru kalau memang belum
    // ada yang di-track, atau pesan lamanya udah nggak ketemu (kehapus manual dll).
    const oldMsg = musicManager.getNowPlayingMessage(guildId);
    if (oldMsg) {
      try {
        const oldChannel = await client.channels.fetch(oldMsg.channelId);
        const oldMessage = await oldChannel.messages.fetch(oldMsg.messageId);
        const { embed, components } = buildNowPlayingCard(guildId);
        await oldMessage.edit({ embeds: [embed], components });
        return;
      } catch {
        // Pesan lama nggak ketemu -> lanjut ke bawah, bikin pesan baru
      }
    }

    try {
      const channel = await client.channels.fetch(queue.textChannelId);
      const { embed, components } = buildNowPlayingCard(guildId);
      const sentMessage = await channel.send({ embeds: [embed], components });
      musicManager.setNowPlayingMessage(guildId, channel.id, sentMessage.id);
    } catch (err) {
      log(`[STATUS] Gagal kirim card Now Playing ke channel: ${err.message}`);
    }
  });
}

// Callback pas antrian abis -- reset status bot balik netral + kasih tau di
// channel (kecuali dipicu dari /stop, karena reply /stop sendiri udah cukup).
async function onQueueEmpty(guildId, opts = {}) {
  try {
    client.user.setActivity('Standby di voice channel', { type: ActivityType.Custom });
  } catch (err) {
    log(`[STATUS] Gagal reset activity: ${err.message}`);
  }

  await refreshNowPlayingCard(guildId);

  if (opts.silent) return;

  const queue = musicManager.getQueue(guildId);
  if (!queue.textChannelId) return;

  try {
    const channel = await client.channels.fetch(queue.textChannelId);
    const embed = new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setAuthor({ name: '🎵 Satpam Voice' })
      .setDescription('Thank you for using our service **Satpam Voice**!')
      .setImage(QUEUE_FINISHED_IMAGE_URL)
      .setFooter({ text: 'Your suggestions and opinions are always considered! • Crafted by ahmdfbryan' })
      .setTimestamp();
    await channel.send({ embeds: [embed] });
  } catch (err) {
    log(`[STATUS] Gagal kirim notifikasi antrian selesai: ${err.message}`);
  }
}

/**
 * Refresh (edit) card "Now Playing" yang lagi kebuka (kalau ada), biar
 * progress bar / status tombolnya update. Dipanggil pas track ganti, pas
 * antrian abis, DAN secara berkala lewat interval (lihat startNowPlayingRefreshLoop).
 * Kalau pesannya udah kehapus / channel nggak ketemu, referensinya dibersihin
 * biar nggak terus-terusan dicoba di refresh berikutnya.
 */
async function refreshNowPlayingCard(guildId) {
  await withNowPlayingLock(guildId, async () => {
    const npMsg = musicManager.getNowPlayingMessage(guildId);
    if (!npMsg) return;

    try {
      const channel = await client.channels.fetch(npMsg.channelId);
      const message = await channel.messages.fetch(npMsg.messageId);
      const { embed, components } = buildNowPlayingCard(guildId);
      await message.edit({ embeds: [embed], components });

      // Kalau udah nggak ada musik yang main, berarti card ini "final" --
      // nggak perlu di-refresh berkala lagi sampai ada /nowplaying baru.
      if (!musicManager.getQueue(guildId).current) {
        musicManager.setNowPlayingMessage(guildId, null, null);
      }
    } catch (err) {
      log(`[NOWPLAYING] Gagal refresh card, berhenti nge-track pesan ini: ${err.message}`);
      musicManager.setNowPlayingMessage(guildId, null, null);
    }
  });
}

// Card "Now Playing" DAN panel bot dibuat "nempel" ke bawah chat kayak
// sticky message: kalau ada chat baru numpuk di atasnya, dipindah (hapus +
// kirim ulang) ke posisi paling bawah lagi. Pakai debounce biar nggak spam
// delete+send tiap 1 pesan kalau chat lagi rame.
//
// Kalau di channel yang sama ada PANEL aktif DAN card Now Playing lagi
// nge-track di channel itu juga, keduanya direposisi BARENGAN dalam satu
// operasi (repositionChannelStack): panel dikirim ulang duluan, baru card
// Now Playing nyusul dikirim SETELAHNYA -- supaya urutannya di chat selalu
// panel di atas, musik selalu paling bawah, sesuai yang diminta.
const STACK_REPOSITION_DEBOUNCE_MS = 3000;
const STACK_REPOSITION_MAX_WAIT_MS = 15_000;
const stackRepositionTimers = new Map(); // channelId -> { debounceTimeout, maxTimeout }
// Selama channelId ada di sini, SEMUA messageCreate diabaikan buat channel itu --
// ini nyegah pesan hasil kirim-ulang kita sendiri kedetect balik sebagai
// "chat baru" (yang kalau dibiarin bikin loop kedip-kedip terus-terusan).
const stackRepositioningInFlight = new Set();

function scheduleStackReposition(guildId, channelId) {
  let entry = stackRepositionTimers.get(channelId);
  if (!entry) {
    entry = { debounceTimeout: null, maxTimeout: null };
    stackRepositionTimers.set(channelId, entry);
    entry.maxTimeout = setTimeout(() => runStackReposition(guildId, channelId), STACK_REPOSITION_MAX_WAIT_MS);
  }

  if (entry.debounceTimeout) clearTimeout(entry.debounceTimeout);
  entry.debounceTimeout = setTimeout(() => runStackReposition(guildId, channelId), STACK_REPOSITION_DEBOUNCE_MS);
}

async function runStackReposition(guildId, channelId) {
  const entry = stackRepositionTimers.get(channelId);
  if (entry) {
    clearTimeout(entry.debounceTimeout);
    clearTimeout(entry.maxTimeout);
    stackRepositionTimers.delete(channelId);
  }

  stackRepositioningInFlight.add(channelId);
  try {
    await repositionChannelStack(guildId, channelId);
  } finally {
    // Jeda dikit sebelum ngelepas flag -- ngasih waktu event messageCreate
    // buat pesan yang baru aja dikirim (yang bisa nyampe agak telat lewat
    // gateway) biar tetep ke-filter dengan benar, nggak trigger diri sendiri.
    setTimeout(() => stackRepositioningInFlight.delete(channelId), 2000);
  }
}

/**
 * Reposisi panel (kalau aktif di channel ini) DAN card Now Playing (kalau
 * lagi nge-track di channel ini juga) supaya keduanya balik ke paling bawah
 * chat, dengan urutan: panel di atas, Now Playing di bawah (paling akhir).
 * Semua di dalam withNowPlayingLock supaya nggak balapan sama operasi lain
 * yang nyentuh card Now Playing (ganti lagu, refresh berkala, dst).
 */
async function repositionChannelStack(guildId, channelId) {
  await withNowPlayingLock(guildId, async () => {
    // Dicek ULANG di dalam lock (bukan cuma sebelum antri) -- soalnya
    // referensi pesan atau status musik/panel bisa aja udah berubah selagi
    // operasi lain di depan kita dalam antrian masih diproses.
    const panel = panelStore.getPanel(channelId);
    const npMsg = musicManager.getNowPlayingMessage(guildId);
    const npTrackedHere = !!(npMsg && npMsg.channelId === channelId);
    const npStillPlaying = npTrackedHere && !!musicManager.getQueue(guildId).current;

    if (!panel && !npTrackedHere) return; // nggak ada apa-apa buat direposisi di channel ini

    let channel;
    try {
      channel = await client.channels.fetch(channelId);
    } catch (err) {
      log(`[PANEL] Gagal fetch channel ${channelId} buat reposisi: ${err.message}`);
      return;
    }

    if (panel && panel.panelMessageId) {
      try {
        const oldPanelMsg = await channel.messages.fetch(panel.panelMessageId);
        await oldPanelMsg.delete();
      } catch {
        // udah kehapus manual / nggak ketemu, aman diabaikan
      }
    }

    if (npTrackedHere) {
      try {
        const oldNpMsg = await channel.messages.fetch(npMsg.messageId);
        await oldNpMsg.delete();
      } catch {
        // udah kehapus manual / nggak ketemu, aman diabaikan
      }
      if (!npStillPlaying) {
        musicManager.setNowPlayingMessage(guildId, null, null); // udah nggak ada musik, berhenti nge-track
      }
    }

    // Panel dikirim DULUAN (biar nempatin posisi lebih atas), baru Now
    // Playing nyusul (biar dia yang paling akhir/paling bawah).
    if (panel) {
      const { embed, components } = buildPanelCard(client.user?.displayAvatarURL?.());
      const sentPanel = await channel.send({ embeds: [embed], components });
      panelStore.setPanelMessageId(channelId, sentPanel.id);
    }

    if (npStillPlaying) {
      const { embed, components } = buildNowPlayingCard(guildId);
      const sentNp = await channel.send({ embeds: [embed], components });
      musicManager.setNowPlayingMessage(guildId, channel.id, sentNp.id);
    }
  });
}

// Kalau bot baru start/restart, member yang udah lebih dulu ada di voice
// channel manapun perlu di-"mulai" sesinya sekarang juga (best-effort --
// kita nggak tau kapan sebenarnya mereka join sebelum bot ini nyala).
function populateExistingVoiceSessions() {
  for (const guild of client.guilds.cache.values()) {
    for (const channel of guild.channels.cache.values()) {
      if (!channel.isVoiceBased()) continue;
      for (const member of channel.members.values()) {
        if (member.user.bot) continue;
        voiceActivity.startSession(member.id, member.user.username);
      }
    }
  }
}

// Kalau bot ini restart (pm2 restart dll) SEMENTARA ada card "Now Playing"
// yang lagi aktif, state di memori bakal ke-reset total -- card lama itu
// jadi "yatim piatu" (nggak ada yang tau lagi harus di-edit yang mana),
// biarin gitu bakal numpuk terus tiap kali restart. Dipanggil sekali pas
// startup, sebelum musik mulai main lagi, buat bersihin card lama itu.
let didCleanupOldNowPlayingCard = false;
async function cleanupOldNowPlayingCard(guildId) {
  if (didCleanupOldNowPlayingCard) return;
  didCleanupOldNowPlayingCard = true;

  const persisted = musicManager.loadPersistedNowPlayingMessages();
  const old = persisted[guildId];
  if (!old) return;

  try {
    const channel = await client.channels.fetch(old.channelId);
    const message = await channel.messages.fetch(old.messageId);
    await message.delete();
    log('[NOWPLAYING] Card lama dari sebelum restart berhasil dibersihkan.');
  } catch {
    // udah kehapus manual / nggak ketemu, aman diabaikan
  }
  musicManager.setNowPlayingMessage(guildId, null, null);
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}
// Biar log internal fitur Lirik (sumber mana yang dicoba, kenapa gagal/
// ditolak) nyampur di pm2 logs yang sama, bukan console.log polos --
// gampang buat nge-debug kalau ada laporan "lirik nggak ketemu"/"salah lagu".
lyricsManager.setLogger(log);
tiktokLive.setLogger(log);

// ============================================================
// PANEL: skip/stop lewat tombol panel -- logikanya sama persis kayak
// /skip & /stop (permission owner/staff/requester dulu, baru fallback ke
// vote), cuma alur balasnya beda: ack duluan ephemeral (deferReply), baru
// pesan publik "X telah di-skip" dikirim terpisah ke channel (bukan reply
// interaksi), soalnya balasan tombol panel sendiri emang didesain ephemeral.
// ============================================================
async function handlePanelSkip(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const queue = musicManager.getQueue(interaction.guildId);
  const currentTrack = queue.current;

  if (permissions.canControlPlayback(interaction.member, currentTrack)) {
    const skipped = musicManager.skip(interaction.guildId);
    if (!skipped) {
      await interaction.editReply({ embeds: [textEmbed('Nggak ada lagu yang lagi diputar.')] });
      return;
    }
    await interaction.editReply({ embeds: [textEmbed('Lagu berhasil di-skip.')] });
    await interaction.channel
      .send({ embeds: [textEmbed(`**${currentTrack.title}** has been skipped by <@${interaction.user.id}>`)] })
      .catch(() => {});
    return;
  }

  if (voteManager.isAuthorityPresent(interaction.guild, currentTrack)) {
    await interaction.editReply({ embeds: [textEmbed('Cuma yang minta lagu ini, owner, atau staff yang bisa skip.')] });
    return;
  }

  await voteManager.handleVoteRequest({
    guild: interaction.guild,
    member: interaction.member,
    channelId: interaction.channelId,
    action: 'skip',
    currentTrack,
    client: interaction.client,
    sendPublic: (payload) => interaction.channel.send(payload),
    replyPrivate: (text) => interaction.editReply({ embeds: [textEmbed(text)] }),
  });
}

async function handlePanelStop(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const queue = musicManager.getQueue(interaction.guildId);
  const currentTrack = queue.current;

  if (permissions.canControlPlayback(interaction.member, currentTrack)) {
    const hadSomething = musicManager.stop(interaction.guildId);
    if (!hadSomething) {
      await interaction.editReply({ embeds: [textEmbed('Nggak ada musik yang lagi diputar atau diantrikan.')] });
      return;
    }
    await interaction.editReply({ embeds: [textEmbed('Musik berhasil dihentikan.')] });
    await interaction.channel.send({ embeds: [textEmbed('Musik dihentikan, antrian dikosongkan.')] }).catch(() => {});
    return;
  }

  if (voteManager.isAuthorityPresent(interaction.guild, currentTrack)) {
    await interaction.editReply({ embeds: [textEmbed('Cuma yang minta lagu ini, owner, atau staff yang bisa stop musik.')] });
    return;
  }

  await voteManager.handleVoteRequest({
    guild: interaction.guild,
    member: interaction.member,
    channelId: interaction.channelId,
    action: 'stop',
    currentTrack,
    client: interaction.client,
    sendPublic: (payload) => interaction.channel.send(payload),
    replyPrivate: (text) => interaction.editReply({ embeds: [textEmbed(text)] }),
  });
}

function buildVoiceStatsEmbed(user) {
  const stats = voiceActivity.getStats(user.id);
  if (!stats) {
    return new EmbedBuilder().setColor(0x99aab5).setDescription(`📭 **${user.username}** belum pernah tercatat aktivitas voice-nya.`);
  }
  const tier = voiceActivity.getTierInfo(stats.totalSeconds);
  const progress = voiceActivity.getProgress(stats.totalSeconds);
  const bar = voiceActivity.renderProgressBar(progress.percent);
  const progressText = progress.isMax
    ? `${bar} 100%\nTier tertinggi tercapai! 🎉`
    : `${bar} ${Math.round(progress.percent * 100)}%\n${progress.hoursRemaining.toFixed(1)} jam lagi menuju ${progress.next.emoji} **${progress.next.title}**`;

  const embed = new EmbedBuilder()
    .setColor(tier.color)
    .setAuthor({ name: `Voice Stats — ${user.username}`, iconURL: user.displayAvatarURL() })
    .setThumbnail(user.displayAvatarURL())
    .addFields(
      { name: '🎧 Total Voice Time', value: voiceActivity.formatDurationLong(stats.totalSeconds), inline: true },
      { name: '🔥 Streak Sekarang', value: `${stats.currentStreak} hari`, inline: true },
      { name: '🏆 Streak Terpanjang', value: `${stats.longestStreak} hari`, inline: true },
      { name: 'Title', value: `${tier.emoji} **${tier.title}**`, inline: false },
      { name: 'Progress ke Tier Berikutnya', value: progressText, inline: false }
    );
  if (stats.isActive) embed.setFooter({ text: '🟢 Lagi aktif di voice sekarang' });
  return embed;
}

// buildLeaderboardEmbed diimpor dari voiceActivityCommands.js (satu sumber
// yang sama dipakai /voiceleaderboard DAN dropdown leaderboard di panel).

async function handlePanelQueue(interaction) {
  const queue = musicManager.getQueue(interaction.guildId);
  const autoplayStatus = queue.autoplayEnabled ? 'ON' : 'OFF';

  if (!queue.current && queue.tracks.length === 0) {
    await interaction.reply({
      embeds: [textEmbed(`Antrian kosong, nggak ada musik yang diputar.\n\nAutoplay: ${autoplayStatus}`)],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const embed = new EmbedBuilder().setColor(COLOR).setTitle('Antrian Musik');

  if (queue.current) {
    embed.addFields({
      name: 'Sedang Diputar',
      value: `**${queue.current.title}**${queue.current.isAutoplay ? ' _(Autoplay)_' : ''} — diminta oleh ${queue.current.requestedBy}`,
    });
  }

  if (queue.tracks.length > 0) {
    const list = queue.tracks
      .slice(0, 10)
      .map((t, i) => `${i + 1}. **${t.title}** — diminta oleh ${t.requestedBy}`)
      .join('\n');
    const extra = queue.tracks.length > 10 ? `\n...dan ${queue.tracks.length - 10} lagu lainnya` : '';
    embed.addFields({ name: 'Berikutnya', value: list + extra });
  }

  embed.addFields({ name: 'Autoplay', value: autoplayStatus, inline: true });

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

voiceActivity.load();
musicPlaylistStore.load();
stickyMessage.load();
stickyManager.init(client, log);
panelStore.load();
streakStore.load();
idCardStore.load();
aiChat.init(log);

const panelApi = { repositionChannelStack };

// Finalisasi window streak yang lewat: sekali pas startup (jaga-jaga kalau
// bot mati pas window lagi tutup), lalu berkala tiap 2 menit biar batas jam
// 23:00 WIB kedeteksi cepat tanpa nunggu lama.
const STREAK_TICK_INTERVAL_MS = 2 * 60 * 1000;
streakManager.tickAllGroups();
setInterval(() => streakManager.tickAllGroups(), STREAK_TICK_INTERVAL_MS);

async function connectToVoice() {
  if (reconnecting) return;
  reconnecting = true;

  try {
    // Bersihkan koneksi lama sepenuhnya sebelum bikin yang baru. Penting:
    // @discordjs/voice men-reuse object VoiceConnection yang sama per guild
    // kalau masih ada yang belum di-destroy, jadi listener lama bisa numpuk
    // dan event kelipatan. destroy() + removeAllListeners() mencegah itu.
    if (connection) {
      try {
        connection.removeAllListeners();
        if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
          connection.destroy();
        }
      } catch {
        // sudah destroyed / invalid state, aman diabaikan
      }
      connection = null;
    }
    if (player) {
      try {
        player.removeAllListeners();
        player.stop(true);
      } catch {
        // ignore
      }
      player = null;
    }

    const channel = await client.channels.fetch(config.voiceChannelId);

    if (!channel || !channel.isVoiceBased()) {
      log(`FATAL: Channel ${config.voiceChannelId} tidak ditemukan atau bukan voice channel.`);
      process.exit(1);
    }

    // Cek permission bot secara eksplisit sebelum coba connect, supaya
    // ketauan dari log kalau memang izinnya yang bermasalah (bukan network).
    const botMember = channel.guild.members.me ?? (await channel.guild.members.fetchMe());
    const perms = channel.permissionsFor(botMember);
    if (!perms.has('Connect') || !perms.has('ViewChannel')) {
      log(
        `FATAL: Bot tidak punya izin Connect/View Channel di voice channel ini. ` +
          `Connect=${perms.has('Connect')} ViewChannel=${perms.has('ViewChannel')}. ` +
          `Cek permission overwrite di channel tersebut.`
      );
    } else {
      log('Permission Connect & View Channel OK, lanjut join...');
    }

    connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: true, // hemat bandwidth, bot ga perlu denger orang lain
      selfMute: false, // false karena kita justru mau "mainkan" silent audio
      debug: true,
    });

    connection.on('debug', (message) => {
      log(`[VOICE DEBUG] ${message}`);
    });

    // Tangkap raw close event dari WS voice server kalau ada — ini biasanya
    // nyimpen kode alasan penutupan (4001-4022 dst) yang nggak muncul di
    // ringkasan 'stateChange' biasa.
    connection.on('error', (err) => {
      log(`Voice connection error (detail): ${err?.stack || err}`);
    });

    player = createAudioPlayer();
    musicManager.init(player, log, { onTrackStart, onQueueEmpty });
    currentGuildId = channel.guild.id;
    await cleanupOldNowPlayingCard(currentGuildId);
    musicManager.resyncAfterReconnect(currentGuildId);
    connection.subscribe(player);

    player.on('error', (err) => {
      log(`Audio player error: ${err.message}`);
    });

    // Player idle: entah track abis, di-skip, atau di-stop -- musicManager
    // yang nentuin lanjut ke track berikutnya di antrian atau balik ke
    // silent audio (biar voice connection tetap "hidup" walau nggak ada musik).
    player.on(AudioPlayerStatus.Idle, () => {
      musicManager.playNext(currentGuildId);
    });

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      log('Voice connection disconnected, mencoba recover...');
      try {
        // Race antara reconnect otomatis Discord.js atau signaling destroy
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
        // Masih dalam proses reconnect internal, biarkan
      } catch {
        // Gagal recover otomatis -> destroy dan rejoin manual
        try {
          connection.destroy();
        } catch {
          // sudah destroyed
        }
        handleConnectionDrop();
      }
    });

    connection.on(VoiceConnectionStatus.Destroyed, () => {
      log('Voice connection destroyed.');
      handleConnectionDrop();
    });

    connection.on('stateChange', (oldSt, newSt) => {
      log(`Voice connection state: ${oldSt.status} -> ${newSt.status}`);
    });

    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    log(`Berhasil join voice channel: ${channel.name} (${channel.id})`);
    connectedAt = Date.now(); // dipakai handleConnectionDrop buat nentuin apakah ini koneksi yang "stabil"
  } catch (err) {
    handleConnectionDrop(`Gagal connect ke voice channel: ${err.message}`);
  } finally {
    reconnecting = false;
  }
}

// Dipanggil tiap kali koneksi voice putus, entah gagal pas awal connect
// ATAU putus abis sempet berhasil (event Disconnected/Destroyed). Cuma
// reset backoff ke awal kalau koneksi SEBELUMNYA sempet stabil cukup lama
// (>= STABLE_CONNECTION_MS) -- kalau baru aja connect terus langsung putus
// lagi dalam hitungan detik (flapping), JANGAN direset, biar delay-nya terus
// naik dan nggak hammering jaringan yang emang lagi nggak stabil.
const STABLE_CONNECTION_MS = 30_000;
function handleConnectionDrop(logMessage) {
  const wasStable = connectedAt !== null && Date.now() - connectedAt >= STABLE_CONNECTION_MS;
  connectedAt = null;

  if (wasStable) {
    consecutiveFailures = 0;
  }
  consecutiveFailures += 1;

  if (logMessage) log(`${logMessage} (percobaan gagal beruntun: ${consecutiveFailures})`);
  scheduleReconnect();
}

function scheduleReconnect() {
  if (shuttingDown) return; // jangan reconnect kalau memang lagi sengaja mati

  // Exponential backoff dengan cap 5 menit, supaya kalau memang lagi
  // di-throttle/block Discord atau jaringan lagi nggak stabil, kita nggak
  // makin gencar hammering dan memperparah situasi. Attempt ke-1: 5s,
  // ke-2: 10s, ke-3: 20s, ... maks 300s.
  const delay = Math.min(config.reconnectDelayMs * 2 ** Math.max(0, consecutiveFailures - 1), 300_000);
  log(`Mencoba reconnect dalam ${Math.round(delay / 1000)}s... (percobaan gagal beruntun: ${consecutiveFailures})`);
  setTimeout(() => {
    connectToVoice();
  }, delay);
}

// Health check berkala: kalau ternyata bot udah nggak di voice channel
// (misal di-kick manual dari voice tanpa event Disconnected ke-trigger dengan bersih),
// paksa rejoin.
function startHealthCheck() {
  setInterval(async () => {
    try {
      const channel = await client.channels.fetch(config.voiceChannelId);
      const botMember = channel.guild.members.me;
      const isInChannel = botMember?.voice?.channelId === config.voiceChannelId;

      if (!isInChannel) {
        log('Health check: bot tidak berada di voice channel, rejoin...');
        connectToVoice();
      }
    } catch (err) {
      log(`Health check error: ${err.message}`);
    }
  }, config.healthCheckIntervalMs);
}

// Kalau ada user lain yang "geser paksa" bot atau channel di-delete, dst.
client.on('voiceStateUpdate', (oldState, newState) => {
  if (oldState.member?.id !== client.user?.id) return;
  // Bot pindah channel atau keluar voice
  if (oldState.channelId === config.voiceChannelId && newState.channelId !== config.voiceChannelId) {
    handleConnectionDrop('Bot terdeteksi keluar/dipindah dari voice channel target, rejoin...');
  }
});

// Pesan sambutan tiap kali ada member yang BARU join voice channel target
// Satpam Voice (bukan lagi di situ sebelumnya) -- dikirim ke text chat
// bawaan voice channel itu sendiri ("Voice Channel Chat"). Bot butuh izin
// Send Messages & Embed Links di voice channel target buat ini jalan.
client.on('voiceStateUpdate', async (oldState, newState) => {
  const member = newState.member;
  if (!member || member.user.bot) return;
  if (newState.channelId !== config.voiceChannelId) return;
  if (oldState.channelId === config.voiceChannelId) return; // udah di channel ini sebelumnya, bukan join baru

  try {
    await newState.channel.send({ embeds: [welcomeManager.buildWelcomeEmbed(member)] });
  } catch (err) {
    log(`[WELCOME] Gagal kirim pesan sambutan buat ${member.user.tag}: ${err?.stack || err}`);
  }
});

// Tracking aktivitas voice buat SEMUA member (bukan cuma channel target),
// dipakai buat /voicestats dan /voiceleaderboard. Bot sendiri & bot lain
// nggak ikut ditrack.
client.on('voiceStateUpdate', (oldState, newState) => {
  const member = newState.member || oldState.member;
  if (!member || member.user.bot) return;

  const wasInChannel = !!oldState.channelId;
  const isInChannel = !!newState.channelId;

  if (!wasInChannel && isInChannel) {
    voiceActivity.startSession(member.id, member.user.username);
  } else if (wasInChannel && !isInChannel) {
    voiceActivity.endSession(member.id);
  }
  // Kalau cuma pindah channel (masih di voice manapun), sesi tetap
  // lanjut jalan -- nggak perlu di-reset karena kita ngitung SEMUA channel.
});

// Handler buat semua command: slash command (/play, /skip, dst) DAN
// context-menu command ("Jadikan Sticky" -- klik kanan pesan > Apps).
client.on('interactionCreate', async (interaction) => {
  // Tombol "Join Giveaway" -- ini jenis interaksi beda (button), bukan command.
  if (interaction.isButton()) {
    if (interaction.customId === giveawayManager.JOIN_BUTTON_ID) {
      try {
        const result = await giveawayManager.toggleParticipant(interaction.message.id, interaction.user.id);
        if (!result.ok) {
          await interaction.reply({ content: 'Giveaway ini sudah berakhir atau tidak ditemukan.', flags: MessageFlags.Ephemeral });
          return;
        }
        await interaction.reply({
          content: result.joined
            ? 'Kamu berhasil ikut giveaway ini. Klik lagi tombolnya kalau mau membatalkan.'
            : 'Kamu keluar dari giveaway ini.',
          flags: MessageFlags.Ephemeral,
        });
        await giveawayManager.refreshParticipantCount(interaction.client, interaction.message.id);
      } catch (err) {
        log(`[GIVEAWAY] Error tombol join: ${err?.stack || err}`);
      }
      return;
    }

    if (interaction.customId === 'vote_cast') {
      try {
        await voteManager.castVote(interaction);
      } catch (err) {
        log(`[VOTE] Error tombol vote: ${err?.stack || err}`);
      }
      return;
    }

    if (interaction.customId.startsWith('ai_confirm:') || interaction.customId.startsWith('ai_cancel:')) {
      const [action, id] = interaction.customId.split(':');
      const pending = aiTools.getPendingConfirmation(id);

      if (!pending) {
        await interaction.update({
          embeds: [new EmbedBuilder().setColor(EMBED_COLOR).setDescription('Konfirmasi ini udah kadaluarsa.')],
          components: [],
        });
        return;
      }
      if (interaction.user.id !== pending.userId) {
        await interaction.reply({ content: 'Cuma yang minta aksi ini yang bisa konfirmasi/batal.', flags: MessageFlags.Ephemeral });
        return;
      }

      aiTools.clearPendingConfirmation(id);

      if (action === 'ai_cancel') {
        await interaction.update({
          embeds: [new EmbedBuilder().setColor(EMBED_COLOR).setDescription('Dibatalkan.')],
          components: [],
        });
        return;
      }

      const result = await aiTools.executeTool(pending.toolName, pending.args, {
        guildId: pending.guildId ?? interaction.guildId,
        channelId: pending.channelId ?? interaction.channelId,
        userId: pending.userId,
        userTag: interaction.user.tag,
        client: interaction.client,
      });
      await interaction.update({
        embeds: [new EmbedBuilder().setColor(EMBED_COLOR).setDescription(result.message)],
        components: [],
      });
      return;
    }

    if (interaction.customId.startsWith('music_')) {
      const guildId = interaction.guildId;
      // Pastiin referensi pesan yang di-track selalu nunjuk ke card yang
      // BARUSAN diklik (kalau ada beberapa /nowplaying kebuka bersamaan).
      musicManager.setNowPlayingMessage(guildId, interaction.channelId, interaction.message.id);

      try {
        if (interaction.customId === 'music_pause') {
          if (musicManager.isPaused()) musicManager.resume(guildId);
          else musicManager.pause(guildId);
          // Pause/resume state-nya langsung berubah (sinkron), aman di-render ulang sekarang juga.
          const { embed, components } = buildNowPlayingCard(guildId);
          await interaction.update({ embeds: [embed], components });
        } else if (interaction.customId === 'music_autoplay') {
          musicManager.setAutoplay(guildId, !musicManager.isAutoplayEnabled(guildId));
          const { embed, components } = buildNowPlayingCard(guildId);
          await interaction.update({ embeds: [embed], components });
        } else if (interaction.customId === 'music_loop') {
          const nextMode = cycleLoopMode(musicManager.getLoopMode(guildId));
          musicManager.setLoopMode(guildId, nextMode);
          // Sinkron juga (nggak lewat transisi Idle), aman di-render ulang sekarang juga.
          const { embed, components } = buildNowPlayingCard(guildId);
          await interaction.update({ embeds: [embed], components });
        } else if (interaction.customId === 'music_skip') {
          const queueForSkip = musicManager.getQueue(guildId);
          if (!permissions.canControlPlayback(interaction.member, queueForSkip.current)) {
            await interaction.reply({
              content: 'Cuma yang minta lagu ini, owner, atau staff yang bisa skip.',
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
          // Transisinya ASYNC (lewat event 'Idle'), jadi nggak langsung
          // di-render ulang di sini -- nanti onTrackStart yang manggil
          // refreshNowPlayingCard() begitu transisinya kelar.
          musicManager.skip(guildId);
          await interaction.deferUpdate();
        } else if (interaction.customId === 'music_stop') {
          const queueForStop = musicManager.getQueue(guildId);
          if (!permissions.canControlPlayback(interaction.member, queueForStop.current)) {
            await interaction.reply({
              content: 'Cuma yang minta lagu ini, owner, atau staff yang bisa stop musik.',
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
          musicManager.stop(guildId);
          await interaction.deferUpdate();
        } else if (interaction.customId === 'music_lyrics') {
          const queueForLyrics = musicManager.getQueue(guildId);
          if (!queueForLyrics.current) {
            await interaction.reply({ content: 'Nggak ada lagu yang lagi diputar.', flags: MessageFlags.Ephemeral });
            return;
          }
          // Balesannya ephemeral (cuma yang klik yang liat) & TERPISAH dari
          // card Now Playing -- beda dari tombol lain di sini, "Lirik"
          // nggak ngubah state lagu jadi card-nya nggak perlu di-update.
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          try {
            const result = await lyricsManager.getLyrics(queueForLyrics.current.title);
            const embed = lyricsManager.buildLyricsEmbed(queueForLyrics.current, result);
            await interaction.editReply({ embeds: [embed] });
          } catch (lyricsErr) {
            log(`[MUSIC BUTTON] Error ambil lirik: ${lyricsErr?.stack || lyricsErr}`);
            await interaction.editReply({ content: 'Gagal ambil lirik, coba lagi.' }).catch(() => {});
          }
        } else {
          await interaction.deferUpdate();
        }
      } catch (err) {
        log(`[MUSIC BUTTON] Error di tombol ${interaction.customId}: ${err?.stack || err}`);
      }
      return;
    }

    // ============================================================
    // PANEL: semua tombol dari panel utama & sub-menunya. Semua balasannya
    // ephemeral (cuma keliatan yang klik) supaya panel publik yang sticky
    // itu nggak perlu berubah tampilan buat orang lain.
    // ============================================================
    if (interaction.customId === 'panel_music') {
      try {
        await interaction.reply({
          embeds: [
            new EmbedBuilder()
              .setColor(PANEL_COLOR)
              .setAuthor({ name: '🎵  Kontrol Musik' })
              .setDescription('Pilih aksi di bawah ini.'),
          ],
          components: [buildMusicSubRow()],
          flags: MessageFlags.Ephemeral,
        });
      } catch (err) {
        log(`[PANEL] Error tombol panel_music: ${err?.stack || err}`);
      }
      return;
    }

    if (interaction.customId === 'panel_giveaway') {
      try {
        const canManage = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('panelgw_list').setLabel('Lihat Aktif').setEmoji('📋').setStyle(ButtonStyle.Secondary),
          ...(canManage
            ? [new ButtonBuilder().setCustomId('panelgw_create').setLabel('Buat Giveaway').setEmoji('🎁').setStyle(ButtonStyle.Success)]
            : [])
        );
        await interaction.reply({
          embeds: [
            new EmbedBuilder()
              .setColor(PANEL_COLOR)
              .setAuthor({ name: '🎁  Giveaway' })
              .setDescription('Kelola giveaway di server ini.'),
          ],
          components: [row],
          flags: MessageFlags.Ephemeral,
        });
      } catch (err) {
        log(`[PANEL] Error tombol panel_giveaway: ${err?.stack || err}`);
      }
      return;
    }

    if (interaction.customId === 'panel_voicestats') {
      try {
        await interaction.reply({
          embeds: [
            new EmbedBuilder()
              .setColor(PANEL_COLOR)
              .setAuthor({ name: '📊  Voice Stats' })
              .setDescription('Mau tampilkan apa ke channel ini? Pilih dari dropdown di bawah.')
              .setFooter({ text: 'Hasilnya bakal dikirim publik ke channel, bukan cuma buat kamu.' }),
          ],
          components: [buildVoiceStatsSelectRow()],
          flags: MessageFlags.Ephemeral,
        });
      } catch (err) {
        log(`[PANEL] Error tombol panel_voicestats: ${err?.stack || err}`);
      }
      return;
    }

    if (interaction.customId === 'panel_ask') {
      try {
        const modal = new ModalBuilder().setCustomId('panel_ask_modal').setTitle('Tanya AI');
        const questionInput = new TextInputBuilder()
          .setCustomId('panel_ask_question')
          .setLabel('Pertanyaan kamu')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setPlaceholder('Tulis pertanyaan kamu di sini...');
        modal.addComponents(new ActionRowBuilder().addComponents(questionInput));
        await interaction.showModal(modal);
      } catch (err) {
        log(`[PANEL] Error tombol panel_ask: ${err?.stack || err}`);
      }
      return;
    }

    if (interaction.customId === 'panel_help') {
      try {
        const embed = buildCommandsListEmbed(commands);
        await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      } catch (err) {
        log(`[PANEL] Error tombol panel_help: ${err?.stack || err}`);
      }
      return;
    }

    // ============================================================
    // ID CARD: tombol "ID Card" di panel utama -> munculin 2 pilihan
    // (Buat ID, Lihat ID Saya). ID No/Join Server/Dibuat Tanggal/foto
    // profil digenerate otomatis, cuma 5 field yang diisi manual lewat
    // modal (Nama, Jenis Kelamin, Domisili, Cita-Cita, Hobi).
    // ============================================================
    if (interaction.customId === 'panel_idcard') {
      try {
        await interaction.reply({
          embeds: [
            new EmbedBuilder()
              .setColor(PANEL_COLOR)
              .setAuthor({ name: '🪪  ID Card Satpam Voice' })
              .setDescription('Bikin kartu identitas kamu sendiri, atau lihat yang udah pernah dibuat.'),
          ],
          components: [buildIdCardSubRow()],
          flags: MessageFlags.Ephemeral,
        });
      } catch (err) {
        log(`[PANEL] Error tombol panel_idcard: ${err?.stack || err}`);
      }
      return;
    }

    if (interaction.customId === 'panel_tiktok') {
      try {
        await interaction.reply({
          embeds: [tiktokLive.buildTiktokInfoEmbed()],
          flags: MessageFlags.Ephemeral,
        });
      } catch (err) {
        log(`[PANEL] Error tombol panel_tiktok: ${err?.stack || err}`);
      }
      return;
    }

    if (interaction.customId === 'panelid_create') {
      try {
        if (idCardStore.hasCard(interaction.guildId, interaction.user.id)) {
          await interaction.reply({
            embeds: [
              new EmbedBuilder()
                .setColor(0x99aab5)
                .setDescription('Kamu udah punya ID Card. Klik **Lihat ID Saya** buat liat punya kamu.'),
            ],
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const modal = new ModalBuilder().setCustomId('panel_idcard_modal').setTitle('Buat ID Card');
        modal.addComponents(
          ...idCardManager.INPUT_FIELDS.map((field) =>
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId(field.customId)
                .setLabel(field.label)
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setMaxLength(idCardManager.FIELD_MAX_LENGTH)
            )
          )
        );
        await interaction.showModal(modal);
      } catch (err) {
        log(`[PANEL] Error tombol panelid_create: ${err?.stack || err}`);
      }
      return;
    }

    if (interaction.customId === 'panelid_view') {
      try {
        const card = idCardStore.getCard(interaction.guildId, interaction.user.id);
        if (!card) {
          await interaction.reply({
            embeds: [
              new EmbedBuilder()
                .setColor(0x99aab5)
                .setDescription('Kamu belum punya ID Card. Klik **Buat ID** buat bikin sekarang.'),
            ],
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        // Gambar ID Card digambar on-the-fly (canvas + foto profil Discord)
        // -- bisa makan waktu >3 detik kalau fetch avatarnya lelet, jadi
        // defer dulu (ephemeral, cuma buat nahan interaksinya) sebelum
        // hasilnya dikirim PUBLIK ke channel (mirip Voice Leaderboard --
        // "Lihat ID Saya" ditujukan buat dipamerin, bukan cuma diliat
        // sendiri).
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const buffer = await renderIdCardImage(card, interaction.user, interaction.guild?.name);
        const attachment = new AttachmentBuilder(buffer, { name: 'idcard.png' });
        const embed = idCardManager.buildIdCardEmbed(card, 'idcard.png');
        await interaction.channel.send({ content: `🪪 ID Card dari <@${interaction.user.id}>`, embeds: [embed], files: [attachment] });
        await interaction.editReply({ content: '✅ ID Card kamu ditampilkan ke channel.' });
      } catch (err) {
        log(`[PANEL] Error tombol panelid_view: ${err?.stack || err}`);
        await interaction.editReply({ content: 'Gagal generate gambar ID Card, coba lagi.' }).catch(() => {});
      }
      return;
    }

    // ============================================================
    // STREAK: tombol "Streak" di panel utama -> munculin 3 pilihan
    // (Streak/info, Buat Grup, Grup Saya). Deteksi checkin-nya sendiri
    // jalan otomatis lewat listener messageCreate di atas, nggak ada
    // tombol "checkin" manual.
    // ============================================================
    if (interaction.customId === 'panel_streak') {
      try {
        await interaction.reply({
          embeds: [
            new EmbedBuilder()
              .setColor(PANEL_COLOR)
              .setAuthor({ name: '🔥  Grup Streak Chat' })
              .setDescription('Pilih salah satu di bawah ini.'),
          ],
          components: [buildStreakSubRow()],
          flags: MessageFlags.Ephemeral,
        });
      } catch (err) {
        log(`[PANEL] Error tombol panel_streak: ${err?.stack || err}`);
      }
      return;
    }

    if (interaction.customId === 'panelstreak_info') {
      try {
        await interaction.reply({ embeds: [streakManager.buildStreakInfoEmbed()], flags: MessageFlags.Ephemeral });
      } catch (err) {
        log(`[PANEL] Error tombol panelstreak_info: ${err?.stack || err}`);
      }
      return;
    }

    if (interaction.customId === 'panelstreak_create') {
      try {
        const existing = streakStore.getGroupByOwner(interaction.guildId, interaction.user.id);
        if (existing) {
          await interaction.reply({
            embeds: [
              new EmbedBuilder()
                .setColor(0x99aab5)
                .setDescription(
                  `Kamu udah punya grup aktif (ID \`${existing.id}\`, ${existing.memberIds.length}/${streakManager.MAX_MEMBERS} member). Cuma boleh 1 grup per owner.`
                ),
            ],
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        // Sebelum bikin grup, minta owner kasih nama dulu lewat modal.
        const modal = new ModalBuilder().setCustomId('panel_streak_create_modal').setTitle('Buat Grup Streak');
        const nameInput = new TextInputBuilder()
          .setCustomId('panel_streak_name')
          .setLabel('Nama Grup')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(streakManager.MAX_NAME_LENGTH)
          .setPlaceholder('misal: Squad Gacor');
        modal.addComponents(new ActionRowBuilder().addComponents(nameInput));
        await interaction.showModal(modal);
      } catch (err) {
        log(`[PANEL] Error tombol panelstreak_create: ${err?.stack || err}`);
      }
      return;
    }

    if (interaction.customId === 'panelstreak_mygroup') {
      try {
        const group = streakStore.getGroupForUser(interaction.guildId, interaction.user.id);
        if (!group) {
          await interaction.reply({
            embeds: [
              new EmbedBuilder()
                .setColor(0x99aab5)
                .setDescription('Kamu belum join atau bikin grup streak manapun. Klik **Buat Grup** buat mulai.'),
            ],
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const embed = streakManager.buildGroupStatusEmbed(group, interaction.user.id);
        const isOwner = group.ownerId === interaction.user.id;
        const components = [];
        if (isOwner) {
          const buttonRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('panelstreak_rename').setLabel('Ganti Nama').setEmoji('✏️').setStyle(ButtonStyle.Secondary)
          );
          components.push(buttonRow);
          if (group.memberIds.length < streakManager.MAX_MEMBERS) {
            const select = new UserSelectMenuBuilder()
              .setCustomId('panelstreak_invite_select')
              .setPlaceholder('➕ Invite member baru ke grup ini...')
              .setMinValues(1)
              .setMaxValues(1);
            components.push(new ActionRowBuilder().addComponents(select));
          }
        }
        await interaction.reply({ embeds: [embed], components, flags: MessageFlags.Ephemeral });
      } catch (err) {
        log(`[PANEL] Error tombol panelstreak_mygroup: ${err?.stack || err}`);
      }
      return;
    }

    if (interaction.customId === 'panelstreak_rename') {
      try {
        const group = streakStore.getGroupByOwner(interaction.guildId, interaction.user.id);
        if (!group) {
          await interaction.reply({ content: 'Kamu bukan owner grup manapun.', flags: MessageFlags.Ephemeral });
          return;
        }

        const modal = new ModalBuilder().setCustomId('panel_streak_rename_modal').setTitle('Ganti Nama Grup');
        const nameInput = new TextInputBuilder()
          .setCustomId('panel_streak_name')
          .setLabel('Nama Grup Baru')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(streakManager.MAX_NAME_LENGTH)
          .setPlaceholder('misal: Squad Gacor');
        if (group.name && typeof nameInput.setValue === 'function') nameInput.setValue(group.name);
        modal.addComponents(new ActionRowBuilder().addComponents(nameInput));
        await interaction.showModal(modal);
      } catch (err) {
        log(`[PANEL] Error tombol panelstreak_rename: ${err?.stack || err}`);
      }
      return;
    }

    if (interaction.customId === 'panelstreak_leaderboard') {
      try {
        const embed = streakManager.buildStreakLeaderboardEmbed(interaction.guildId);
        await interaction.channel.send({ embeds: [embed] });
        await interaction.reply({ content: '✅ Leaderboard streak dikirim ke channel.', flags: MessageFlags.Ephemeral });
      } catch (err) {
        log(`[PANEL] Error tombol panelstreak_leaderboard: ${err?.stack || err}`);
      }
      return;
    }

    if (interaction.customId === 'panelgw_list') {
      try {
        const all = giveawayManager.loadAll();
        const active = all.filter((g) => g.guildId === interaction.guildId && !g.ended);
        if (active.length === 0) {
          await interaction.reply({
            embeds: [new EmbedBuilder().setColor(PANEL_COLOR).setDescription('📭 Tidak ada giveaway aktif saat ini.')],
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const lines = active.map(
          (g) =>
            `**${g.prize}**\n> ID \`${g.id}\` • <#${g.channelId}> • berakhir <t:${Math.floor(g.endTime / 1000)}:R> • ${g.participants.length} peserta`
        );
        await interaction.reply({
          embeds: [
            new EmbedBuilder()
              .setColor(PANEL_COLOR)
              .setAuthor({ name: `🎁  Giveaway Aktif (${active.length})` })
              .setDescription(lines.join('\n\n')),
          ],
          flags: MessageFlags.Ephemeral,
        });
      } catch (err) {
        log(`[PANEL] Error tombol panelgw_list: ${err?.stack || err}`);
      }
      return;
    }

    if (interaction.customId === 'panelgw_create') {
      try {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
          await interaction.reply({
            content: 'Cuma yang punya izin Manage Server yang bisa bikin giveaway.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const modal = new ModalBuilder().setCustomId('panel_giveaway_modal').setTitle('Buat Giveaway');
        const prizeInput = new TextInputBuilder()
          .setCustomId('panel_gw_prize')
          .setLabel('Hadiah')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder('misal: 550 ROBUX VIA PAYOUT');
        const durationInput = new TextInputBuilder()
          .setCustomId('panel_gw_duration')
          .setLabel('Durasi')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder('misal: 30m, 1h, 2d, 1h30m');
        const winnersInput = new TextInputBuilder()
          .setCustomId('panel_gw_winners')
          .setLabel('Jumlah Pemenang (default 1)')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setPlaceholder('1');
        modal.addComponents(
          new ActionRowBuilder().addComponents(prizeInput),
          new ActionRowBuilder().addComponents(durationInput),
          new ActionRowBuilder().addComponents(winnersInput)
        );
        await interaction.showModal(modal);
      } catch (err) {
        log(`[PANEL] Error tombol panelgw_create: ${err?.stack || err}`);
      }
      return;
    }

    if (interaction.customId === 'panelmusic_play') {
      try {
        const modal = new ModalBuilder().setCustomId('panel_play_modal').setTitle('Putar Musik');
        const inputField = new TextInputBuilder()
          .setCustomId('panel_play_input')
          .setLabel('Link/Judul Lagu')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder('Link YouTube/Spotify, link playlist, atau judul lagu');
        modal.addComponents(new ActionRowBuilder().addComponents(inputField));
        await interaction.showModal(modal);
      } catch (err) {
        log(`[PANEL] Error tombol panelmusic_play: ${err?.stack || err}`);
      }
      return;
    }

    if (interaction.customId === 'panelmusic_skip') {
      try {
        await handlePanelSkip(interaction);
      } catch (err) {
        log(`[PANEL] Error tombol panelmusic_skip: ${err?.stack || err}`);
      }
      return;
    }

    if (interaction.customId === 'panelmusic_stop') {
      try {
        await handlePanelStop(interaction);
      } catch (err) {
        log(`[PANEL] Error tombol panelmusic_stop: ${err?.stack || err}`);
      }
      return;
    }

    if (interaction.customId === 'panelmusic_queue') {
      try {
        await handlePanelQueue(interaction);
      } catch (err) {
        log(`[PANEL] Error tombol panelmusic_queue: ${err?.stack || err}`);
      }
      return;
    }

    return;
  }

  // Modal panel (Play & Create Giveaway) -- balasan submit modal, jenis
  // interaksi beda lagi dari button/command biasa.
  if (interaction.isModalSubmit()) {
    if (interaction.customId === 'panel_play_modal') {
      const input = interaction.fields.getTextInputValue('panel_play_input')?.trim();
      if (!input) {
        await interaction.reply({ content: 'Input nggak boleh kosong.', flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.deferReply();
      try {
        await commands.performPlay(interaction, input, log);
      } catch (err) {
        log(`[PANEL] Error play dari panel: ${err?.stack || err}`);
        await interaction.editReply({ embeds: [textEmbed('Ada error waktu mainin lagu ini.')] }).catch(() => {});
      }
      return;
    }

    if (interaction.customId === 'panel_ask_modal') {
      const question = interaction.fields.getTextInputValue('panel_ask_question')?.trim();
      if (!question) {
        await interaction.reply({ content: 'Pertanyaan nggak boleh kosong.', flags: MessageFlags.Ephemeral });
        return;
      }
      try {
        await aiCommands.performAsk(interaction, question);
      } catch (err) {
        log(`[PANEL] Error tanya AI dari panel: ${err?.stack || err}`);
      }
      return;
    }

    if (interaction.customId === 'panel_idcard_modal') {
      try {
        if (idCardStore.hasCard(interaction.guildId, interaction.user.id)) {
          await interaction.reply({
            content: 'Kamu udah punya ID Card. Klik **Lihat ID Saya** buat liat punya kamu.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const fields = {};
        for (const field of idCardManager.INPUT_FIELDS) {
          const raw = interaction.fields.getTextInputValue(field.customId);
          const check = idCardManager.sanitizeField(raw);
          if (!check.ok) {
            const msg =
              check.reason === 'too_long'
                ? `${field.label} maksimal ${idCardManager.FIELD_MAX_LENGTH} karakter.`
                : `${field.label} nggak boleh kosong.`;
            await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
            return;
          }
          fields[field.key] = check.value;
        }

        // Defer dulu -- generate gambarnya (canvas + fetch avatar) bisa
        // makan waktu lebih dari 3 detik.
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const joinServerAt = interaction.member?.joinedTimestamp || null;
        const card = idCardStore.createCard(interaction.guildId, interaction.user.id, fields, joinServerAt);
        const buffer = await renderIdCardImage(card, interaction.user, interaction.guild?.name);
        const attachment = new AttachmentBuilder(buffer, { name: 'idcard.png' });
        const embed = idCardManager.buildIdCardEmbed(card, 'idcard.png');
        await interaction.editReply({
          content: '✅ ID Card berhasil dibuat!',
          embeds: [embed],
          files: [attachment],
        });
      } catch (err) {
        log(`[PANEL] Error panel_idcard_modal: ${err?.stack || err}`);
        await interaction.editReply({ content: 'Gagal generate gambar ID Card, coba lagi.' }).catch(() => {});
      }
      return;
    }

    if (interaction.customId === 'panel_streak_create_modal') {
      try {
        const raw = interaction.fields.getTextInputValue('panel_streak_name');
        const check = streakManager.sanitizeGroupName(raw);
        if (!check.ok) {
          const msg =
            check.reason === 'too_long'
              ? `Nama grup maksimal ${streakManager.MAX_NAME_LENGTH} karakter.`
              : 'Nama grup nggak boleh kosong.';
          await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
          return;
        }

        // Double-check di sini juga (race kecil kalau modal dibuka lama) --
        // pengecekan utama udah dilakuin sebelum modal ditampilkan.
        const existing = streakStore.getGroupByOwner(interaction.guildId, interaction.user.id);
        if (existing) {
          await interaction.reply({
            content: `Kamu udah punya grup aktif (ID \`${existing.id}\`). Cuma boleh 1 grup per owner.`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const group = streakStore.createGroup(interaction.guildId, interaction.user.id, streakManager.getStreakDayKey(), check.name);
        await interaction.reply({
          embeds: [
            new EmbedBuilder()
              .setColor(0x57f287)
              .setDescription(
                `✅ Grup **${check.name}** berhasil dibuat! (ID \`${group.id}\`)\n\nUndang minimal **${streakManager.MIN_MEMBERS_TO_START - 1} orang lagi** (total ${streakManager.MIN_MEMBERS_TO_START}) lewat tombol **Grup Saya** buat mulai nyalain streak.`
              ),
          ],
          flags: MessageFlags.Ephemeral,
        });
      } catch (err) {
        log(`[PANEL] Error panel_streak_create_modal: ${err?.stack || err}`);
      }
      return;
    }

    if (interaction.customId === 'panel_streak_rename_modal') {
      try {
        const raw = interaction.fields.getTextInputValue('panel_streak_name');
        const check = streakManager.sanitizeGroupName(raw);
        if (!check.ok) {
          const msg =
            check.reason === 'too_long'
              ? `Nama grup maksimal ${streakManager.MAX_NAME_LENGTH} karakter.`
              : 'Nama grup nggak boleh kosong.';
          await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
          return;
        }

        const group = streakStore.getGroupByOwner(interaction.guildId, interaction.user.id);
        if (!group) {
          await interaction.reply({ content: 'Kamu bukan owner grup manapun.', flags: MessageFlags.Ephemeral });
          return;
        }

        streakStore.renameGroup(group.id, check.name);
        await interaction.reply({
          embeds: [new EmbedBuilder().setColor(0x57f287).setDescription(`✅ Nama grup diganti jadi **${check.name}**.`)],
          flags: MessageFlags.Ephemeral,
        });
      } catch (err) {
        log(`[PANEL] Error panel_streak_rename_modal: ${err?.stack || err}`);
      }
      return;
    }

    if (interaction.customId === 'panel_giveaway_modal') {
      try {
        const prize = interaction.fields.getTextInputValue('panel_gw_prize')?.trim();
        const durationStr = interaction.fields.getTextInputValue('panel_gw_duration')?.trim();
        const winnersStr = interaction.fields.getTextInputValue('panel_gw_winners')?.trim();
        const winnerCount = Math.max(1, parseInt(winnersStr, 10) || 1);

        const durationMs = giveawayManager.parseDuration(durationStr);
        if (!durationMs || durationMs < 10_000) {
          await interaction.reply({
            content: 'Durasi tidak valid. Gunakan format seperti `30m`, `1h`, `2d`, atau `1h30m` (minimum 10 detik).',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const channel = interaction.channel;
        const botPerms = channel.permissionsFor(interaction.client.user);
        const required = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];
        const missing = botPerms ? botPerms.missing(required) : required;
        if (missing.length > 0) {
          await interaction.reply({
            content: `Bot tidak punya izin \`${missing.join(', ')}\` di channel ini. Tambahkan izin View Channel, Send Messages, dan Embed Links untuk role bot di channel tersebut, lalu coba lagi.`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const giveaway = await giveawayManager.createGiveaway({ channel, host: interaction.user, prize, winnerCount, durationMs });
        await interaction.editReply({
          content: `Giveaway dibuat di <#${channel.id}>! Berakhir dalam ${giveawayManager.formatDuration(durationMs)}. (ID: \`${giveaway.id}\`)`,
        });
      } catch (err) {
        log(`[PANEL] Error submit giveaway modal: ${err?.stack || err}`);
        const errPayload = { content: 'Ada error waktu bikin giveaway ini.', flags: MessageFlags.Ephemeral };
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply(errPayload).catch(() => {});
        } else {
          await interaction.reply(errPayload).catch(() => {});
        }
      }
      return;
    }

    return;
  }

  // Dropdown "Voice Stats / Leaderboard" dari panel -- hasil yang dipilih
  // sengaja dikirim PUBLIK ke channel (bukan ephemeral), soalnya statistik
  // & leaderboard emang enak dilihat bareng-bareng, bukan cuma yang milih.
  if (interaction.isStringSelectMenu()) {
    if (interaction.customId === 'panel_voicestats_select') {
      try {
        const choice = interaction.values[0];
        const embed = choice === 'leaderboard' ? buildLeaderboardEmbed() : buildVoiceStatsEmbed(interaction.user);
        await interaction.channel.send({ embeds: [embed] });
        await interaction.update({
          embeds: [new EmbedBuilder().setColor(0x57f287).setDescription('✅ Ditampilkan ke channel.')],
          components: [],
        });
      } catch (err) {
        log(`[PANEL] Error dropdown voice stats: ${err?.stack || err}`);
      }
      return;
    }
    return;
  }

  // Picker "Invite member" (owner only) dari tombol Grup Saya -- pilih 1
  // orang lewat native user picker Discord, langsung ditambahin ke grup.
  if (interaction.isUserSelectMenu()) {
    if (interaction.customId === 'panelstreak_invite_select') {
      try {
        const group = streakStore.getGroupByOwner(interaction.guildId, interaction.user.id);
        if (!group) {
          await interaction.update({
            embeds: [new EmbedBuilder().setColor(0x99aab5).setDescription('Kamu bukan owner grup manapun.')],
            components: [],
          });
          return;
        }

        const selected = interaction.users.first();
        if (!selected) {
          await interaction.reply({ content: 'Nggak ada user yang dipilih.', flags: MessageFlags.Ephemeral });
          return;
        }
        if (selected.bot) {
          await interaction.reply({ content: 'Nggak bisa invite bot ke grup streak.', flags: MessageFlags.Ephemeral });
          return;
        }

        const result = streakStore.addMember(group.id, selected.id);
        if (!result.ok) {
          const reasonText =
            result.reason === 'already_member'
              ? 'User itu udah jadi member grup ini.'
              : result.reason === 'full'
                ? `Grup udah penuh (maks ${streakManager.MAX_MEMBERS} member).`
                : 'Gagal nambahin member ke grup.';
          await interaction.reply({ content: reasonText, flags: MessageFlags.Ephemeral });
          return;
        }

        const updatedGroup = result.group;
        const embed = streakManager.buildGroupStatusEmbed(updatedGroup, interaction.user.id);
        const components = [];
        if (updatedGroup.memberIds.length < streakManager.MAX_MEMBERS) {
          const select = new UserSelectMenuBuilder()
            .setCustomId('panelstreak_invite_select')
            .setPlaceholder('➕ Invite member baru ke grup ini...')
            .setMinValues(1)
            .setMaxValues(1);
          components.push(new ActionRowBuilder().addComponents(select));
        }
        await interaction.update({
          embeds: [
            new EmbedBuilder()
              .setColor(0x57f287)
              .setDescription(`✅ <@${selected.id}> berhasil ditambahin ke grup. Total member: ${updatedGroup.memberIds.length}/${streakManager.MAX_MEMBERS}.`),
            embed,
          ],
          components,
        });
      } catch (err) {
        log(`[PANEL] Error invite streak: ${err?.stack || err}`);
      }
      return;
    }
    return;
  }

  // Autocomplete (misal saran nama playlist pas ngetik /playlist play) --
  // ini jenis interaksi beda lagi, harus dijawab lewat respond(), bukan reply().
  if (interaction.isAutocomplete()) {
    const command = commands.find((c) => c.data.name === interaction.commandName);
    if (!command || !command.autocomplete) return;
    try {
      await command.autocomplete(interaction);
    } catch (err) {
      log(`[AUTOCOMPLETE] Error di /${interaction.commandName}: ${err?.stack || err}`);
    }
    return;
  }

  if (!interaction.isChatInputCommand() && !interaction.isMessageContextMenuCommand()) return;

  const command = commands.find((c) => c.data.name === interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction, log, commands, panelApi);
  } catch (err) {
    log(`[COMMAND] Error di /${interaction.commandName}: ${err?.stack || err}`);
    const errorEmbed = new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setDescription('Ada error waktu jalanin command ini. Coba lagi nanti.');
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ embeds: [errorEmbed] }).catch(() => {});
    } else {
      await interaction.reply({ embeds: [errorEmbed], flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
});

// Sticky message: tiap ada pesan baru (bukan dari bot) di channel yang
// punya sticky aktif, jadwalin repost (dengan debounce di stickyManager).
client.on('messageCreate', (message) => {
  if (message.author.bot) return;
  if (!stickyMessage.getSticky(message.channelId)) return;
  stickyManager.scheduleRepost(message.channelId);
});

// Now Playing card DAN panel bot: "nempel" ke bawah chat kayak sticky
// message -- kalau ada pesan APAPUN yang numpuk di atasnya (dari user
// maupun bot, termasuk reply command lain kayak "ditambahkan ke antrian"),
// jadwalin pindahin balik ke bawah lagi. Cuma pesan panel/card ITU SENDIRI
// yang di-skip, biar nggak trigger reposisi buat dirinya sendiri pas baru
// aja dikirim ulang.
client.on('messageCreate', (message) => {
  if (!currentGuildId) return;
  if (stackRepositioningInFlight.has(message.channelId)) return;

  const panel = panelStore.getPanel(message.channelId);
  const npMsg = musicManager.getNowPlayingMessage(currentGuildId);
  const npTrackedHere = !!(npMsg && npMsg.channelId === message.channelId);

  if (!panel && !npTrackedHere) return;
  if (panel && message.id === panel.panelMessageId) return;
  if (npTrackedHere && message.id === npMsg.messageId) return;

  scheduleStackReposition(currentGuildId, message.channelId);
});

// Streak grup: SEMUA pesan non-bot di guild manapun (bukan cuma 1 channel)
// dihitung sebagai "checkin" hari ini buat grup streak yang diikuti si
// pengirim -- sesuai desain "bebas ngobrol di channel manapun", bukan
// terbatas 1 thread/channel khusus.
client.on('messageCreate', (message) => {
  if (message.author.bot) return;
  if (!message.guild) return;
  streakManager.handleMessageForStreak(message.guild.id, message.author.id);
});

// Command berbasis prefix (s!play, s!skip, dll) -- lihat prefixCommands.js.
// Dicek duluan sebelum listener AI chat, jadi kalau pesannya emang command
// prefix, langsung diurus di sini dan nggak lanjut dianggap chat biasa.
client.on('messageCreate', async (message) => {
  await handlePrefixCommand(message, log);
});

// AI chat: mention bot di channel voice Satpam Voice buat ngobrol. Dibatasi
// cuma di channel itu (bukan di channel teks lain), dan inget konteks
// percakapan per user (lewat aiChat.js).
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (message.channelId !== config.voiceChannelId) return;
  if (!client.user || !message.mentions.has(client.user.id)) return;

  const question = message.content.replace(/<@!?\d+>/g, '').trim();
  if (!question) return;

  try {
    await message.channel.sendTyping().catch(() => {});
    const ctx = {
      guildId: message.guild.id,
      channelId: message.channelId,
      userId: message.author.id,
      userTag: message.author.tag,
      client: message.client,
    };
    const result = await aiChat.chatReply(question, ctx);

    if (result.pendingConfirmation) {
      const id = aiTools.createPendingConfirmation({
        ...result.pendingConfirmation,
        guildId: ctx.guildId,
        channelId: ctx.channelId,
        userId: ctx.userId,
      });
      const confirmMsg = aiTools.buildConfirmationMessage(id, result.pendingConfirmation.toolName, result.pendingConfirmation.args);
      await message.reply(confirmMsg);
      return;
    }

    const chunks = aiChat.splitIntoChunks(result.text);
    for (let i = 0; i < chunks.length; i++) {
      if (i === 0) {
        await message.reply(chunks[i]);
      } else {
        await message.channel.send(chunks[i]);
      }
    }
  } catch (err) {
    log(`[AI] Gagal balas chat: ${err.message}`);
    await message.reply('Maaf, ada error waktu minta jawaban dari AI.').catch(() => {});
  }
});

client.once('ready', () => {
  log(`Login sebagai ${client.user.tag}`);
  // Biar semua embed fitur lain (ID Card, Streak, Welcome, Giveaway, dst)
  // bisa pasang logo bot di footer-nya tanpa perlu di-passing manual.
  botBranding.setBotAvatarURL(client.user.displayAvatarURL());
  connectToVoice();
  startHealthCheck();
  populateExistingVoiceSessions();
  giveawayManager.startScheduler(client);
  // Fitur request musik dari live TikTok ("!request <judul>") -- otomatis
  // nonaktif kalau TIKTOK_USERNAME nggak diisi di .env.
  tiktokLive.init(config.tiktokUsername, async (query, requester) => {
    if (!currentGuildId) {
      log(`[TIKTOK] Request "${query}" dari @${requester} diabaikan, bot belum ready/connect ke voice channel.`);
      return;
    }
    try {
      const channel = await client.channels.fetch(config.voiceChannelId);
      await handleTikTokRequest({ guildId: currentGuildId, channel, client, query, requester, log });
    } catch (err) {
      log(`[TIKTOK] Gagal proses request "${query}" dari @${requester}: ${err?.stack || err}`);
    }
  });
  // Checkpoint berkala biar data voice activity nggak ilang banyak kalau
  // proses crash di tengah sesi panjang.
  setInterval(() => voiceActivity.checkpointAll(), 5 * 60 * 1000);
  // Refresh berkala card "Now Playing" (kalau ada yang lagi kebuka) biar
  // progress bar-nya keliatan jalan, bukan cuma update pas ganti lagu.
  // 15 detik dipilih biar nggak mepet rate limit edit message Discord.
  setInterval(() => {
    if (currentGuildId) refreshNowPlayingCard(currentGuildId);
  }, 15_000);
});

client.on('error', (err) => log(`Client error: ${err.message}`));

process.on('unhandledRejection', (err) => {
  log(`Unhandled rejection: ${err}`);
});

process.on('SIGINT', () => {
  log('Menerima SIGINT, shutting down...');
  shuttingDown = true;
  voiceActivity.checkpointAll();
  if (connection) connection.destroy();
  client.destroy();
  process.exit(0);
});

client.login(config.token);
