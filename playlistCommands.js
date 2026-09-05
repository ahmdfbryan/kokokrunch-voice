const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const musicManager = require('./musicManager');
const playlistStore = require('./playlistStore');

const COLOR = 0x5865f2;
const PREVIEW_COUNT = 10;

function textEmbed(text) {
  return new EmbedBuilder().setColor(COLOR).setDescription(text);
}

function formatEta(totalSeconds) {
  if (totalSeconds <= 0) return 'Sekarang';
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  const parts = [];
  if (h > 0) parts.push(`${h} jam`);
  if (m > 0) parts.push(`${m} menit`);
  if (h === 0 && m === 0) parts.push(`${s} detik`);
  return parts.join(' ');
}

const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('playlist')
      .setDescription('Kelola playlist tersimpan -- bisa disimpan dari sesi musik yang lagi jalan')
      .addSubcommand((sub) =>
        sub
          .setName('save')
          .setDescription('Simpan sesi musik saat ini (yang udah + lagi + akan diputar) jadi playlist')
          .addStringOption((opt) => opt.setName('nama').setDescription('Nama buat playlist ini').setRequired(true))
      )
      .addSubcommand((sub) =>
        sub
          .setName('play')
          .setDescription('Muter playlist tersimpan -- semua lagunya ditambahin ke antrian')
          .addStringOption((opt) => opt.setName('nama').setDescription('Nama playlist yang mau diputar').setRequired(true))
      )
      .addSubcommand((sub) => sub.setName('list').setDescription('Lihat semua playlist tersimpan di server ini'))
      .addSubcommand((sub) =>
        sub
          .setName('show')
          .setDescription('Lihat isi lagu dari 1 playlist tersimpan')
          .addStringOption((opt) => opt.setName('nama').setDescription('Nama playlist yang mau dilihat').setRequired(true))
      )
      .addSubcommand((sub) =>
        sub
          .setName('delete')
          .setDescription('Hapus playlist tersimpan')
          .addStringOption((opt) => opt.setName('nama').setDescription('Nama playlist yang mau dihapus').setRequired(true))
      ),
    async execute(interaction, log) {
      const sub = interaction.options.getSubcommand();

      if (sub === 'save') {
        const nama = interaction.options.getString('nama', true);
        const sessionTracks = musicManager.getSessionTracks(interaction.guildId);

        let result;
        try {
          result = await playlistStore.savePlaylist(interaction.guildId, nama, sessionTracks, {
            createdBy: interaction.user.id,
          });
        } catch (err) {
          await interaction.reply({ embeds: [textEmbed(err.message)], ephemeral: true });
          return;
        }

        const { playlist, isUpdate, truncated } = result;
        const verb = isUpdate ? 'diperbarui' : 'disimpan';
        const truncNote = truncated
          ? `\n_(dibatasi ${playlistStore.MAX_TRACKS_PER_PLAYLIST} lagu pertama)_`
          : '';
        log(`[PLAYLIST] "${playlist.name}" ${verb} oleh ${interaction.user.tag} buat guild ${interaction.guildId} (${playlist.tracks.length} lagu)`);
        await interaction.reply({
          embeds: [
            textEmbed(
              `Sesi saat ini berhasil ${verb} jadi playlist **${playlist.name}** (${playlist.tracks.length} lagu).${truncNote}`
            ),
          ],
        });
        return;
      }

      if (sub === 'play') {
        const nama = interaction.options.getString('nama', true);
        const playlist = playlistStore.getPlaylist(interaction.guildId, nama);
        if (!playlist) {
          await interaction.reply({ embeds: [textEmbed(`Playlist **${nama}** nggak ketemu.`)], ephemeral: true });
          return;
        }

        await interaction.deferReply();

        const tracks = playlist.tracks.map((t) => ({ ...t, requestedBy: interaction.user.tag }));
        musicManager.setTextChannel(interaction.guildId, interaction.channelId);
        const { etaList, startedImmediately } = musicManager.enqueueMany(interaction.guildId, tracks);

        const firstEtaSeconds = etaList[0]?.etaSeconds ?? 0;
        const titleList = etaList
          .slice(0, PREVIEW_COUNT)
          .map((e, i) => `${i + 1}. ${e.track.title}`)
          .join('\n');
        const extra = etaList.length > PREVIEW_COUNT ? `\n...dan ${etaList.length - PREVIEW_COUNT} lagu lainnya` : '';

        const embed = new EmbedBuilder()
          .setColor(COLOR)
          .setTitle(`Playlist "${playlist.name}" Ditambahkan`)
          .setDescription(
            `${tracks.length} lagu ditambahkan ke antrian.\n\n${titleList}${extra}\n\n` +
              (startedImmediately ? 'Langsung mulai diputar.' : `Estimated time until played: ${formatEta(firstEtaSeconds)}`)
          );
        await interaction.editReply({ embeds: [embed] });
        return;
      }

      if (sub === 'list') {
        const playlists = playlistStore.listPlaylists(interaction.guildId);
        if (playlists.length === 0) {
          await interaction.reply({
            embeds: [textEmbed('Belum ada playlist tersimpan di server ini. Simpan sesi yang lagi jalan pakai `/playlist save`.')],
            ephemeral: true,
          });
          return;
        }

        const list = playlists
          .map((p, i) => `${i + 1}. **${p.name}** — ${p.tracks.length} lagu`)
          .join('\n');
        await interaction.reply({ embeds: [new EmbedBuilder().setColor(COLOR).setTitle('Playlist Tersimpan').setDescription(list)] });
        return;
      }

      if (sub === 'show') {
        const nama = interaction.options.getString('nama', true);
        const playlist = playlistStore.getPlaylist(interaction.guildId, nama);
        if (!playlist) {
          await interaction.reply({ embeds: [textEmbed(`Playlist **${nama}** nggak ketemu.`)], ephemeral: true });
          return;
        }

        const list = playlist.tracks
          .slice(0, PREVIEW_COUNT)
          .map((t, i) => `${i + 1}. ${t.title}`)
          .join('\n');
        const extra = playlist.tracks.length > PREVIEW_COUNT ? `\n...dan ${playlist.tracks.length - PREVIEW_COUNT} lagu lainnya` : '';

        await interaction.reply({
          embeds: [
            new EmbedBuilder()
              .setColor(COLOR)
              .setTitle(`Playlist: ${playlist.name}`)
              .setDescription(`${playlist.tracks.length} lagu\n\n${list}${extra}`),
          ],
        });
        return;
      }

      if (sub === 'delete') {
        const nama = interaction.options.getString('nama', true);
        const deleted = await playlistStore.deletePlaylist(interaction.guildId, nama);
        if (!deleted) {
          await interaction.reply({ embeds: [textEmbed(`Playlist **${nama}** nggak ketemu.`)], ephemeral: true });
          return;
        }
        log(`[PLAYLIST] "${nama}" dihapus oleh ${interaction.user.tag} buat guild ${interaction.guildId}`);
        await interaction.reply({ embeds: [textEmbed(`Playlist **${nama}** berhasil dihapus.`)] });
      }
    },
  },
];

module.exports = commands;
