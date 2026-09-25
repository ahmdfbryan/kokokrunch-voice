// Fitur "Lirik" di card Now Playing -- ambil lirik lagu yang lagi diputar
// berdasarkan judul track. Judul video YouTube biasanya berantakan (ada
// "(Official Video)", "[Lyrics]", "ft.", dll dan artis+judul digabung jadi
// 1 string).
//
// Coverage 1 sumber lirik doang (lyrics.ovh) ternyata kecil banget -- sering
// "nggak ketemu" padahal lagunya populer, apalagi lagu Indonesia. Makanya di
// sini dipasang 3 SUMBER berurutan (coba 1, kalau gagal/nggak ketemu baru
// lanjut ke berikutnya), biar peluang liriknya ketemu jauh lebih besar buat
// hampir semua lagu:
//   1) LRCLIB      -- API lirik gratis (nggak perlu API key), database-nya
//                      dikumpulin dari banyak sumber & lumayan lengkap buat
//                      lagu lokal maupun barat.
//   2) Genius       -- database lirik TERBESAR & paling lengkap (termasuk
//                      lagu Indonesia/dangdut/religi dll), tapi Genius nggak
//                      nyediain API lirik publik resmi, jadi di sini dicari
//                      lewat endpoint search bawaan situsnya lalu halaman
//                      liriknya di-"scrape" (ambil teks dari HTML-nya).
//   3) lyrics.ovh   -- fallback terakhir, database lebih kecil tapi cepet &
//                      simpel, jaga-jaga kalau 2 sumber di atas lagi down.

const fetch = require('node-fetch');
const cheerio = require('cheerio');
const { EmbedBuilder } = require('discord.js');
const config = require('./config');

const LYRICS_COLOR = 0x5865f2; // biru, senada tema fitur Musik
const MAX_DESC_LENGTH = 3900; // batas aman embed description (limit Discord 4096)
// Genius nolak/curigain request tanpa User-Agent yang kayak browser beneran.
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const JUNK_PATTERNS = [
  /\((?:official\s*)?(?:music\s*)?video\)/gi,
  /\[(?:official\s*)?(?:music\s*)?video\]/gi,
  /\(official\s*audio\)/gi,
  /\[official\s*audio\]/gi,
  /\((?:lyrics?|lyric\s*video)\)/gi,
  /\[(?:lyrics?|lyric\s*video)\]/gi,
  /\[\s*(?:hd|4k|mv)\s*\]/gi,
  /\(\s*(?:hd|4k|mv)\s*\)/gi,
  /\b(?:hd|4k)\b/gi,
  /\bofficial\s+(?:music\s+)?video\b/gi,
  /\bofficial\s+audio\b/gi,
  /\blyrics?\s+video\b/gi,
  /\blyrics?\b/gi,
  /\(.*?remaster\w*.*?\)/gi,
  /\bfeat\.?\s.+$/gi,
  /\bft\.?\s.+$/gi,
];

function withTimeout(promise, ms, label) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} tidak merespons dalam ${ms / 1000} detik.`)), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

function cleanTitle(rawTitle) {
  let cleaned = rawTitle || '';
  for (const pattern of JUNK_PATTERNS) cleaned = cleaned.replace(pattern, ' ');
  return cleaned.replace(/\s+/g, ' ').trim();
}

/**
 * Cari metadata lagu resmi (artist + track) yang paling cocok dari judul
 * yang udah dibersihin, pakai iTunes Search API (gratis, tanpa API key).
 * Dipakai buat query yang lebih presisi ke sumber lirik lain di bawah.
 */
async function lookupItunes(query) {
  const url = `https://itunes.apple.com/search?media=music&entity=song&limit=1&term=${encodeURIComponent(query)}`;
  const res = await withTimeout(fetch(url), 8000, 'iTunes Search');
  if (!res.ok) return null;
  const data = await res.json();
  const hit = data?.results?.[0];
  if (!hit || !hit.artistName || !hit.trackName) return null;
  return { artist: hit.artistName, track: hit.trackName };
}

/**
 * SUMBER 1: LRCLIB. Coba `/api/get` (presisi, butuh artist+track terpisah)
 * dulu kalau ada hasil normalisasi iTunes, baru fallback ke `/api/search`
 * (full-text, cukup 1 string bebas) pakai judul yang udah dibersihin.
 */
async function fetchFromLrclib(cleanedTitle, normalized) {
  if (normalized) {
    try {
      const url = `https://lrclib.net/api/get?artist_name=${encodeURIComponent(normalized.artist)}&track_name=${encodeURIComponent(normalized.track)}`;
      const res = await withTimeout(fetch(url), 8000, 'LRCLIB');
      if (res.ok) {
        const data = await res.json();
        const lyrics = (data?.plainLyrics || '').trim();
        if (lyrics) return { lyrics, artist: data.artistName || normalized.artist, track: data.trackName || normalized.track };
      }
    } catch {
      // lanjut ke pencarian full-text di bawah
    }
  }

  const url = `https://lrclib.net/api/search?q=${encodeURIComponent(cleanedTitle)}`;
  const res = await withTimeout(fetch(url), 8000, 'LRCLIB');
  if (!res.ok) throw new Error(`LRCLIB error ${res.status}`);
  const results = await res.json();
  const hit = Array.isArray(results) ? results.find((r) => (r.plainLyrics || '').trim()) : null;
  if (!hit) return null;
  return { lyrics: hit.plainLyrics.trim(), artist: hit.artistName, track: hit.trackName };
}

/**
 * SUMBER 2: Genius (via scraping). Genius nggak punya API lirik publik
 * resmi (lirik LENGKAP nggak boleh dikasih lewat API karena lisensi), tapi
 * database judul lagunya lengkap banget -- jadi kita cuma pakai API/search
 * Genius buat NEMUIN halaman lagunya, terus lirik teksnya diambil langsung
 * dari HTML halaman itu (elemen `[data-lyrics-container="true"]`).
 *
 * Ada 2 cara nyari halaman lagunya:
 *   a) API resmi `api.genius.com/search` -- butuh token gratis (isi
 *      GENIUS_ACCESS_TOKEN di .env, daftar di genius.com/api-clients),
 *      hasilnya jauh lebih AKURAT & jarang diblokir dibanding cara (b).
 *   b) Endpoint pencarian situsnya sendiri `genius.com/api/search/multi`
 *      -- nggak butuh token, tapi kadang diblokir/dianggap bot kalau
 *      requestnya dari IP VPS/datacenter. Dipakai sebagai fallback kalau
 *      token nggak diisi, atau cara (a) gagal.
 */
async function searchGeniusOfficial(query, token) {
  const url = `https://api.genius.com/search?q=${encodeURIComponent(query)}`;
  const res = await withTimeout(fetch(url, { headers: { Authorization: `Bearer ${token}` } }), 8000, 'Genius API');
  if (!res.ok) throw new Error(`Genius API error ${res.status}`);
  const data = await res.json();
  const hits = data?.response?.hits || [];
  const hit = (hits.find((h) => h.type === 'song') || hits[0])?.result;
  if (!hit?.url) return null;
  return { pageUrl: hit.url, artist: hit.primary_artist?.name, track: hit.title };
}

async function searchGeniusUnofficial(query) {
  const url = `https://genius.com/api/search/multi?q=${encodeURIComponent(query)}`;
  const res = await withTimeout(
    fetch(url, { headers: { 'User-Agent': BROWSER_USER_AGENT, Accept: 'application/json' } }),
    8000,
    'Genius Search'
  );
  if (!res.ok) throw new Error(`Genius search error ${res.status}`);
  const data = await res.json();
  const sections = data?.response?.sections || [];
  const songSection = sections.find((s) => s.type === 'song');
  const hit = songSection?.hits?.[0]?.result;
  if (!hit?.url) return null;
  return { pageUrl: hit.url, artist: hit.primary_artist?.name, track: hit.title };
}

async function searchGeniusSongUrl(query) {
  if (config.geniusAccessToken) {
    try {
      const found = await searchGeniusOfficial(query, config.geniusAccessToken);
      if (found) return found;
    } catch {
      // Token invalid/expired/Genius API lagi gangguan -- tetep coba cara
      // tanpa token di bawah sebelum benar-benar nyerah.
    }
  }
  return searchGeniusUnofficial(query);
}

async function scrapeGeniusLyrics(pageUrl) {
  const res = await withTimeout(
    fetch(pageUrl, { headers: { 'User-Agent': BROWSER_USER_AGENT } }),
    10000,
    'Genius Page'
  );
  if (!res.ok) throw new Error(`Genius page error ${res.status}`);
  const html = await res.text();
  const $ = cheerio.load(html);

  const blocks = [];
  $('div[data-lyrics-container="true"]').each((_, el) => {
    // Ganti <br> jadi newline SEBELUM ambil teks, biar barisnya nggak
    // ke-gabung jadi 1 baris panjang pas .text() dipanggil.
    $(el).find('br').replaceWith('\n');
    blocks.push($(el).text());
  });

  return blocks.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

async function fetchFromGenius(query) {
  const found = await searchGeniusSongUrl(query);
  if (!found) return null;
  const lyrics = await scrapeGeniusLyrics(found.pageUrl);
  if (!lyrics) return null;
  return { lyrics, artist: found.artist, track: found.track };
}

/**
 * SUMBER 3 (fallback terakhir): lyrics.ovh. Butuh artist+track terpisah,
 * jadi kalau nggak ada hasil normalisasi iTunes, coba tebak dari judul yang
 * ada tanda "-" (2 urutan kemungkinan: "A - B" & "B - A").
 */
async function fetchFromLyricsOvh(cleanedTitle, normalized) {
  const candidates = [];
  if (normalized) candidates.push(normalized);
  const dashParts = cleanedTitle.split(/\s+-\s+/);
  if (dashParts.length === 2) {
    candidates.push({ artist: dashParts[0], track: dashParts[1] });
    candidates.push({ artist: dashParts[1], track: dashParts[0] });
  }

  for (const { artist, track } of candidates) {
    if (!artist || !track) continue;
    const url = `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(track)}`;
    const res = await withTimeout(fetch(url), 8000, 'Lyrics.ovh');
    if (res.status === 404) continue;
    if (!res.ok) throw new Error(`Lyrics.ovh error ${res.status}`);
    const data = await res.json();
    if (data?.lyrics?.trim()) return { lyrics: data.lyrics.trim(), artist, track };
  }
  return null;
}

/**
 * Entry point utama: terima judul track mentah (biasanya judul video
 * YouTube), balikin `{ ok:true, lyrics, artist, track, source }` atau
 * `{ ok:false, reason }`. Nyoba 3 sumber berurutan (lihat catatan di atas
 * file) -- baru dianggap gagal kalau SEMUANYA nggak nemu/error.
 */
async function getLyrics(rawTitle) {
  const cleaned = cleanTitle(rawTitle);
  if (!cleaned) return { ok: false, reason: 'empty_title' };

  let normalized = null;
  try {
    normalized = await lookupItunes(cleaned);
  } catch {
    // Gagal/timeout iTunes -- tetep lanjut, sumber lirik masih bisa dicoba
    // pakai judul mentah yang udah dibersihin.
  }
  const searchQuery = normalized ? `${normalized.artist} ${normalized.track}` : cleaned;

  const sources = [
    { name: 'LRCLIB', run: () => fetchFromLrclib(cleaned, normalized) },
    { name: 'Genius', run: () => fetchFromGenius(searchQuery) },
    { name: 'Lyrics.ovh', run: () => fetchFromLyricsOvh(cleaned, normalized) },
  ];

  let lastError = null;
  for (const source of sources) {
    try {
      const found = await source.run();
      if (found?.lyrics) return { ok: true, ...found, source: source.name };
    } catch (err) {
      lastError = err;
    }
  }

  if (lastError) return { ok: false, reason: 'fetch_error' };
  return { ok: false, reason: 'not_found' };
}

/**
 * Embed hasil lirik (atau pesan gagal), dipakai sama tombol "Lirik" di card
 * Now Playing. Dibalas ephemeral -- lirik lagu bisa panjang & personal,
 * jadi nggak perlu numpuk di channel publik kayak leaderboard.
 */
function buildLyricsEmbed(track, result) {
  if (!result.ok) {
    const reasonText = {
      empty_title: 'Judul lagunya nggak kebaca.',
      not_found: `Lirik buat **${track.title}** nggak ketemu di semua sumber yang dicoba.`,
      fetch_error: 'Lagi ada gangguan pas ambil lirik dari semua sumber, coba lagi bentar lagi.',
    }[result.reason] || `Lirik buat **${track.title}** nggak ketemu.`;
    return new EmbedBuilder().setColor(0x99aab5).setDescription(`📭 ${reasonText}`);
  }

  let lyrics = result.lyrics;
  if (lyrics.length > MAX_DESC_LENGTH) {
    lyrics = `${lyrics.slice(0, MAX_DESC_LENGTH)}...\n\n_(lirik dipotong, kepanjangan buat 1 embed)_`;
  }

  return new EmbedBuilder()
    .setColor(LYRICS_COLOR)
    .setAuthor({ name: `🎤  Lirik — ${result.artist} - ${result.track}` })
    .setDescription(lyrics)
    .setFooter({ text: `Lirik via ${result.source}` });
}

module.exports = { getLyrics, cleanTitle, buildLyricsEmbed };
