// Function calling: daftar "tools" yang boleh dipanggil AI berdasarkan
// natural language user, plus eksekusi aksinya beneran ke musicManager dkk.
// Aksi yang berpotensi ganggu banyak orang (stop musik, volume ekstrem)
// nggak langsung dieksekusi -- diminta konfirmasi dulu lewat tombol.

const TOOL_DECLARATIONS = [
  {
    name: 'play_music',
    description:
      'Putar atau tambahkan lagu ke antrian musik di voice channel. Bisa pakai link YouTube/Spotify (termasuk link playlist) atau kata kunci judul lagu.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Link lagu/playlist, atau kata kunci judul lagu yang mau diputar' },
      },
      required: ['query'],
    },
  },
  {
    name: 'skip_track',
    description: 'Skip lagu yang lagi diputar sekarang, lanjut ke lagu berikutnya di antrian.',
    parametersJsonSchema: { type: 'object', properties: {} },
  },
  {
    name: 'stop_music',
    description:
      'Hentikan musik dan KOSONGKAN SELURUH ANTRIAN. Ini aksi besar yang mempengaruhi semua orang yang lagi dengerin di voice channel, bukan cuma yang minta.',
    parametersJsonSchema: { type: 'object', properties: {} },
  },
  {
    name: 'pause_music',
    description: 'Jeda musik yang lagi diputar (bisa dilanjutkan lagi nanti).',
    parametersJsonSchema: { type: 'object', properties: {} },
  },
  {
    name: 'resume_music',
    description: 'Lanjutkan musik yang lagi dijeda.',
    parametersJsonSchema: { type: 'object', properties: {} },
  },
  {
    name: 'set_volume',
    description: 'Atur volume musik dalam persen (0 = mute, 100 = normal, maksimal 200).',
    parametersJsonSchema: {
      type: 'object',
      properties: { percent: { type: 'number', description: 'Volume dalam persen, dari 0 sampai 200' } },
      required: ['percent'],
    },
  },
  {
    name: 'get_queue_info',
    description: 'Lihat lagu yang lagi diputar sekarang dan daftar antrian musik berikutnya.',
    parametersJsonSchema: { type: 'object', properties: {} },
  },
  {
    name: 'save_playlist',
    description:
      'Simpan antrian musik yang lagi jalan sekarang (lagu yang lagi main + semua yang ngantri) jadi playlist pribadi milik user yang minta.',
    parametersJsonSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Nama buat playlist yang disimpan' } },
      required: ['name'],
    },
  },
  {
    name: 'play_playlist',
    description: 'Putar playlist pribadi tersimpan milik user yang minta -- tambahkan semua lagunya ke antrian.',
    parametersJsonSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Nama playlist tersimpan yang mau diputar' } },
      required: ['name'],
    },
  },
  {
    name: 'set_loop_mode',
    description:
      'Atur mode pengulangan musik: "off" (mati), "track" (ulang lagu yang lagi diputar terus-menerus), atau "queue" (ulang seluruh antrian setelah abis).',
    parametersJsonSchema: {
      type: 'object',
      properties: { mode: { type: 'string', enum: ['off', 'track', 'queue'], description: 'Mode loop yang diinginkan' } },
      required: ['mode'],
    },
  },
  {
    name: 'set_autoplay',
    description:
      'Nyalakan atau matikan autoplay -- kalau nyala, begitu antrian abis, bot otomatis nyari & muterin lagu yang mirip dari lagu terakhir.',
    parametersJsonSchema: {
      type: 'object',
      properties: { enabled: { type: 'boolean', description: 'true buat nyalain, false buat matiin' } },
      required: ['enabled'],
    },
  },
  {
    name: 'show_now_playing',
    description: 'Tampilkan card interaktif Now Playing yang nunjukkin lagu yang lagi diputar beserta tombol kontrolnya.',
    parametersJsonSchema: { type: 'object', properties: {} },
  },
  {
    name: 'add_to_playlist',
    description:
      'Tambahkan satu atau lebih link lagu ke playlist pribadi milik user yang minta (bikin playlist baru kalau namanya belum ada, atau nambah ke yang udah ada).',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Nama playlist' },
        links: { type: 'array', items: { type: 'string' }, description: 'Daftar link YouTube/Spotify yang mau ditambahkan' },
      },
      required: ['name', 'links'],
    },
  },
  {
    name: 'list_playlists',
    description: 'Lihat semua playlist pribadi tersimpan milik user yang minta, beserta jumlah lagunya.',
    parametersJsonSchema: { type: 'object', properties: {} },
  },
  {
    name: 'delete_playlist',
    description: 'Hapus playlist pribadi tersimpan milik user yang minta.',
    parametersJsonSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Nama playlist yang mau dihapus' } },
      required: ['name'],
    },
  },
];

/**
 * Aksi yang dianggap "besar" / berpotensi ganggu banyak orang -- nggak
 * langsung dieksekusi, tapi diminta konfirmasi user dulu lewat tombol.
 */
function isSensitive(toolName, args) {
  if (toolName === 'stop_music') return true;
  if (toolName === 'set_volume') {
    const percent = Number(args?.percent);
    return Number.isFinite(percent) && (percent === 0 || percent > 150);
  }
  return false;
}

/**
 * Deskripsi singkat 1 aksi buat ditampilin di pesan konfirmasi, misal
 * "menghentikan musik dan mengosongkan antrian".
 */
function describeAction(toolName, args) {
  switch (toolName) {
    case 'stop_music':
      return 'menghentikan musik dan mengosongkan antrian';
    case 'set_volume':
      return `mengatur volume ke ${args?.percent}%`;
    default:
      return toolName;
  }
}

/**
 * Beneran eksekusi 1 tool call. `ctx` = { guildId, channelId, userId,
 * userTag, client }. Balikin { success, message } -- message dipakai buat
 * dikasih tau balik ke Gemini (function response) ATAU ditampilin langsung
 * kalau abis dikonfirmasi user.
 */
async function executeTool(toolName, args, ctx) {
  const { guildId, channelId, userId, userTag, client } = ctx;
  const musicManager = require('./musicManager');
  const { resolveTrack, isPlaylistUrl, resolvePlaylist } = require('./trackResolver');
  const { claimNowPlayingCard } = require('./nowPlayingCard');
  const playlistStore = require('./musicPlaylistStore');
  const permissions = require('./permissions');

  try {
    switch (toolName) {
      case 'play_music': {
        const query = String(args?.query || '').trim();
        if (!query) return { success: false, message: 'Nggak ada judul lagu/link yang disebutin.' };

        musicManager.setTextChannel(guildId, channelId);

        if (isPlaylistUrl(query)) {
          const tracks = await resolvePlaylist(query, 100);
          tracks.forEach((t) => {
            t.requestedBy = userTag;
            t.requestedById = userId;
          });
          const { startedImmediately } = musicManager.enqueueMany(guildId, tracks);
          if (startedImmediately) {
            const channel = await client.channels.fetch(channelId);
            await claimNowPlayingCard(guildId, client, (embed, components) =>
              channel.send({ embeds: [embed], components })
            );
          }
          return { success: true, message: `${tracks.length} lagu dari playlist ditambahkan ke antrian.` };
        }

        const track = await resolveTrack(query);
        track.requestedBy = userTag;
        track.requestedById = userId;
        const { startedImmediately } = musicManager.enqueue(guildId, track);
        if (startedImmediately) {
          const channel = await client.channels.fetch(channelId);
          await claimNowPlayingCard(guildId, client, (embed, components) =>
            channel.send({ embeds: [embed], components })
          );
          return { success: true, message: `Sekarang memutar "${track.title}".` };
        }
        return { success: true, message: `"${track.title}" ditambahkan ke antrian.` };
      }

      case 'skip_track': {
        const queue = musicManager.getQueue(guildId);
        const skipped = queue.current;
        const allowed = await permissions.canControlPlaybackByUserId(client, guildId, userId, skipped);
        if (!allowed) {
          return { success: false, message: 'User ini nggak punya izin buat skip lagu ini (bukan yang minta, owner, atau staff).' };
        }
        const ok = musicManager.skip(guildId);
        if (!ok) return { success: false, message: 'Nggak ada lagu yang lagi diputar buat di-skip.' };
        return { success: true, message: `Lagu "${skipped.title}" di-skip.` };
      }

      case 'stop_music': {
        const queue = musicManager.getQueue(guildId);
        const allowed = await permissions.canControlPlaybackByUserId(client, guildId, userId, queue.current);
        if (!allowed) {
          return { success: false, message: 'User ini nggak punya izin buat stop musik ini (bukan yang minta, owner, atau staff).' };
        }
        const had = musicManager.stop(guildId);
        return {
          success: had,
          message: had ? 'Musik dihentikan, antrian dikosongkan.' : 'Nggak ada musik yang lagi diputar/diantrikan.',
        };
      }

      case 'pause_music': {
        const ok = musicManager.pause(guildId);
        return { success: ok, message: ok ? 'Musik dijeda.' : 'Nggak ada musik yang lagi diputar.' };
      }

      case 'resume_music': {
        const ok = musicManager.resume(guildId);
        return { success: ok, message: ok ? 'Musik dilanjutkan.' : 'Nggak ada musik yang lagi dijeda.' };
      }

      case 'set_volume': {
        const percent = Math.max(0, Math.min(200, Math.round(Number(args?.percent))));
        if (!Number.isFinite(percent)) return { success: false, message: 'Nilai volume nggak valid.' };
        musicManager.setVolume(guildId, percent / 100);
        return { success: true, message: `Volume diatur ke ${percent}%.` };
      }

      case 'get_queue_info': {
        const queue = musicManager.getQueue(guildId);
        if (!queue.current) return { success: true, message: 'Nggak ada musik yang lagi diputar.' };
        const upcoming =
          queue.tracks.length > 0 ? queue.tracks.slice(0, 5).map((t) => t.title).join(', ') : '(kosong)';
        return {
          success: true,
          message: `Lagi main: "${queue.current.title}". Antrian berikutnya (${queue.tracks.length}): ${upcoming}.`,
        };
      }

      case 'save_playlist': {
        const queue = musicManager.getQueue(guildId);
        const tracks = [queue.current, ...queue.tracks].filter(Boolean);
        if (tracks.length === 0) {
          return { success: false, message: 'Nggak ada musik yang lagi diputar/diantrikan buat disimpan.' };
        }
        const name = String(args?.name || '').trim().slice(0, 50);
        if (!name) return { success: false, message: 'Nama playlist nggak boleh kosong.' };
        const result = playlistStore.savePlaylist(userId, name, tracks);
        return {
          success: true,
          message: `Playlist "${name}" ${result.isNew ? 'disimpan' : 'diupdate'} (${result.trackCount} lagu).`,
        };
      }

      case 'play_playlist': {
        const name = String(args?.name || '').trim();
        if (!name) return { success: false, message: 'Nama playlist nggak boleh kosong.' };
        const tracks = playlistStore.getPlaylist(userId, name);
        if (!tracks || tracks.length === 0) return { success: false, message: `Playlist "${name}" nggak ketemu.` };

        const tracksCopy = tracks.map((t) => ({ ...t, requestedBy: userTag, requestedById: userId }));
        musicManager.setTextChannel(guildId, channelId);
        const { startedImmediately } = musicManager.enqueueMany(guildId, tracksCopy);
        if (startedImmediately) {
          const channel = await client.channels.fetch(channelId);
          await claimNowPlayingCard(guildId, client, (embed, components) =>
            channel.send({ embeds: [embed], components })
          );
        }
        return { success: true, message: `Playlist "${name}" (${tracks.length} lagu) ditambahkan ke antrian.` };
      }

      case 'set_loop_mode': {
        const mode = String(args?.mode || '').toLowerCase();
        if (!['off', 'track', 'queue'].includes(mode)) {
          return { success: false, message: 'Mode loop nggak valid, harus off/track/queue.' };
        }
        musicManager.setLoopMode(guildId, mode);
        const label = { off: 'dimatikan', track: 'lagu ini diulang terus', queue: 'antrian diulang terus' }[mode];
        return { success: true, message: `Loop ${label}.` };
      }

      case 'set_autoplay': {
        const enabled = Boolean(args?.enabled);
        musicManager.setAutoplay(guildId, enabled);
        return { success: true, message: enabled ? 'Autoplay has been enabled' : 'Autoplay has been disabled' };
      }

      case 'show_now_playing': {
        if (!musicManager.getQueue(guildId).current) {
          return { success: true, message: 'Nggak ada musik yang lagi diputar.' };
        }
        const channel = await client.channels.fetch(channelId);
        await claimNowPlayingCard(guildId, client, (embed, components) => channel.send({ embeds: [embed], components }));
        return { success: true, message: 'Card Now Playing ditampilkan.' };
      }

      case 'add_to_playlist': {
        const name = String(args?.name || '').trim().slice(0, 50);
        if (!name) return { success: false, message: 'Nama playlist nggak boleh kosong.' };
        const links = Array.isArray(args?.links) ? args.links : [];
        if (links.length === 0) return { success: false, message: 'Nggak ada link yang disebutin.' };

        const resolvedTracks = [];
        let failedCount = 0;
        for (const link of links.slice(0, 15)) {
          try {
            if (isPlaylistUrl(link)) {
              const playlistTracks = await resolvePlaylist(link, playlistStore.MAX_TRACKS_PER_PLAYLIST);
              resolvedTracks.push(...playlistTracks);
            } else {
              resolvedTracks.push(await resolveTrack(link));
            }
          } catch {
            failedCount++;
          }
        }
        if (resolvedTracks.length === 0) return { success: false, message: 'Nggak ada satupun link yang berhasil diproses.' };

        const result = playlistStore.appendToPlaylist(userId, name, resolvedTracks);
        let message = `${resolvedTracks.length} lagu ditambahkan ke playlist "${name}" (total sekarang: ${result.trackCount} lagu).`;
        if (failedCount > 0) message += ` ${failedCount} link gagal diproses.`;
        return { success: true, message };
      }

      case 'list_playlists': {
        const playlists = playlistStore.listPlaylists(userId);
        if (playlists.length === 0) return { success: true, message: 'User ini belum punya playlist tersimpan.' };
        const list = playlists.map((p) => `${p.name} (${p.trackCount} lagu)`).join(', ');
        return { success: true, message: `Playlist tersimpan: ${list}.` };
      }

      case 'delete_playlist': {
        const name = String(args?.name || '').trim();
        if (!name) return { success: false, message: 'Nama playlist nggak boleh kosong.' };
        const deleted = playlistStore.deletePlaylist(userId, name);
        return { success: deleted, message: deleted ? `Playlist "${name}" dihapus.` : `Playlist "${name}" nggak ketemu.` };
      }

      default:
        return { success: false, message: `Aksi "${toolName}" nggak dikenali.` };
    }
  } catch (err) {
    return { success: false, message: err.message || 'Terjadi error saat eksekusi aksi.' };
  }
}

// ---------------------------------------------------------------------------
// Penyimpanan sementara buat aksi yang lagi nunggu konfirmasi user (tombol
// Confirm/Cancel). Kadaluarsa otomatis abis 30 detik biar nggak numpuk kalau
// user nggak pernah nge-klik.
// ---------------------------------------------------------------------------
const pendingConfirmations = new Map();
let confirmationCounter = 0;
const CONFIRMATION_TTL_MS = 30_000;

function createPendingConfirmation(data) {
  confirmationCounter += 1;
  const id = `c${Date.now()}${confirmationCounter}`;
  pendingConfirmations.set(id, data);
  setTimeout(() => pendingConfirmations.delete(id), CONFIRMATION_TTL_MS);
  return id;
}

function getPendingConfirmation(id) {
  return pendingConfirmations.get(id) || null;
}

function clearPendingConfirmation(id) {
  pendingConfirmations.delete(id);
}

module.exports = {
  TOOL_DECLARATIONS,
  isSensitive,
  describeAction,
  executeTool,
  createPendingConfirmation,
  getPendingConfirmation,
  clearPendingConfirmation,
  CONFIRMATION_TTL_MS,
  buildConfirmationMessage,
};

/**
 * Bikin embed + tombol Confirm/Cancel buat 1 aksi sensitif yang lagi
 * nunggu persetujuan user. Dipakai bareng-bareng oleh /ask dan mention-chat.
 */
function buildConfirmationMessage(id, toolName, args) {
  const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

  const embed = new EmbedBuilder()
    .setColor(0xfaa61a)
    .setDescription(`⚠️ AI mau **${describeAction(toolName, args)}**. Ini bisa ngaruh ke semua orang di voice channel -- konfirmasi dulu?`);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ai_confirm:${id}`).setLabel('Confirm').setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`ai_cancel:${id}`).setLabel('Cancel').setEmoji('✖️').setStyle(ButtonStyle.Danger)
  );

  return { embeds: [embed], components: [row] };
}
