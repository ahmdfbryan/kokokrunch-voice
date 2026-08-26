const ytdl = require('@distube/ytdl-core');
const { YouTube } = require('youtube-sr');
const fetch = require('node-fetch');
const { getPreview } = require('spotify-url-info')(fetch);

const YOUTUBE_URL_REGEX = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be|music\.youtube\.com)\/.+$/i;
const SPOTIFY_URL_REGEX = /^(https?:\/\/)?(open\.spotify\.com)\/.+$/i;

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
    thumbnail: result.thumbnail?.url || null,
  };
}

/**
 * Ambil metadata video langsung dari link YouTube.
 */
async function resolveYouTubeUrl(url) {
  const info = await ytdl.getBasicInfo(url);
  const details = info.videoDetails;
  return {
    title: details.title,
    url: details.video_url,
    durationText: formatDuration(Number(details.lengthSeconds)),
    thumbnail: details.thumbnails?.[0]?.url || null,
  };
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

function formatDuration(totalSeconds) {
  if (!totalSeconds || Number.isNaN(totalSeconds)) return null;
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  const mm = String(m).padStart(h > 0 ? 2 : 1, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
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

module.exports = { resolveTrack };
