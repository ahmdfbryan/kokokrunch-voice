# Voice Keeper Bot

Bot Discord yang join dan bertahan 24/7 di satu voice channel tertentu, dengan auto-reconnect kalau terputus.

Voice channel target (default): `1542046529299152938`

## Cara Kerja

- Bot join ke voice channel yang ditentukan di `.env`
- Memainkan "silent audio" (PCM kosong) terus-menerus supaya Discord voice connection tidak dianggap idle
- Kalau koneksi voice putus (network drop, restart, dsb), bot otomatis reconnect setelah 5 detik
- Health check tiap 60 detik untuk mastiin bot masih ada di channel target — kalau ternyata sudah tidak ada (misal di-disconnect manual oleh admin/user), bot otomatis rejoin

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Copy `.env.example` jadi `.env`, lalu isi:
   ```
   DISCORD_TOKEN=token_bot_kamu
   VOICE_CHANNEL_ID=1542046529299152938
   ```

3. **Penting — Bot Permissions & Intents:**
   - Di [Discord Developer Portal](https://discord.com/developers/applications) > aplikasi bot kamu > **Bot** tab, aktifkan intent **Server Members Intent** kalau belum (opsional untuk fitur ini, tapi umumnya dipakai bot lain kamu juga)
   - Invite bot ke server dengan permission minimal: **View Channel**, **Connect**, **Speak** di voice channel target

4. Jalankan:
   ```bash
   node index.js
   ```

## Deploy 24/7 dengan PM2 (VPS)

```bash
npm install -g pm2   # kalau belum ada
pm2 start ecosystem.config.js
pm2 save
pm2 startup          # supaya PM2 auto-start saat VPS reboot, ikuti instruksi yang muncul
```

Cek log:
```bash
pm2 logs voice-keeper-bot
```

Restart manual:
```bash
pm2 restart voice-keeper-bot
```

## Catatan

- Bot **tidak** benar-benar mengeluarkan suara apa pun (silent), jadi member lain di voice channel tidak akan dengar apa-apa dari bot ini — bot cuma "nangkring" di list voice.
- Kalau nanti channel ID target berubah, cukup update `VOICE_CHANNEL_ID` di `.env` lalu restart (`pm2 restart voice-keeper-bot`).
- Kalau butuh bot ini join lebih dari 1 voice channel sekaligus (misal beberapa server), butuh instance terpisah per channel — voice connection Discord.js dibatasi 1 per guild per proses koneksi gateway yang sama, tapi bisa multi-guild kalau logic-nya di-generalize (bilang aja kalau butuh ini).
