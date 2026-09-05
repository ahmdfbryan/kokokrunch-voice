const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const musicManager = require('./musicManager');
const playlistStore = require('./musicPlaylistStore');
const trackResolver = require('./trackResolver');

const COLOR = 0x5865f2;
const MAX_NAME_LEN = 50;
const MAX_LINKS_PER_ADD = 15; // batesin biar /playlist add nggak lama banget diproses

function textEmbed(text) {
  return new EmbedBuilder().setColor(COLOR).setDescription(text);
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

function normalizeName(raw) {
  return raw.trim().slice(0, MAX_NAME_LEN);
}

const playlistCommand = {
  data: new SlashCommandBuilder()
    .setName('playlist')
    .setDescription('Kelola playlist musik kamu')
    .addSubcommand((sub) =>
      sub
        .setName('save')
        .setDescription('Simpan antrian musik yang lagi jalan jadi playlist')
        .addStringOption((opt) =>
          opt.setName('nama').setDescription('Nama playlist').setRequired(true).setAutocomplete(true)
        )
        .addIntegerOption((opt) =>
          opt
            .setName('dari_posisi')
            .setDescription('Mulai simpan dari posisi antrian ke berapa (default: dari awal/lagu yang lagi main)')
            .setMinValue(1)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('Tambahin lagu ke playlist langsung dari link (nggak perlu lagi diputar dulu)')
        .addStringOption((opt) =>
          opt
            .setName('nama')
            .setDescription('Nama playlist (dibuat baru kalau belum ada)')
            .setRequired(true)
            .setAutocomplete(true)
        )
        .addStringOption((opt) =>
          opt
            .setName('links')
            .setDescription('1 atau lebih link YouTube/Spotify, pisahkan dengan spasi atau baris baru')
            .setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('play')
        .setDescription('Putar playlist yang udah disimpan')
        .addStringOption((opt) =>
          opt.setName('nama').setDescription('Nama playlist').setRequired(true).setAutocomplete(true)
        )
    )
    .addSubcommand((sub) => sub.setName('list').setDescription('Lihat semua playlist kamu'))
    .addSubcommand((sub) =>
      sub
        .setName('delete')
        .setDescription('Hapus playlist')
        .addStringOption((opt) =>
          opt.setName('nama').setDescription('Nama playlist').setRequired(true).setAutocomplete(true)
        )
    ),

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused().toLowerCase();
    const playlists = playlistStore.listPlaylists(interaction.user.id);
    const filtered = playlists
      .filter((p) => p.name.toLowerCase().includes(focused))
      .slice(0, 25)
      .map((p) => ({ name: `${p.name} (${p.trackCount} lagu)`, value: p.name }));
    await interaction.respond(filtered);
  },

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'save') {
      const name = normalizeName(interaction.options.getString('nama', true));
      if (!name) {
        await interaction.reply({ embeds: [textEmbed('Nama playlist nggak boleh kosong.')], ephemeral: true });
        return;
      }

      const fromPosition = interaction.options.getInteger('dari_posisi');
      const queue = musicManager.getQueue(interaction.guildId);
      let tracks = [queue.current, ...queue.tracks].filter(Boolean);

      if (fromPosition) {
        if (fromPosition > tracks.length) {
          await interaction.reply({
            embeds: [textEmbed(`Posisi ${fromPosition} nggak valid -- antrian cuma ada ${tracks.length} lagu.`)],
            ephemeral: true,
          });
          return;
        }
        tracks = tracks.slice(fromPosition - 1);
      }

      if (tracks.length === 0) {
        await interaction.reply({
          embeds: [textEmbed('Nggak ada musik yang lagi diputar/diantrikan buat disimpan.')],
          ephemeral: true,
        });
        return;
      }

      let result;
      try {
        result = playlistStore.savePlaylist(interaction.user.id, name, tracks);
      } catch (err) {
        await interaction.reply({ embeds: [textEmbed(err.message)], ephemeral: true });
        return;
      }

      const verb = result.isNew ? 'disimpan' : 'diupdate';
      let message = `Playlist **${name}** ${verb} (${result.trackCount} lagu).`;
      if (result.truncated) {
        message += `\n\nCatatan: lebih dari ${playlistStore.MAX_TRACKS_PER_PLAYLIST} lagu, cuma ${playlistStore.MAX_TRACKS_PER_PLAYLIST} lagu pertama yang disimpan.`;
      }
      await interaction.reply({ embeds: [textEmbed(message)] });
      return;
    }

    if (sub === 'add') {
      const name = normalizeName(interaction.options.getString('nama', true));
      if (!name) {
        await interaction.reply({ embeds: [textEmbed('Nama playlist nggak boleh kosong.')], ephemeral: true });
        return;
      }

      const rawLinks = interaction.options.getString('links', true);
      const tokens = [
        ...new Set(
          rawLinks
            .split(/[\s,]+/)
            .map((s) => s.trim())
            .filter(Boolean)
        ),
      ].slice(0, MAX_LINKS_PER_ADD);

      if (tokens.length === 0) {
        await interaction.reply({ embeds: [textEmbed('Nggak ada link yang valid.')], ephemeral: true });
        return;
      }

      await interaction.deferReply();

      // Diproses satu-satu (bukan paralel) biar nggak bikin VPS keberatan
      // spawn banyak proses yt-dlp bersamaan.
      const resolvedTracks = [];
      let failedCount = 0;
      for (const token of tokens) {
        try {
          if (trackResolver.isPlaylistUrl(token)) {
            const playlistTracks = await trackResolver.resolvePlaylist(token, playlistStore.MAX_TRACKS_PER_PLAYLIST);
            resolvedTracks.push(...playlistTracks);
          } else {
            const track = await trackResolver.resolveTrack(token);
            resolvedTracks.push(track);
          }
        } catch {
          failedCount++;
        }
      }

      if (resolvedTracks.length === 0) {
        await interaction.editReply({ embeds: [textEmbed('Nggak ada satupun link yang berhasil diproses.')] });
        return;
      }

      let result;
      try {
        result = playlistStore.appendToPlaylist(interaction.user.id, name, resolvedTracks);
      } catch (err) {
        await interaction.editReply({ embeds: [textEmbed(err.message)] });
        return;
      }

      let message = `${resolvedTracks.length} lagu ditambahkan ke playlist **${name}** (total sekarang: ${result.trackCount} lagu).`;
      if (failedCount > 0) message += `\n\n${failedCount} link gagal diproses dan dilewati.`;
      if (result.truncated) {
        message += `\n\nPlaylist udah kena batas maksimal ${playlistStore.MAX_TRACKS_PER_PLAYLIST} lagu, sisanya dipotong.`;
      }
      await interaction.editReply({ embeds: [textEmbed(message)] });
      return;
    }

    if (sub === 'play') {
      const name = interaction.options.getString('nama', true);
      const tracks = playlistStore.getPlaylist(interaction.user.id, name);
      if (!tracks || tracks.length === 0) {
        await interaction.reply({ embeds: [textEmbed(`Playlist **${name}** nggak ketemu.`)], ephemeral: true });
        return;
      }

      await interaction.deferReply();
      const tracksCopy = tracks.map((t) => ({ ...t, requestedBy: interaction.user.tag }));
      musicManager.setTextChannel(interaction.guildId, interaction.channelId);
      musicManager.enqueueMany(interaction.guildId, tracksCopy);

      await interaction.editReply({
        embeds: [textEmbed(`Playlist **${name}** (${tracks.length} lagu) ditambahkan ke antrian.`)],
      });
      return;
    }

    if (sub === 'list') {
      const playlists = playlistStore.listPlaylists(interaction.user.id);
      if (playlists.length === 0) {
        await interaction.reply({ embeds: [textEmbed('Kamu belum punya playlist tersimpan.')], ephemeral: true });
        return;
      }
      const lines = playlists.map(
        (p, i) => `${i + 1}. **${p.name}** — ${p.trackCount} lagu (${formatDurationLong(p.totalSeconds)})`
      );
      const embed = new EmbedBuilder().setColor(COLOR).setTitle('Playlist Kamu').setDescription(lines.join('\n'));
      await interaction.reply({ embeds: [embed], ephemeral: true });
      return;
    }

    if (sub === 'delete') {
      const name = interaction.options.getString('nama', true);
      const deleted = playlistStore.deletePlaylist(interaction.user.id, name);
      if (!deleted) {
        await interaction.reply({ embeds: [textEmbed(`Playlist **${name}** nggak ketemu.`)], ephemeral: true });
        return;
      }
      await interaction.reply({ embeds: [textEmbed(`Playlist **${name}** dihapus.`)], ephemeral: true });
      return;
    }
  },
};

module.exports = [playlistCommand];
