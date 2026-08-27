const { YouTube } = require('youtube-sr');
const fetch = require('node-fetch');
const { getPreview } = require('spotify-url-info')(fetch);
const ytdlp = require('./ytdlp');

const YOUTUBE_URL_REGEX = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be|music\.youtube\.com)\/.+$/i;
const SPOTIFY_URL_REGEX = /^(https?:\/\/)?(open\.spotify\.com)\/.+$/i;
// Link playlist: ada param list=, TAPI nggak ada v= (video spesifik) atau
// youtu.be (short link video). Kalau ada v=/youtu.be, anggap user emang
// mau lagu itu doang walau linknya kebetulan nyangkut list= dari konteks
// playlist yang lagi diputer di YouTube.
const PLAYLIST_LIST_PARAM_REGEX = /[?&]list=([a-zA-Z0-9_-]+)/;
const HAS_SPECIFIC_VIDEO_REGEX = /[?&]v=|youtu\.be\//i;

function isPlaylistUrl(url) {
  return PLAYLIST_LIST_PARAM_REGEX.test(url) && !HAS_SPECIFIC_VIDEO_REGEX.test(url);
}

/**
 * Cari 1 video YouTube paling relevan dari kata kunci teks.
 */
async function searchYouTube(query) {
  const result = await YouTube.searchOne(query, 'video', false);
  if (!result) return null;
  return {
    title: result.title || query,
    url: `https://www.youtube.com/watch?v=${result.id}`,
    durationText: result.durationFormatted || null,
    durationSeconds: result.duration ? Math.floor(result.duration / 1000) : null,
    thumbnail: result.thumbnail?.url || null,
  };
}

/**
 * Ambil metadata video langsung dari link YouTube.
 */
async function resolveYouTubeUrl(url) {
  return ytdlp.getInfo(url);
}

/**
 * Link Spotify (track) -> baca judul+artis via metadata publik Spotify,
 * lalu dicariin lagunya yang sepadan di YouTube (karena Spotify nggak
 * nyediain API buat streaming full-track audio).
 */
async function resolveSpotifyUrl(url) {
  const preview = await getPreview(url);
  if (!preview || preview.type !== 'track') {
    throw new Error('Link Spotify ini bukan link lagu (track) tunggal. Album/playlist belum didukung.');
  }
  const query = `${preview.artist} - ${preview.track}`;
  const found = await searchYouTube(query);
  if (!found) {
    throw new Error(`Nggak ketemu lagu yang cocok di YouTube buat "${query}".`);
  }
  found.title = `${preview.track} - ${preview.artist}`; // tampilkan judul asli Spotify
  found.sourceNote = 'via Spotify';
  return found;
}

/**
 * Ambil semua track dari link playlist YouTube. Dibatasin maksimal
 * `maxTracks` biar playlist raksasa nggak bikin antrian meledak / proses
 * extract kelamaan.
 */
async function resolvePlaylist(url, maxTracks = 100) {
  const entries = await ytdlp.getPlaylistInfo(url, maxTracks);
  if (entries.length === 0) {
    throw new Error('Playlist ini kosong atau nggak bisa diakses (mungkin private).');
  }
  return entries;
}

/**
 * Entry point utama: terima input mentah dari user (bisa link atau kata
 * kunci bebas), balikin metadata track yang siap diputar.
 */
async function resolveTrack(input) {
  const trimmed = input.trim();

  if (YOUTUBE_URL_REGEX.test(trimmed)) {
    return resolveYouTubeUrl(trimmed);
  }

  if (SPOTIFY_URL_REGEX.test(trimmed)) {
    return resolveSpotifyUrl(trimmed);
  }

  // Bukan link -> anggap kata kunci pencarian, cari di YouTube
  const found = await searchYouTube(trimmed);
  if (!found) {
    throw new Error(`Nggak ketemu hasil buat "${trimmed}".`);
  }
  return found;
}

module.exports = { resolveTrack, isPlaylistUrl, resolvePlaylist };
