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
- `/play <input>` — terima link YouTube, link Spotify (track), link playlist YouTube, atau kata kunci judul lagu. Kalau ada yang lagi diputar, ditambahin ke antrian; kalau kosong, langsung main.
- `/skip` — skip lagu yang lagi diputar, lanjut ke antrian berikutnya
- `/stop` — stop musik dan kosongkan antrian (bot balik ke silent audio, tetap standby di voice channel). Autoplay otomatis nggak lanjut kalau di-stop manual.
- `/queue` — lihat lagu yang lagi diputar + antrian berikutnya + status autoplay
- `/autoplay <on|off>` — kalau nyala, begitu antrian abis (bukan karena `/stop`), bot otomatis nyari & muterin lagu yang mirip dari lagu terakhir (pakai YouTube Mix), jadi musik nggak berhenti-berhenti. Kalau nggak ketemu lagu mirip / gagal, otomatis fallback ke silent audio biasa.

### Voice activity tracking
- `/voicestats [user]` — lihat total waktu di voice channel, voice streak (hari berturut-turut aktif), streak terpanjang, dan achievement title. Default: diri sendiri.
- `/voiceleaderboard` — top 10 member berdasarkan total waktu voice di server ini.

Tracking berjalan buat **semua voice channel** di server (bukan cuma channel target Satpam Voice), dan otomatis skip bot lain (termasuk bot ini sendiri). Achievement title otomatis berdasarkan total jam:

| Total Jam | Title |
|---|---|
| 1+ | Pendatang Baru |
| 5+ | Anak Nongkrong |
| 20+ | Warga Tetap VC |
| 50+ | Sesepuh Voice |
| 100+ | Legenda Voice |
| 250+ | Voice God |
| 500+ | Penunggu Voice Channel |

Data disimpan di file `data/voiceActivity.json` (bukan database — cukup buat skala 1 server, nggak butuh setup tambahan). File ini otomatis dibuat pas bot pertama kali jalan. **Jangan dihapus manual** kecuali memang mau reset semua data voice activity.

Catatan: kalau bot di-restart sementara ada member yang lagi di voice channel, sesi mereka "dimulai ulang" dari titik restart (bot nggak tau kapan sebenarnya mereka join sebelum itu) — jadi ada sedikit waktu yang nggak kehitung tiap kali restart, tapi ini dampaknya minor untuk pemakaian normal.

**Catatan penting soal Spotify:** Spotify nggak nyediain API buat streaming full-track audio (cuma preview 30 detik). Jadi kalau kasih link Spotify, bot bakal baca judul+artis-nya, terus nyariin & muterin lagu yang sama dari YouTube — sama persis kayak cara kerja bot musik populer lainnya. Saat ini cuma support link **track** tunggal, belum support album/playlist Spotify.

**Catatan soal YouTube:** ekstraksi audio pakai **`yt-dlp`** (binary Python, di-install terpisah di server — lihat langkah 3 di bawah), bukan library npm. Ini pilihan sadar: library npm sejenis (`ytdl-core` dan fork-forknya) sering ketinggalan tiap kali YouTube ubah sistem proteksi mereka, sedangkan `yt-dlp` di-update rutin (kadang tiap beberapa hari). Kalau suatu saat `/play` mulai error terus padahal biasanya normal, kemungkinan besar `yt-dlp` di server kamu perlu di-update: `pip install -U yt-dlp --break-system-packages`.

### Sticky message
- **"Jadikan Sticky"** (klik kanan pesan di Discord → Apps → Jadikan Sticky) — jadiin pesan itu sticky di channel tempat pesan itu berada. Sticky akan otomatis "pindah" ke posisi paling bawah tiap kali ada chat baru masuk.
- `/unsticky` — matikan sticky message di channel ini.

Cara kerja: begitu ada pesan baru masuk ke channel yang punya sticky aktif, bot nunggu jeda 3 detik dulu (nggak ada pesan baru lagi) baru mindahin sticky ke bawah — biar nggak spam delete+kirim kalau chat lagi rame. Tapi kalau chat-nya nggak berhenti-berhenti, sticky tetap dipaksa pindah maksimal tiap 20 detik.

Yang bisa di-sticky: teks biasa dan embed (misal dari bot lain). Kalau pesan aslinya ada gambar attachment, gambarnya ikut ditampilkan di sticky (tapi attachment non-gambar seperti file/dokumen nggak ikut).

Kedua command ini dibatasi cuma buat member yang punya permission **Manage Messages**, biar nggak sembarang orang bisa pasang sticky. Bot sendiri cuma perlu izin **Send Messages** dan **Embed Links** di channel yang mau dipakai — nggak perlu **Manage Messages** di sisi bot, karena bot cuma pernah hapus pesan sticky-nya sendiri, bukan pesan orang lain.

### Giveaway
- `/giveaway create` — mulai giveaway baru (prize, durasi kayak `30m`/`1h`/`2d`/`1h30m`, jumlah pemenang, channel tujuan)
- `/giveaway end` — akhiri giveaway sekarang juga (butuh message ID)
- `/giveaway reroll` — undi ulang pemenang buat giveaway yang udah selesai (butuh message ID)
- `/giveaway list` — lihat semua giveaway aktif di server ini

Member ikutan giveaway lewat tombol **Join Giveaway** di pesan giveaway-nya. Bot otomatis ngecek tiap 15 detik dan nutup giveaway begitu waktunya abis (nggak perlu manual `/giveaway end`, itu cuma buat nutup lebih cepat kalau perlu). Data giveaway kesimpen di `data/giveaways.json`.

Command ini dibatasi buat member yang punya permission **Manage Server**. Bot butuh izin **View Channel**, **Send Messages**, dan **Embed Links** di channel tujuan giveaway.

### AI (Gemini)
- `/ask <pertanyaan>` — tanya sekali ke AI, dapat 1 jawaban (nggak inget percakapan sebelumnya)
- **Mention bot** (`@NamaBot <pesan>`) — ngobrol natural, bot inget konteks percakapan kamu (per-user, direset otomatis kalau nggak ada aktivitas 30 menit)

Kedua cara ini **cuma bisa dipakai di channel voice Satpam Voice** (area chat-nya voice channel `1542046529299152938`), nggak aktif di channel teks lain di server.

Pakai **Google Gemini API** (gratis, model `gemini-flash-latest`). Perlu:
1. API key gratis dari [aistudio.google.com/apikey](https://aistudio.google.com/apikey) (nggak perlu kartu kredit), diisi ke `GEMINI_API_KEY` di `.env`
2. **Message Content Intent** diaktifkan di Discord Developer Portal → aplikasi bot kamu → tab **Bot** → toggle **"Message Content Intent"** ON (dibutuhkan buat baca isi pesan pas fitur mention-chat)

Catatan: nggak ada rate limit dari sisi bot (sesuai request kamu), cuma mengandalkan limit alami dari Gemini free tier (sekitar 1.500 request/hari). Kalau ke depannya voice channel makin rame dan mulai kepentok limit itu, kabarin aja buat ditambahin rate limit per-user.

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
