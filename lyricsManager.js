// Fitur "Lirik" di card Now Playing -- ambil lirik lagu yang lagi diputar
// berdasarkan judul track. Judul video YouTube biasanya berantakan (ada
// "(Official Video)", "[Lyrics]", "ft.", dll dan artis+judul digabung jadi
// 1 string), jadi alurnya:
//   1) Bersihin judul dari embel-embel non-musik.
//   2) Normalisasi ke pasangan artist+track yang bener lewat iTunes Search
//      API (gratis, tanpa API key) -- ini paling akurat soalnya database
//      metadata musiknya resmi.
//   3) Ambil teks liriknya dari lyrics.ovh (gratis, tanpa API key) pakai
//      artist+track hasil normalisasi. Kalau nggak ketemu, fallback coba
//      pecah manual dari tanda "-" di judul (2 urutan: "A - B" & "B - A").

const fetch = require('node-fetch');
const { EmbedBuilder } = require('discord.js');

const LYRICS_COLOR = 0x5865f2; // biru, senada tema fitur Musik
const MAX_DESC_LENGTH = 3900; // batas aman embed description (limit Discord 4096)

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
 * yang udah dibersihin, pakai iTunes Search API.
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

async function fetchLyricsOvh(artist, track) {
  const url = `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(track)}`;
  const res = await withTimeout(fetch(url), 8000, 'Lyrics.ovh');
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Lyrics.ovh error ${res.status}`);
  const data = await res.json();
  return data?.lyrics ? data.lyrics.trim() : null;
}

/**
 * Entry point utama: terima judul track mentah (biasanya judul video
 * YouTube), balikin `{ ok:true, lyrics, artist, track }` atau
 * `{ ok:false, reason }`.
 */
async function getLyrics(rawTitle) {
  const cleaned = cleanTitle(rawTitle);
  if (!cleaned) return { ok: false, reason: 'empty_title' };

  const candidates = [];

  try {
    const normalized = await lookupItunes(cleaned);
    if (normalized) candidates.push(normalized);
  } catch {
    // Gagal/timeout iTunes -- tetep lanjut ke fallback manual di bawah.
  }

  const dashParts = cleaned.split(/\s+-\s+/);
  if (dashParts.length === 2) {
    candidates.push({ artist: dashParts[0], track: dashParts[1] });
    candidates.push({ artist: dashParts[1], track: dashParts[0] });
  }

  if (candidates.length === 0) return { ok: false, reason: 'no_candidate' };

  let lastError = null;
  for (const { artist, track } of candidates) {
    if (!artist || !track) continue;
    try {
      const lyrics = await fetchLyricsOvh(artist, track);
      if (lyrics) return { ok: true, lyrics, artist, track };
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
      no_candidate: `Nggak nemu nama artis/judul yang jelas dari **${track.title}**.`,
      not_found: `Lirik buat **${track.title}** nggak ketemu.`,
      fetch_error: 'Lagi ada gangguan pas ambil lirik, coba lagi bentar lagi.',
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
    .setFooter({ text: 'Lirik via lyrics.ovh' });
}

module.exports = { getLyrics, cleanTitle, buildLyricsEmbed };
