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
const voiceActivity = require('./voiceActivity');
const stickyMessage = require('./stickyMessage');
const stickyManager = require('./stickyManager');
const giveawayManager = require('./giveawayManager');
const aiChat = require('./aiChat');
const commands = require('./commands');

const EMBED_COLOR = 0x5865f2;

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
let currentGuildId = null;

// Callback dipanggil musicManager pas track baru mulai diputar --
// update status "Now Playing" bot + kirim notifikasi ke channel tempat /play dipanggil.
// opts.silent: true -> skip kirim pesan channel (reply command /play sendiri
// sudah kasih tau), tapi status bot (Activity) tetap di-update seperti biasa.
async function onTrackStart(guildId, track, opts = {}) {
  try {
    client.user.setActivity(track.title, { type: ActivityType.Listening });
  } catch (err) {
    log(`[STATUS] Gagal update activity: ${err.message}`);
  }

  if (opts.silent) return;

  const queue = musicManager.getQueue(guildId);
  if (!queue.textChannelId) return;

  try {
    const channel = await client.channels.fetch(queue.textChannelId);
    const embed = new EmbedBuilder().setColor(EMBED_COLOR).setDescription(`Started playing **${track.title}**`);
    await channel.send({ embeds: [embed] });
  } catch (err) {
    log(`[STATUS] Gagal kirim notifikasi Now Playing ke channel: ${err.message}`);
  }
}

// Callback pas antrian abis -- reset status bot balik netral + kasih tau di
// channel (kecuali dipicu dari /stop, karena reply /stop sendiri udah cukup).
async function onQueueEmpty(guildId, opts = {}) {
  try {
    client.user.setActivity('Standby di voice channel', { type: ActivityType.Custom });
  } catch (err) {
    log(`[STATUS] Gagal reset activity: ${err.message}`);
  }

  if (opts.silent) return;

  const queue = musicManager.getQueue(guildId);
  if (!queue.textChannelId) return;

  try {
    const channel = await client.channels.fetch(queue.textChannelId);
    const embed = new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setDescription('Antrian musik sudah selesai, semua lagu sudah diputar.');
    await channel.send({ embeds: [embed] });
  } catch (err) {
    log(`[STATUS] Gagal kirim notifikasi antrian selesai: ${err.message}`);
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

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

voiceActivity.load();
stickyMessage.load();
stickyManager.init(client, log);

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
        scheduleReconnect();
      }
    });

    connection.on(VoiceConnectionStatus.Destroyed, () => {
      log('Voice connection destroyed.');
      scheduleReconnect();
    });

    connection.on('stateChange', (oldSt, newSt) => {
      log(`Voice connection state: ${oldSt.status} -> ${newSt.status}`);
    });

    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    log(`Berhasil join voice channel: ${channel.name} (${channel.id})`);
    consecutiveFailures = 0; // reset backoff setelah sukses
  } catch (err) {
    consecutiveFailures += 1;
    log(`Gagal connect ke voice channel (percobaan ke-${consecutiveFailures}): ${err.message}`);
    scheduleReconnect();
  } finally {
    reconnecting = false;
  }
}

function scheduleReconnect() {
  if (shuttingDown) return; // jangan reconnect kalau memang lagi sengaja mati

  // Exponential backoff dengan cap 5 menit, supaya kalau memang lagi
  // di-throttle/block Discord, kita nggak makin gencar hammering dan
  // memperparah situasi. Attempt ke-1: 5s, ke-2: 10s, ke-3: 20s, ... maks 300s.
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
    log('Bot terdeteksi keluar/dipindah dari voice channel target, rejoin...');
    scheduleReconnect();
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
    if (interaction.customId !== giveawayManager.JOIN_BUTTON_ID) return;
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
    const answer = await aiChat.chatReply(message.author.id, question);
    const chunks = aiChat.splitIntoChunks(answer);

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
