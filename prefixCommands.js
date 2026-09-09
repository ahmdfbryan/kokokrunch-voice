const { EmbedBuilder } = require('discord.js');
const musicManager = require('./musicManager');
const { resolveTrack, isPlaylistUrl, resolvePlaylist } = require('./trackResolver');
const { buildNowPlayingCard, claimNowPlayingCard } = require('./nowPlayingCard');
const playlistStore = require('./musicPlaylistStore');
const { COLOR, textEmbed, formatEta, formatTotalDuration } = require('./musicFormat');

const PREFIX = 's!';
const PLAYLIST_MAX_TRACKS = 100;
const PLAYLIST_PREVIEW_COUNT = 10;
const MAX_LINKS_PER_ADD = 15;
const MAX_NAME_LEN = 50;

function normalizeName(raw) {
  return raw.trim().slice(0, MAX_NAME_LEN);
}

function formatDurationLong(totalSeconds) {
  const totalMinutes = Math.floor(totalSeconds / 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  const parts = [];
  if (h > 0) parts.push(`${h} jam`);
  parts.push(`${m} menit`);
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Musik dasar
// ---------------------------------------------------------------------------

async function cmdPlay(message, rest) {
  if (!rest) {
    await message.channel.send({ embeds: [textEmbed(`Gunakan: \`${PREFIX}play <link atau kata kunci>\``)] });
    return;
  }

  const guildId = message.guild.id;

  if (isPlaylistUrl(rest)) {
    let tracks;
    try {
      tracks = await resolvePlaylist(rest, PLAYLIST_MAX_TRACKS);
    } catch (err) {
      await message.channel.send({ embeds: [textEmbed(err.message)] });
      return;
    }
    tracks.forEach((t) => {
      t.requestedBy = message.author.tag;
    });

    musicManager.setTextChannel(guildId, message.channel.id);
    const { etaList, startedImmediately } = musicManager.enqueueMany(guildId, tracks);

    const totalSeconds = tracks.reduce((sum, t) => sum + (t.durationSeconds || 0), 0);
    const firstEtaSeconds = etaList[0]?.etaSeconds ?? 0;
    const titleList = etaList
      .slice(0, PLAYLIST_PREVIEW_COUNT)
      .map((e, i) => `${i + 1}. ${e.track.title}`)
      .join('\n');
    const extra = etaList.length > PLAYLIST_PREVIEW_COUNT ? `\n...dan ${etaList.length - PLAYLIST_PREVIEW_COUNT} lagu lainnya` : '';

    const embed = new EmbedBuilder()
      .setColor(COLOR)
      .setTitle('Playlist Ditambahkan')
      .setDescription(
        `${tracks.length} lagu dari playlist ditambahkan ke antrian.\n\n` +
          `${titleList}${extra}\n\n` +
          `Track Length: ${formatTotalDuration(totalSeconds)}\n` +
          `Estimated time until played: ${formatEta(firstEtaSeconds)}`
      );
    await message.channel.send({ embeds: [embed] });

    if (startedImmediately) {
      await claimNowPlayingCard(guildId, message.client, (npEmbed, components) =>
        message.channel.send({ embeds: [npEmbed], components })
      );
    }
    return;
  }

  let track;
  try {
    track = await resolveTrack(rest);
  } catch (err) {
    await message.channel.send({ embeds: [textEmbed(err.message)] });
    return;
  }

  track.requestedBy = message.author.tag;
  musicManager.setTextChannel(guildId, message.channel.id);
  const { position, startedImmediately, etaSeconds } = musicManager.enqueue(guildId, track);

  if (startedImmediately) {
    await claimNowPlayingCard(guildId, message.client, (embed, components) =>
      message.channel.send({ embeds: [embed], components })
    );
  } else {
    const embed = new EmbedBuilder()
      .setColor(COLOR)
      .setDescription(`**${track.title}** ditambahkan ke antrian`)
      .setThumbnail(track.thumbnail || null)
      .addFields(
        { name: 'Estimated time until played', value: formatEta(etaSeconds), inline: true },
        { name: 'Track Length', value: track.durationText || '?', inline: true },
        { name: 'Position in queue', value: `#${position}`, inline: true },
        { name: 'Request by', value: track.requestedBy, inline: true }
      );
    await message.channel.send({ embeds: [embed] });
  }
}

async function cmdSkip(message) {
  const guildId = message.guild.id;
  const queue = musicManager.getQueue(guildId);
  const skippedTrack = queue.current;

  const skipped = musicManager.skip(guildId);
  if (!skipped) {
    await message.channel.send({ embeds: [textEmbed('Nggak ada lagu yang lagi diputar.')] });
    return;
  }
  await message.channel.send({
    embeds: [textEmbed(`**${skippedTrack.title}** has been skipped by <@${message.author.id}>`)],
  });
}

async function cmdStop(message) {
  const guildId = message.guild.id;
  const hadSomething = musicManager.stop(guildId);
  if (!hadSomething) {
    await message.channel.send({ embeds: [textEmbed('Nggak ada musik yang lagi diputar atau diantrikan.')] });
    return;
  }
  await message.channel.send({
    embeds: [textEmbed(`Musik dihentikan oleh <@${message.author.id}>, antrian dikosongkan.`)],
  });
}

async function cmdPause(message) {
  const ok = musicManager.pause(message.guild.id);
  await message.channel.send({ embeds: [textEmbed(ok ? 'Musik dijeda.' : 'Nggak ada musik yang lagi diputar.')] });
}

async function cmdResume(message) {
  const ok = musicManager.resume(message.guild.id);
  await message.channel.send({ embeds: [textEmbed(ok ? 'Musik dilanjutkan.' : 'Nggak ada musik yang lagi diputar.')] });
}

async function cmdQueue(message) {
  const guildId = message.guild.id;
  const queue = musicManager.getQueue(guildId);
  const autoplayStatus = queue.autoplayEnabled ? 'ON' : 'OFF';

  if (!queue.current && queue.tracks.length === 0) {
    await message.channel.send({
      embeds: [textEmbed(`Antrian kosong, nggak ada musik yang diputar.\n\nAutoplay: ${autoplayStatus}`)],
    });
    return;
  }

  const embed = new EmbedBuilder().setColor(COLOR).setTitle('Antrian Musik');

  if (queue.current) {
    embed.addFields({
      name: 'Sedang Diputar',
      value: `**${queue.current.title}**${queue.current.isAutoplay ? ' _(Autoplay)_' : ''} — diminta oleh ${queue.current.requestedBy}`,
    });
  }

  if (queue.tracks.length > 0) {
    const list = queue.tracks
      .slice(0, 10)
      .map((t, i) => `${i + 1}. **${t.title}** — diminta oleh ${t.requestedBy}`)
      .join('\n');
    const extra = queue.tracks.length > 10 ? `\n...dan ${queue.tracks.length - 10} lagu lainnya` : '';
    embed.addFields({ name: 'Berikutnya', value: list + extra });
  }

  embed.addFields({ name: 'Autoplay', value: autoplayStatus, inline: true });
  await message.channel.send({ embeds: [embed] });
}

async function cmdVolume(message, rest) {
  const percent = parseInt(rest, 10);
  if (Number.isNaN(percent) || percent < 0 || percent > 200) {
    await message.channel.send({ embeds: [textEmbed(`Gunakan: \`${PREFIX}volume <0-200>\``)] });
    return;
  }
  musicManager.setVolume(message.guild.id, percent / 100);
  await message.channel.send({ embeds: [textEmbed(`Volume diatur ke ${percent}%.`)] });
}

const LOOP_MODE_ALIASES = { off: 'off', track: 'track', lagu: 'track', queue: 'queue', antrian: 'queue' };

async function cmdLoop(message, rest) {
  const mode = LOOP_MODE_ALIASES[rest.trim().toLowerCase()];
  if (!mode) {
    await message.channel.send({ embeds: [textEmbed(`Gunakan: \`${PREFIX}loop <off|track|queue>\``)] });
    return;
  }
  musicManager.setLoopMode(message.guild.id, mode);
  const label = { off: 'dimatikan', track: 'lagu ini diulang terus', queue: 'antrian diulang terus' }[mode];
  await message.channel.send({ embeds: [textEmbed(`Loop ${label}.`)] });
}

async function cmdAutoplay(message, rest) {
  const arg = rest.trim().toLowerCase();
  if (arg !== 'on' && arg !== 'off') {
    await message.channel.send({ embeds: [textEmbed(`Gunakan: \`${PREFIX}autoplay <on|off>\``)] });
    return;
  }
  const enabled = arg === 'on';
  musicManager.setAutoplay(message.guild.id, enabled);
  await message.channel.send({
    embeds: [textEmbed(enabled ? 'Autoplay has been enabled' : 'Autoplay has been disabled')],
  });
}

async function cmdNowPlaying(message) {
  const guildId = message.guild.id;
  if (!musicManager.getQueue(guildId).current) {
    const { embed } = buildNowPlayingCard(guildId);
    await message.channel.send({ embeds: [embed] });
    return;
  }
  await claimNowPlayingCard(guildId, message.client, (embed, components) =>
    message.channel.send({ embeds: [embed], components })
  );
}

// ---------------------------------------------------------------------------
// Playlist (save/add/play/list/delete) -- nama playlist lewat prefix HARUS
// 1 kata (nggak boleh ada spasi), beda dari versi slash command yang bisa
// nampung nama multi-kata lewat opsi string. Ini keterbatasan yang disengaja
// biar parsing argumen tetep simpel & nggak ambigu.
// ---------------------------------------------------------------------------

async function cmdPlaylist(message, args, rest) {
  const sub = (args[0] || '').toLowerCase();
  const subRest = rest.slice(args[0]?.length || 0).trim();

  if (sub === 'save') {
    const name = normalizeName(subRest);
    if (!name) {
      await message.channel.send({
        embeds: [textEmbed(`Gunakan: \`${PREFIX}playlist save <nama>\` (nama 1 kata, nggak boleh spasi)`)],
      });
      return;
    }

    const queue = musicManager.getQueue(message.guild.id);
    const tracks = [queue.current, ...queue.tracks].filter(Boolean);
    if (tracks.length === 0) {
      await message.channel.send({ embeds: [textEmbed('Nggak ada musik yang lagi diputar/diantrikan buat disimpan.')] });
      return;
    }

    let result;
    try {
      result = playlistStore.savePlaylist(message.author.id, name, tracks);
    } catch (err) {
      await message.channel.send({ embeds: [textEmbed(err.message)] });
      return;
    }

    const verb = result.isNew ? 'disimpan' : 'diupdate';
    let msg = `Playlist **${name}** ${verb} (${result.trackCount} lagu).`;
    if (result.truncated) {
      msg += `\n\nCatatan: lebih dari ${playlistStore.MAX_TRACKS_PER_PLAYLIST} lagu, cuma ${playlistStore.MAX_TRACKS_PER_PLAYLIST} lagu pertama yang disimpan.`;
    }
    await message.channel.send({ embeds: [textEmbed(msg)] });
    return;
  }

  if (sub === 'add') {
    const [name, ...linkTokens] = subRest.split(/\s+/).filter(Boolean);
    if (!name || linkTokens.length === 0) {
      await message.channel.send({
        embeds: [textEmbed(`Gunakan: \`${PREFIX}playlist add <nama> <link1> <link2> ...\``)],
      });
      return;
    }

    const tokens = [...new Set(linkTokens)].slice(0, MAX_LINKS_PER_ADD);
    const resolvedTracks = [];
    let failedCount = 0;
    for (const token of tokens) {
      try {
        if (isPlaylistUrl(token)) {
          const playlistTracks = await resolvePlaylist(token, playlistStore.MAX_TRACKS_PER_PLAYLIST);
          resolvedTracks.push(...playlistTracks);
        } else {
          resolvedTracks.push(await resolveTrack(token));
        }
      } catch {
        failedCount++;
      }
    }

    if (resolvedTracks.length === 0) {
      await message.channel.send({ embeds: [textEmbed('Nggak ada satupun link yang berhasil diproses.')] });
      return;
    }

    let result;
    try {
      result = playlistStore.appendToPlaylist(message.author.id, normalizeName(name), resolvedTracks);
    } catch (err) {
      await message.channel.send({ embeds: [textEmbed(err.message)] });
      return;
    }

    let msg = `${resolvedTracks.length} lagu ditambahkan ke playlist **${name}** (total sekarang: ${result.trackCount} lagu).`;
    if (failedCount > 0) msg += `\n\n${failedCount} link gagal diproses dan dilewati.`;
    if (result.truncated) msg += `\n\nPlaylist udah kena batas maksimal ${playlistStore.MAX_TRACKS_PER_PLAYLIST} lagu.`;
    await message.channel.send({ embeds: [textEmbed(msg)] });
    return;
  }

  if (sub === 'play') {
    const name = subRest.trim();
    if (!name) {
      await message.channel.send({ embeds: [textEmbed(`Gunakan: \`${PREFIX}playlist play <nama>\``)] });
      return;
    }
    const tracks = playlistStore.getPlaylist(message.author.id, name);
    if (!tracks || tracks.length === 0) {
      await message.channel.send({ embeds: [textEmbed(`Playlist **${name}** nggak ketemu.`)] });
      return;
    }

    const guildId = message.guild.id;
    const tracksCopy = tracks.map((t) => ({ ...t, requestedBy: message.author.tag }));
    musicManager.setTextChannel(guildId, message.channel.id);
    const { startedImmediately } = musicManager.enqueueMany(guildId, tracksCopy);

    await message.channel.send({
      embeds: [textEmbed(`Playlist **${name}** (${tracks.length} lagu) ditambahkan ke antrian.`)],
    });

    if (startedImmediately) {
      await claimNowPlayingCard(guildId, message.client, (embed, components) =>
        message.channel.send({ embeds: [embed], components })
      );
    }
    return;
  }

  if (sub === 'list') {
    const playlists = playlistStore.listPlaylists(message.author.id);
    if (playlists.length === 0) {
      await message.channel.send({ embeds: [textEmbed('Kamu belum punya playlist tersimpan.')] });
      return;
    }
    const lines = playlists.map(
      (p, i) => `${i + 1}. **${p.name}** — ${p.trackCount} lagu (${formatDurationLong(p.totalSeconds)})`
    );
    const embed = new EmbedBuilder().setColor(COLOR).setTitle('Playlist Kamu').setDescription(lines.join('\n'));
    await message.channel.send({ embeds: [embed] });
    return;
  }

  if (sub === 'delete') {
    const name = subRest.trim();
    if (!name) {
      await message.channel.send({ embeds: [textEmbed(`Gunakan: \`${PREFIX}playlist delete <nama>\``)] });
      return;
    }
    const deleted = playlistStore.deletePlaylist(message.author.id, name);
    await message.channel.send({
      embeds: [textEmbed(deleted ? `Playlist **${name}** dihapus.` : `Playlist **${name}** nggak ketemu.`)],
    });
    return;
  }

  await message.channel.send({
    embeds: [textEmbed(`Gunakan: \`${PREFIX}playlist <save|add|play|list|delete> ...\``)],
  });
}

// ---------------------------------------------------------------------------
// Dispatcher utama
// ---------------------------------------------------------------------------

const HANDLERS = {
  play: (message, args, rest) => cmdPlay(message, rest),
  p: (message, args, rest) => cmdPlay(message, rest),
  skip: cmdSkip,
  stop: cmdStop,
  pause: cmdPause,
  resume: cmdResume,
  queue: cmdQueue,
  volume: (message, args, rest) => cmdVolume(message, rest),
  loop: (message, args, rest) => cmdLoop(message, rest),
  autoplay: (message, args, rest) => cmdAutoplay(message, rest),
  nowplaying: cmdNowPlaying,
  np: cmdNowPlaying,
  playlist: cmdPlaylist,
};

/**
 * Dipanggil dari messageCreate di index.js. Return true kalau pesannya
 * emang command prefix (biar index.js tau nggak usah diproses listener lain
 * kayak AI chat mention), false kalau bukan.
 */
async function handlePrefixCommand(message, log) {
  if (message.author.bot) return false;
  if (!message.guild) return false;
  if (!message.content.toLowerCase().startsWith(PREFIX)) return false;

  const withoutPrefix = message.content.slice(PREFIX.length).trim();
  if (!withoutPrefix) return false;

  const spaceIdx = withoutPrefix.search(/\s/);
  const commandName = (spaceIdx === -1 ? withoutPrefix : withoutPrefix.slice(0, spaceIdx)).toLowerCase();
  const rest = spaceIdx === -1 ? '' : withoutPrefix.slice(spaceIdx + 1).trim();
  const args = rest.split(/\s+/).filter(Boolean);

  const handler = HANDLERS[commandName];
  if (!handler) return false; // bukan command yang kita kenal -- biarin listener lain yang urus

  try {
    await handler(message, args, rest);
  } catch (err) {
    if (log) log(`[PREFIX] Error di ${PREFIX}${commandName}: ${err?.stack || err}`);
    await message.channel.send({ embeds: [textEmbed('Terjadi error, coba lagi.')] }).catch(() => {});
  }
  return true;
}

module.exports = { handlePrefixCommand, PREFIX };
