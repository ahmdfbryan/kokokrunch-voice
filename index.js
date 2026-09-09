const dns = require('dns');
// Fix umum untuk error "operation was aborted" saat connect voice di VPS:
// Node 18+ default prefer IPv6 (Happy Eyeballs), tapi banyak VPS punya routing
// IPv6 yang rusak untuk UDP voice server Discord walau HTTPS/WSS biasa tetap normal.
// Paksa resolusi DNS IPv4 dulu supaya voice connection nggak nyangkut di IPv6 yang mati.
dns.setDefaultResultOrder('ipv4first');

const { Client, GatewayIntentBits, ActivityType, EmbedBuilder } = require('discord.js');
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
const { buildNowPlayingCard, cycleLoopMode, withNowPlayingLock } = require('./nowPlayingCard');
const voiceActivity = require('./voiceActivity');
const stickyMessage = require('./stickyMessage');
const stickyManager = require('./stickyManager');
const { handlePrefixCommand } = require('./prefixCommands');
const giveawayManager = require('./giveawayManager');
const aiChat = require('./aiChat');
const aiTools = require('./aiTools');
const commands = require('./commands');

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

// Card "Now Playing" dibuat "nempel" ke bawah chat kayak sticky message:
// kalau ada chat baru numpuk di atasnya, card-nya dipindah (hapus + kirim
// ulang) ke posisi paling bawah lagi. Pakai debounce biar nggak spam
// delete+send tiap 1 pesan kalau chat lagi rame.
const NP_REPOSITION_DEBOUNCE_MS = 3000;
const NP_REPOSITION_MAX_WAIT_MS = 15_000;
const npRepositionTimers = new Map(); // guildId -> { debounceTimeout, maxTimeout }
// Selama guildId ada di sini, SEMUA messageCreate diabaikan buat guild itu --
// ini nyegah pesan hasil kirim-ulang kita sendiri kedetect balik sebagai
// "chat baru" (yang kalau dibiarin bikin loop kedip-kedip terus-terusan).
const npRepositioningInFlight = new Set();

function scheduleNowPlayingReposition(guildId) {
  if (!musicManager.getNowPlayingMessage(guildId)) return;

  let entry = npRepositionTimers.get(guildId);
  if (!entry) {
    entry = { debounceTimeout: null, maxTimeout: null };
    npRepositionTimers.set(guildId, entry);
    entry.maxTimeout = setTimeout(() => repositionNowPlayingCard(guildId), NP_REPOSITION_MAX_WAIT_MS);
  }

  if (entry.debounceTimeout) clearTimeout(entry.debounceTimeout);
  entry.debounceTimeout = setTimeout(() => repositionNowPlayingCard(guildId), NP_REPOSITION_DEBOUNCE_MS);
}

async function repositionNowPlayingCard(guildId) {
  const entry = npRepositionTimers.get(guildId);
  if (entry) {
    clearTimeout(entry.debounceTimeout);
    clearTimeout(entry.maxTimeout);
    npRepositionTimers.delete(guildId);
  }

  npRepositioningInFlight.add(guildId);
  try {
    await withNowPlayingLock(guildId, async () => {
      // Dicek ULANG di dalam lock (bukan cuma sebelum antri) -- soalnya
      // referensi pesan atau status musik bisa aja udah berubah selagi
      // operasi lain di depan kita dalam antrian masih diproses.
      const npMsg = musicManager.getNowPlayingMessage(guildId);
      if (!npMsg) return;
      if (!musicManager.getQueue(guildId).current) return; // nggak ada musik, nggak usah dipindah

      const channel = await client.channels.fetch(npMsg.channelId);
      try {
        const oldMessage = await channel.messages.fetch(npMsg.messageId);
        await oldMessage.delete();
      } catch {
        // udah kehapus manual / nggak ketemu, aman diabaikan
      }
      const { embed, components } = buildNowPlayingCard(guildId);
      const sentMessage = await channel.send({ embeds: [embed], components });
      musicManager.setNowPlayingMessage(guildId, channel.id, sentMessage.id);
    });
  } finally {
    // Jeda dikit sebelum ngelepas flag -- ngasih waktu event messageCreate
    // buat pesan yang baru aja dikirim (yang bisa nyampe agak telat lewat
    // gateway) biar tetep ke-filter dengan benar, nggak trigger diri sendiri.
    setTimeout(() => npRepositioningInFlight.delete(guildId), 2000);
  }
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

voiceActivity.load();
musicPlaylistStore.load();
stickyMessage.load();
stickyManager.init(client, log);
aiChat.init(log);

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
          await interaction.reply({ content: 'Giveaway ini sudah berakhir atau tidak ditemukan.', ephemeral: true });
          return;
        }
        await interaction.reply({
          content: result.joined
            ? 'Kamu berhasil ikut giveaway ini. Klik lagi tombolnya kalau mau membatalkan.'
            : 'Kamu keluar dari giveaway ini.',
          ephemeral: true,
        });
        await giveawayManager.refreshParticipantCount(interaction.client, interaction.message.id);
      } catch (err) {
        log(`[GIVEAWAY] Error tombol join: ${err?.stack || err}`);
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
        await interaction.reply({ content: 'Cuma yang minta aksi ini yang bisa konfirmasi/batal.', ephemeral: true });
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
          // Transisinya ASYNC (lewat event 'Idle'), jadi nggak langsung
          // di-render ulang di sini -- nanti onTrackStart yang manggil
          // refreshNowPlayingCard() begitu transisinya kelar.
          musicManager.skip(guildId);
          await interaction.deferUpdate();
        } else if (interaction.customId === 'music_stop') {
          musicManager.stop(guildId);
          await interaction.deferUpdate();
          try {
            await interaction.channel.send({
              embeds: [
                new EmbedBuilder()
                  .setColor(EMBED_COLOR)
                  .setDescription(`Musik dihentikan oleh <@${interaction.user.id}>, antrian dikosongkan.`),
              ],
            });
          } catch (err) {
            log(`[MUSIC BUTTON] Gagal kirim notifikasi stop: ${err.message}`);
          }
        } else {
          await interaction.deferUpdate();
        }
      } catch (err) {
        log(`[MUSIC BUTTON] Error di tombol ${interaction.customId}: ${err?.stack || err}`);
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
    await command.execute(interaction, log, commands);
  } catch (err) {
    log(`[COMMAND] Error di /${interaction.commandName}: ${err?.stack || err}`);
    const errorEmbed = new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setDescription('Ada error waktu jalanin command ini. Coba lagi nanti.');
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ embeds: [errorEmbed] }).catch(() => {});
    } else {
      await interaction.reply({ embeds: [errorEmbed], ephemeral: true }).catch(() => {});
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

// Now Playing card: "nempel" ke bawah chat kayak sticky message -- kalau
// ada pesan APAPUN yang numpuk di atasnya (dari user maupun bot, termasuk
// reply command lain kayak "ditambahkan ke antrian"), jadwalin pindahin
// card ke bawah lagi. Cuma pesan card ITU SENDIRI yang di-skip, biar nggak
// trigger reposisi buat dirinya sendiri pas baru aja dikirim ulang.
client.on('messageCreate', (message) => {
  if (!currentGuildId) return;
  if (npRepositioningInFlight.has(currentGuildId)) return;
  const npMsg = musicManager.getNowPlayingMessage(currentGuildId);
  if (!npMsg || npMsg.channelId !== message.channelId) return;
  if (message.id === npMsg.messageId) return;
  scheduleNowPlayingReposition(currentGuildId);
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
    const result = await aiChat.chatReply(message.author.id, question, ctx);

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
  connectToVoice();
  startHealthCheck();
  populateExistingVoiceSessions();
  giveawayManager.startScheduler(client);
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
