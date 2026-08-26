const dns = require('dns');
// Fix umum untuk error "operation was aborted" saat connect voice di VPS:
// Node 18+ default prefer IPv6 (Happy Eyeballs), tapi banyak VPS punya routing
// IPv6 yang rusak untuk UDP voice server Discord walau HTTPS/WSS biasa tetap normal.
// Paksa resolusi DNS IPv4 dulu supaya voice connection nggak nyangkut di IPv6 yang mati.
dns.setDefaultResultOrder('ipv4first');

const { Client, GatewayIntentBits } = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
} = require('@discordjs/voice');

const config = require('./config');
const { createSilentAudioStream } = require('./silentStream');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

let connection = null;
let player = null;
let reconnecting = false;
let shuttingDown = false;

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function connectToVoice() {
  if (reconnecting) return;
  reconnecting = true;

  try {
    const channel = await client.channels.fetch(config.voiceChannelId);

    if (!channel || !channel.isVoiceBased()) {
      log(`FATAL: Channel ${config.voiceChannelId} tidak ditemukan atau bukan voice channel.`);
      process.exit(1);
    }

    connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: true, // hemat bandwidth, bot ga perlu denger orang lain
      selfMute: false, // false karena kita justru mau "mainkan" silent audio
    });

    player = createAudioPlayer();
    const resource = createAudioResource(createSilentAudioStream(), {
      inputType: StreamType.Raw,
    });

    player.play(resource);
    connection.subscribe(player);

    player.on('error', (err) => {
      log(`Audio player error: ${err.message}`);
    });

    // Kalau player idle (stream silent putus), buat ulang resource-nya
    player.on(AudioPlayerStatus.Idle, () => {
      log('Audio player idle, membuat ulang silent stream...');
      const newResource = createAudioResource(createSilentAudioStream(), {
        inputType: StreamType.Raw,
      });
      player.play(newResource);
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

    connection.on('error', (err) => {
      log(`Voice connection error: ${err.message}`);
    });

    connection.on('stateChange', (oldSt, newSt) => {
      log(`Voice connection state: ${oldSt.status} -> ${newSt.status}`);
    });

    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    log(`Berhasil join voice channel: ${channel.name} (${channel.id})`);
  } catch (err) {
    log(`Gagal connect ke voice channel: ${err.message}`);
    scheduleReconnect();
  } finally {
    reconnecting = false;
  }
}

function scheduleReconnect() {
  if (shuttingDown) return; // jangan reconnect kalau memang lagi sengaja mati
  log(`Mencoba reconnect dalam ${config.reconnectDelayMs / 1000}s...`);
  setTimeout(() => {
    connectToVoice();
  }, config.reconnectDelayMs);
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

client.once('ready', () => {
  log(`Login sebagai ${client.user.tag}`);
  connectToVoice();
  startHealthCheck();
});

client.on('error', (err) => log(`Client error: ${err.message}`));

process.on('unhandledRejection', (err) => {
  log(`Unhandled rejection: ${err}`);
});

process.on('SIGINT', () => {
  log('Menerima SIGINT, shutting down...');
  shuttingDown = true;
  if (connection) connection.destroy();
  client.destroy();
  process.exit(0);
});

client.login(config.token);