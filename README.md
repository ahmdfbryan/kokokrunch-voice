# Voice Keeper Bot

Bot Discord yang join dan bertahan 24/7 di satu voice channel tertentu, dengan auto-reconnect kalau terputus — plus fitur **music player** (play dari link YouTube, link Spotify, atau kata kunci judul lagu).

Voice channel target (default): `1542046529299152938`

## Cara Kerja

### Penjaga voice channel
- Bot join ke voice channel yang ditentukan di `.env`
- Kalau nggak ada musik yang diputar, bot mainkan "silent audio" (PCM kosong) terus-menerus supaya Discord voice connection tidak dianggap idle
- Kalau koneksi voice putus (network drop, restart, dsb), bot otomatis reconnect dengan exponential backoff (5s, 10s, 20s, ... maks 5 menit)
- Health check tiap 60 detik untuk mastiin bot masih ada di channel target

### Music player
- `/play <input>` — terima link YouTube, link Spotify (track), atau kata kunci judul lagu. Kalau ada yang lagi diputar, ditambahin ke antrian; kalau kosong, langsung main.
- `/skip` — skip lagu yang lagi diputar, lanjut ke antrian berikutnya
- `/stop` — stop musik dan kosongkan antrian (bot balik ke silent audio, tetap standby di voice channel)
- `/queue` — lihat lagu yang lagi diputar + antrian berikutnya

**Catatan penting soal Spotify:** Spotify nggak nyediain API buat streaming full-track audio (cuma preview 30 detik). Jadi kalau kasih link Spotify, bot bakal baca judul+artis-nya, terus nyariin & muterin lagu yang sama dari YouTube — sama persis kayak cara kerja bot musik populer lainnya. Saat ini cuma support link **track** tunggal, belum support album/playlist Spotify.

**Catatan soal YouTube:** ekstraksi audio pakai **`yt-dlp`** (binary Python, di-install terpisah di server — lihat langkah 3 di bawah), bukan library npm. Ini pilihan sadar: library npm sejenis (`ytdl-core` dan fork-forknya) sering ketinggalan tiap kali YouTube ubah sistem proteksi mereka, sedangkan `yt-dlp` di-update rutin (kadang tiap beberapa hari). Kalau suatu saat `/play` mulai error terus padahal biasanya normal, kemungkinan besar `yt-dlp` di server kamu perlu di-update: `pip install -U yt-dlp --break-system-packages`.

## Setup

1. Install dependencies Node.js:
   ```bash
   npm install
   ```

2. **Install `yt-dlp`** (wajib, dipakai buat ekstrak audio YouTube):
   ```bash
   pip install -U yt-dlp --break-system-packages
   # atau kalau sistem tidak pakai flag itu:
   pip install -U yt-dlp
   ```
   Cek berhasil dengan `yt-dlp --version`. Update berkala (misal sebulan sekali, atau begitu `/play` mulai sering error) dengan command yang sama.

3. Copy `.env.example` jadi `.env`, lalu isi:
   ```
   DISCORD_TOKEN=token_bot_kamu
   DISCORD_CLIENT_ID=application_id_bot_kamu
   VOICE_CHANNEL_ID=1542046529299152938
   GUILD_ID=id_server_kamu
   ```
   `DISCORD_CLIENT_ID` dan `GUILD_ID` ada di Discord Developer Portal > General Information (Application ID) dan dengan klik kanan nama server kamu di Discord (Copy Server ID, aktifkan Developer Mode dulu di Settings > Advanced kalau belum ada opsi ini).

4. **Penting — Bot Permissions & Intents:**
   - Invite bot ke server dengan permission minimal: **View Channel**, **Connect**, **Speak** di voice channel target
   - Invite juga dengan scope `applications.commands` supaya slash command bisa dipakai

5. **Deploy slash command** (wajib dijalankan sekali sebelum `/play` dkk bisa dipakai, dan tiap kali ada command baru/berubah):
   ```bash
   npm run deploy-commands
   ```
   Kalau `GUILD_ID` diisi, command langsung muncul instan. Kalau kosong, command di-deploy global (bisa makan waktu sampai ~1 jam buat muncul).

6. Jalankan:
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

- Kalau nggak ada musik yang diputar, bot **tidak** benar-benar mengeluarkan suara apa pun (silent) — member lain di voice channel tidak akan dengar apa-apa dari bot ini selain pas ada musik yang lagi di-request.
- Kalau nanti channel ID target berubah, cukup update `VOICE_CHANNEL_ID` di `.env` lalu restart (`pm2 restart voice-keeper-bot`).
- Command saat ini dijalankan bebas oleh siapa aja yang bisa akses channel teks-nya (belum ada pembatasan role/permission khusus buat kontrol musik) — kabari kalau butuh fitur itu ditambahin.
