// Fitur "Lirik" di card Now Playing -- ambil lirik lagu yang lagi diputar
// berdasarkan judul track. Judul video YouTube biasanya berantakan (ada
// "(Official Video)", "[Lyrics]", "ft.", dll dan artis+judul digabung jadi
// 1 string).
//
// Coverage 1 sumber lirik doang (lyrics.ovh) ternyata kecil banget -- sering
// "nggak ketemu" padahal lagunya populer, apalagi lagu Indonesia. Makanya di
// sini dipasang 3 SUMBER berurutan (coba 1, kalau gagal/nggak ketemu baru
// lanjut ke berikutnya):
//   1) LRCLIB      -- API lirik gratis (nggak perlu API key).
//   2) Genius       -- database lirik TERBESAR & paling lengkap (termasuk
//                      lagu Indonesia), dicari lewat API search-nya lalu
//                      halaman liriknya di-"scrape" (ambil teks dari HTML).
//   3) lyrics.ovh   -- fallback terakhir, database lebih kecil tapi cepet.
//
// PENTING soal AKURASI (bukan cuma "ketemu apa nggak"): tiap hasil dari
// ketiga sumber di atas WAJIB lolos `isGoodMatch()` dulu sebelum dianggap
// valid -- ini nyegah kasus "lirik ketemu tapi buat lagu yang salah" (misal
// iTunes/Genius nyasar ke lagu lain yang judulnya kebetulan mirip). Kalau
// hasil dari 1 sumber gagal validasi, itu dianggap SAMA kayak "nggak
// ketemu" di sumber itu, lanjut ke sumber berikutnya -- lebih baik bilang
// "nggak ketemu" daripada nampilin lirik lagu yang salah.

const fetch = require('node-fetch');
const cheerio = require('cheerio');
const { EmbedBuilder } = require('discord.js');
const config = require('./config');

const LYRICS_COLOR = 0x5865f2; // biru, senada tema fitur Musik
const MAX_DESC_LENGTH = 3900; // batas aman embed description (limit Discord 4096)
// Genius nolak/curigain request tanpa User-Agent yang kayak browser beneran.
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

let log = console.log;
/** Dipanggil dari index.js biar log fitur ini nyampur sama log bot lainnya (format timestamp dll). */
function setLogger(fn) {
  if (typeof fn === 'function') log = fn;
}

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

// --- Validasi kecocokan hasil pencarian vs judul asli ------------------

function normalizeForCompare(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function wordSet(s) {
  return new Set(normalizeForCompare(s).split(' ').filter(Boolean));
}

/**
 * Berapa persen kata di `candidateTrack` yang juga muncul di `cleanedTitle`
 * (judul video asli). Sengaja cuma ngecek TRACK-nya (bukan artist juga),
 * soalnya banyak judul video yang nggak nyebutin nama artis eksplisit --
 * kalau nama lagunya sendiri aja nggak nyambung ke judul video, hampir
 * pasti itu hasil pencarian yang nyasar ke lagu lain.
 */
function trackNameCoverage(candidateTrack, cleanedTitle) {
  const trackWords = wordSet(candidateTrack);
  if (trackWords.size === 0) return 0;
  const titleWords = wordSet(cleanedTitle);
  let hits = 0;
  for (const w of trackWords) if (titleWords.has(w)) hits += 1;
  return hits / trackWords.size;
}

/**
 * Validasi utama dipanggil sebelum nerima hasil dari sumber manapun.
 * `dashArtistHint` = bagian sebelum tanda "-" di judul asli (kalau ada) --
 * dipakai sebagai pengecekan TAMBAHAN nama artis, khusus buat judul yang
 * emang udah berformat "Artis - Judul" (biar nggak ketuker ke lagu lain
 * yang judulnya kebetulan sama tapi artisnya beda).
 */
function isGoodMatch(candidateArtist, candidateTrack, cleanedTitle, dashArtistHint) {
  if (trackNameCoverage(candidateTrack, cleanedTitle) < 0.6) return false;
  if (dashArtistHint) {
    const artistWords = wordSet(candidateArtist);
    const hintWords = wordSet(dashArtistHint);
    if (artistWords.size > 0 && hintWords.size > 0) {
      let overlap = false;
      for (const w of artistWords) if (hintWords.has(w)) { overlap = true; break; }
      if (!overlap) return false;
    }
  }
  return true;
}

// --- Sumber metadata & lirik ---------------------------------------------

/**
 * Cari metadata lagu resmi (artist + track) dari judul yang udah
 * dibersihin, pakai iTunes Search API (gratis, tanpa API key). Ini CUMA
 * dipakai sebagai kandidat TAMBAHAN buat query yang lebih presisi -- tetap
 * lolos `isGoodMatch()` dulu sebelum dipercaya, soalnya iTunes kadang
 * ngasih hasil yang meleset kalau judul videonya ambigu.
 */
async function lookupItunes(query) {
  const url = `https://itunes.apple.com/search?media=music&entity=song&limit=5&term=${encodeURIComponent(query)}`;
  const res = await withTimeout(fetch(url), 8000, 'iTunes Search');
  if (!res.ok) return null;
  const data = await res.json();
  const hit = (data?.results || []).find((r) => r.artistName && r.trackName);
  if (!hit) return null;
  return { artist: hit.artistName, track: hit.trackName };
}

/**
 * SUMBER 1: LRCLIB. Coba `/api/get` (presisi, butuh artist+track terpisah)
 * dulu pakai tiap kandidat exact yang ada, baru fallback ke `/api/search`
 * (full-text) pakai judul yang udah dibersihin -- hasil `/api/search`
 * diambil hit PERTAMA yang lolos validasi (bukan asal ambil hit teratas).
 */
async function fetchFromLrclib(cleanedTitle, dashArtistHint, exactCandidates) {
  for (const cand of exactCandidates) {
    try {
      const url = `https://lrclib.net/api/get?artist_name=${encodeURIComponent(cand.artist)}&track_name=${encodeURIComponent(cand.track)}`;
      const res = await withTimeout(fetch(url), 8000, 'LRCLIB');
      if (res.ok) {
        const data = await res.json();
        const lyrics = (data?.plainLyrics || '').trim();
        const artist = data.artistName || cand.artist;
        const track = data.trackName || cand.track;
        if (lyrics && isGoodMatch(artist, track, cleanedTitle, dashArtistHint)) return { lyrics, artist, track };
      }
    } catch {
      // coba kandidat berikutnya
    }
  }

  const url = `https://lrclib.net/api/search?q=${encodeURIComponent(cleanedTitle)}`;
  const res = await withTimeout(fetch(url), 8000, 'LRCLIB');
  if (!res.ok) throw new Error(`LRCLIB error ${res.status}`);
  const results = await res.json();
  if (!Array.isArray(results)) return null;

  for (const r of results) {
    const lyrics = (r.plainLyrics || '').trim();
    if (!lyrics) continue;
    if (isGoodMatch(r.artistName, r.trackName, cleanedTitle, dashArtistHint)) {
      return { lyrics, artist: r.artistName, track: r.trackName };
    }
  }
  return null;
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
    } catch (err) {
      log(`[LYRICS] Genius API resmi gagal buat query "${query}": ${err.message} -- coba endpoint publik.`);
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

/**
 * Coba beberapa VARIAN QUERY berurutan ke Genius (judul asli yang udah
 * dibersihin dulu -- paling lengkap infonya -- baru query lain kalau ada).
 * Tiap hasil pencarian divalidasi `isGoodMatch()` sebelum liriknya
 * di-scrape, biar nggak buang waktu scrape halaman yang ternyata salah.
 */
async function fetchFromGenius(cleanedTitle, dashArtistHint, queries) {
  for (const query of queries) {
    let found;
    try {
      found = await searchGeniusSongUrl(query);
    } catch (err) {
      log(`[LYRICS] Genius search error buat query "${query}": ${err.message}`);
      continue;
    }
    if (!found) {
      log(`[LYRICS] Genius: nggak ada hasil buat query "${query}".`);
      continue;
    }
    if (!isGoodMatch(found.artist, found.track, cleanedTitle, dashArtistHint)) {
      log(`[LYRICS] Genius: hasil "${found.artist} - ${found.track}" ditolak (nggak cocok sama judul "${cleanedTitle}").`);
      continue;
    }
    try {
      const lyrics = await scrapeGeniusLyrics(found.pageUrl);
      if (lyrics) return { lyrics, artist: found.artist, track: found.track };
    } catch (err) {
      log(`[LYRICS] Genius: gagal scrape halaman "${found.pageUrl}": ${err.message}`);
    }
  }
  return null;
}

/**
 * SUMBER 3 (fallback terakhir): lyrics.ovh. Butuh artist+track terpisah,
 * jadi cuma dicoba pakai kandidat exact (dash-split judul / iTunes) yang
 * udah disiapin di `getLyrics()`.
 */
async function fetchFromLyricsOvh(cleanedTitle, dashArtistHint, exactCandidates) {
  for (const { artist, track } of exactCandidates) {
    if (!artist || !track) continue;
    const url = `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(track)}`;
    const res = await withTimeout(fetch(url), 8000, 'Lyrics.ovh');
    if (res.status === 404) continue;
    if (!res.ok) throw new Error(`Lyrics.ovh error ${res.status}`);
    const data = await res.json();
    const lyrics = (data?.lyrics || '').trim();
    if (lyrics && isGoodMatch(artist, track, cleanedTitle, dashArtistHint)) return { lyrics, artist, track };
  }
  return null;
}

/**
 * Entry point utama: terima judul track mentah (biasanya judul video
 * YouTube), balikin `{ ok:true, lyrics, artist, track, source }` atau
 * `{ ok:false, reason }`. Nyoba 3 sumber berurutan (lihat catatan di atas
 * file) -- baru dianggap gagal kalau SEMUANYA nggak nemu hasil yang valid.
 */
async function getLyrics(rawTitle) {
  const cleaned = cleanTitle(rawTitle);
  if (!cleaned) return { ok: false, reason: 'empty_title' };

  // Kandidat artist/track dari format judul asli "Artis - Judul" (dianggap
  // paling bisa dipercaya soalnya diambil LANGSUNG dari judul videonya,
  // bukan tebakan pencarian). Dicoba 2 urutan (artis duluan / judul duluan)
  // soalnya nggak semua channel konsisten formatnya.
  const dashParts = cleaned.split(/\s+-\s+/);
  const dashCandidates =
    dashParts.length === 2
      ? [
          { artist: dashParts[0], track: dashParts[1] },
          { artist: dashParts[1], track: dashParts[0] },
        ]
      : [];
  const dashArtistHint = dashParts.length === 2 ? dashParts[0] : null;

  // iTunes cuma dipakai sebagai kandidat TAMBAHAN (bukan pengganti judul
  // asli) -- tetap harus lolos `isGoodMatch()` di titik pemakaiannya
  // masing-masing, biar nggak nyasar ke lagu lain yang judulnya kebetulan
  // mirip.
  let itunesCandidate = null;
  try {
    itunesCandidate = await lookupItunes(cleaned);
  } catch (err) {
    log(`[LYRICS] iTunes lookup gagal buat "${cleaned}": ${err.message}`);
  }

  const exactCandidates = [...dashCandidates, ...(itunesCandidate ? [itunesCandidate] : [])];
  const geniusQueries = [cleaned, ...(itunesCandidate ? [`${itunesCandidate.artist} ${itunesCandidate.track}`] : [])];

  const sources = [
    { name: 'LRCLIB', run: () => fetchFromLrclib(cleaned, dashArtistHint, exactCandidates) },
    { name: 'Genius', run: () => fetchFromGenius(cleaned, dashArtistHint, geniusQueries) },
    { name: 'Lyrics.ovh', run: () => fetchFromLyricsOvh(cleaned, dashArtistHint, exactCandidates) },
  ];

  let lastError = null;
  for (const source of sources) {
    try {
      const found = await source.run();
      if (found?.lyrics) return { ok: true, ...found, source: source.name };
    } catch (err) {
      log(`[LYRICS] Sumber ${source.name} error buat "${cleaned}": ${err.message}`);
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

module.exports = { getLyrics, cleanTitle, buildLyricsEmbed, setLogger, isGoodMatch };
