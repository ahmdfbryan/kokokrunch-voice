require('dotenv').config();

const required = ['DISCORD_TOKEN', 'VOICE_CHANNEL_ID', 'DISCORD_CLIENT_ID', 'GEMINI_API_KEY'];
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
  geminiApiKey: process.env.GEMINI_API_KEY,
  // Role yang dianggap "Staff" -- boleh /stop dan /skip musik siapapun,
  // bukan cuma yang minta lagunya sendiri. Bisa di-override lewat .env
  // (STAFF_ROLE_ID) kalau server-nya beda/role-nya ganti nanti.
  staffRoleId: process.env.STAFF_ROLE_ID || '1509608043393061065',
  // "gemini-flash-latest" adalah alias resmi Google yang otomatis nunjuk ke
  // versi Flash terbaru yang stabil -- sengaja TIDAK di-hardcode ke versi
  // spesifik (misal gemini-2.5-flash) karena Google rutin nge-retire versi
  // lama (gemini-2.5-flash sendiri dijadwalkan shutdown Oktober 2026).
  geminiModel: process.env.GEMINI_MODEL || 'gemini-flash-latest',
  // Opsional -- token gratis dari genius.com/api-clients, dipakai fitur
  // "Lirik" di card Now Playing biar pencarian ke Genius (sumber lirik
  // paling lengkap, termasuk lagu Indonesia) jauh lebih akurat & jarang
  // gagal dibanding lewat endpoint publik Genius yang nggak resmi. Kalau
  // dikosongin, fitur Lirik tetap jalan tapi coverage-nya lebih terbatas.
  geniusAccessToken: process.env.GENIUS_ACCESS_TOKEN || null,
  // Opsional -- username TikTok (tanpa "@") buat fitur request musik dari
  // live TikTok ("!request <judul lagu>" di kolom komentar). Kalau
  // dikosongin, fitur ini otomatis nonaktif (nggak ganggu fitur lain).
  tiktokUsername: process.env.TIKTOK_USERNAME || null,
  // Jeda sebelum mencoba reconnect setelah terputus (ms)
  reconnectDelayMs: 5000,
  // Interval health check buat mastiin bot masih di voice channel (ms)
  healthCheckIntervalMs: 60_000,
};
