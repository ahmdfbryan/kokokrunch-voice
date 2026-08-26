require('dotenv').config();

const required = ['DISCORD_TOKEN', 'VOICE_CHANNEL_ID', 'DISCORD_CLIENT_ID'];
const missing = required.filter((key) => !process.env[key]);

if (missing.length > 0) {
  console.error(`[CONFIG] Environment variable belum diisi: ${missing.join(', ')}`);
  console.error('[CONFIG] Copy .env.example ke .env lalu isi nilainya.');
  process.exit(1);
}

module.exports = {
  token: process.env.DISCORD_TOKEN,
  clientId: process.env.DISCORD_CLIENT_ID,
  voiceChannelId: process.env.VOICE_CHANNEL_ID,
  guildId: process.env.GUILD_ID || null,
  // Jeda sebelum mencoba reconnect setelah terputus (ms)
  reconnectDelayMs: 5000,
  // Interval health check buat mastiin bot masih di voice channel (ms)
  healthCheckIntervalMs: 60_000,
};
