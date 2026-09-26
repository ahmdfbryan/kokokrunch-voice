const {
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const musicManager = require('./musicManager');
const playlistStore = require('./musicPlaylistStore');
const trackResolver = require('./trackResolver');
const { claimNowPlayingCard } = require('./nowPlayingCard');
const { buildHomeButton, buildBackButton } = require('./panelCard');

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

// Maks jumlah lagu yang ditampilin satu-satu di layar detail playlist (panel)
// biar embed-nya nggak kepanjangan -- sisanya cuma diringkas jadi "+N lainnya".
const MAX_TRACKS_SHOWN_IN_DETAIL = 20;

/**
 * Embed overview SEMUA playlist tersimpan di SERVER ini -- dipakai di layar
 * "Playlist" pas tombol Playlist di panel (Kontrol Musik) diklik. Playlist
 * di-scope per GUILD (bukan per user), jadi semua member server bisa lihat
 * & pakai playlist yang sama. Nampilin jumlah lagu & total durasi tiap
 * playlist sebagai overview aja (bukan isi lagunya -- itu ada di
 * buildPlaylistDetailEmbed pas salah satu playlist dipilih dari dropdown).
 */
function buildPlaylistOverviewEmbed(guildId) {
  const playlists = playlistStore.listPlaylists(guildId);
  const embed = new EmbedBuilder().setColor(COLOR).setAuthor({ name: '📁  Playlist Server' });

  if (playlists.length === 0) {
    embed.setDescription(
      'Server ini belum punya playlist tersimpan.\n\nSimpan antrian musik yang lagi jalan jadi playlist dulu pakai `/playlist save`.'
    );
    return embed;
  }

  const lines = playlists.map(
    (p, i) => `${i + 1}. **${p.name}** — ${p.trackCount} lagu (${formatDurationLong(p.totalSeconds)})`
  );
  embed.setDescription(
    [...lines, '', 'Pilih salah satu di dropdown bawah buat liat isi, muterin, atau kelola playlist-nya.'].join('\n')
  );
  return embed;
}

/**
 * Dropdown pilihan playlist buat dilihat/diputar. Batasnya ngikutin
 * MAX_PLAYLISTS_PER_GUILD (25), pas banget sama limit maksimal option select
 * menu Discord. Return null kalau server belum punya playlist sama sekali,
 * biar nggak render select menu kosong (Discord bakal nolak itu).
 */
function buildPlaylistSelectRow(guildId) {
  const playlists = playlistStore.listPlaylists(guildId);
  if (playlists.length === 0) return null;

  const menu = new StringSelectMenuBuilder()
    .setCustomId('panelplaylist_select')
    .setPlaceholder('Pilih playlist buat dilihat/diputar')
    .addOptions(
      playlists.map((p) => ({
        label: p.name,
        description: `${p.trackCount} lagu • ${formatDurationLong(p.totalSeconds)}`,
        value: p.name,
      }))
    );
  return new ActionRowBuilder().addComponents(menu);
}

/**
 * Embed detail isi 1 playlist -- overview (jumlah lagu & total durasi) di
 * atas, lalu daftar lagunya satu-satu (dibatasin MAX_TRACKS_SHOWN_IN_DETAIL
 * biar description-nya nggak kepanjangan). Return null kalau playlist-nya
 * ternyata udah nggak ada lagi (misal kehapus barengan lewat /playlist delete).
 */
function buildPlaylistDetailEmbed(guildId, name) {
  const tracks = playlistStore.getPlaylist(guildId, name);
  if (!tracks) return null;

  const totalSeconds = tracks.reduce((sum, t) => sum + (t.durationSeconds || 0), 0);
  const shown = tracks.slice(0, MAX_TRACKS_SHOWN_IN_DETAIL);
  const trackLines = shown.map((t, i) => `${i + 1}. ${t.title}${t.durationText ? ` — \`${t.durationText}\`` : ''}`);
  if (tracks.length > shown.length) {
    trackLines.push(`*+${tracks.length - shown.length} lagu lainnya*`);
  }

  return new EmbedBuilder()
    .setColor(COLOR)
    .setAuthor({ name: `📁  ${name}` })
    .setDescription([`**${tracks.length}** lagu • **${formatDurationLong(totalSeconds)}**`, '', ...trackLines].join('\n'));
}

/**
 * Tombol-tombol di layar detail playlist -- 6 tombol (Play, Add, Rename,
 * Delete, Back, Home) dibagi rata 3-3 biar nggak nabrak limit 5/baris.
 * Nama playlist-nya dikodein di tiap customId (`::<nama>`) biar handler-nya
 * di index.js tau lagi ngurusin playlist yang mana.
 */
function buildPlaylistDetailButtons(name) {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`panelplaylist_play::${name}`).setLabel('Play').setEmoji('▶️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`panelplaylist_add::${name}`).setLabel('Add').setEmoji('➕').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`panelplaylist_rename::${name}`).setLabel('Rename').setEmoji('✏️').setStyle(ButtonStyle.Secondary)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`panelplaylist_delete::${name}`).setLabel('Delete').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
    buildBackButton('panel_music'),
    buildHomeButton()
  );
  return [row1, row2];
}

/**
 * Muterin 1 playlist tersimpan dari tombol "Play" di layar detail playlist
 * (panel). Logikanya sama kayak /playlist play, tapi ack-nya ephemeral
 * (ngikutin konvensi tombol panel lain kayak Skip/Stop), bukan reply publik
 * kayak command aslinya -- Now Playing card-nya sendiri tetap diposting
 * publik ke channel kalau langsung mulai muter.
 */
async function playPlaylistForPanel(interaction, name) {
  const tracks = playlistStore.getPlaylist(interaction.guildId, name);
  if (!tracks || tracks.length === 0) {
    await interaction.reply({ embeds: [textEmbed(`Playlist **${name}** nggak ketemu.`)], flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const tracksCopy = tracks.map((t) => ({ ...t, requestedBy: interaction.user.tag, requestedById: interaction.user.id }));
  musicManager.setTextChannel(interaction.guildId, interaction.channelId);
  const { startedImmediately } = musicManager.enqueueMany(interaction.guildId, tracksCopy);

  await interaction.editReply({
    embeds: [textEmbed(`Playlist **${name}** (${tracks.length} lagu) ditambahkan ke antrian.`)],
  });

  if (startedImmediately) {
    await claimNowPlayingCard(interaction.guildId, interaction.client, (embed, components) =>
      interaction.channel.send({ embeds: [embed], components })
    );
  }
}

/**
 * Tombol "Add" di layar detail playlist -- nambahin lagu yang LAGI DIPUTAR
 * sekarang ke playlist yang lagi dibuka. Ephemeral ack, nggak nge-update
 * layar panel (konsisten sama tombol leaf lain kayak Skip/Stop/Set Username).
 */
async function addCurrentTrackToPlaylist(interaction, name) {
  const queue = musicManager.getQueue(interaction.guildId);
  const current = queue.current;
  if (!current) {
    await interaction.reply({
      embeds: [textEmbed('Nggak ada lagu yang lagi diputar buat ditambahin ke playlist.')],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const result = playlistStore.appendToPlaylist(interaction.guildId, name, [current]);
  await interaction.reply({
    embeds: [
      textEmbed(`**${current.title}** ditambahin ke playlist **${name}** (total sekarang: ${result.trackCount} lagu).`),
    ],
    flags: MessageFlags.Ephemeral,
  });
}

/** Modal ganti nama playlist -- nama lama dikodein di customId modalnya, input-nya di-prefill sama nama lama. */
function buildRenameModal(name) {
  const modal = new ModalBuilder().setCustomId(`panelplaylist_rename_modal::${name}`).setTitle('Ganti Nama Playlist');
  const nameInput = new TextInputBuilder()
    .setCustomId('panelplaylist_new_name')
    .setLabel('Nama Baru')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(MAX_NAME_LEN)
    .setPlaceholder('misal: Lagu Santai');
  if (typeof nameInput.setValue === 'function') nameInput.setValue(name);
  modal.addComponents(new ActionRowBuilder().addComponents(nameInput));
  return modal;
}

/** Handler submit modal rename -- validasi nama baru & panggil playlistStore.renamePlaylist. */
async function handleRenameModalSubmit(interaction, oldName) {
  const newName = normalizeName(interaction.fields.getTextInputValue('panelplaylist_new_name') || '');
  if (!newName) {
    await interaction.reply({ content: 'Nama playlist nggak boleh kosong.', flags: MessageFlags.Ephemeral });
    return;
  }

  const result = playlistStore.renamePlaylist(interaction.guildId, oldName, newName);
  if (!result.ok) {
    const msg =
      result.reason === 'name_taken'
        ? `Playlist **${newName}** udah ada, pilih nama lain.`
        : `Playlist **${oldName}** nggak ketemu (mungkin udah kehapus).`;
    await interaction.reply({ embeds: [textEmbed(msg)], flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.reply({
    embeds: [textEmbed(`✅ Playlist **${oldName}** diganti nama jadi **${newName}**.`)],
    flags: MessageFlags.Ephemeral,
  });
}

const playlistCommand = {
  data: new SlashCommandBuilder()
    .setName('playlist')
    .setDescription('Kelola playlist musik server ini (bisa dipakai & dilihat semua member)')
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
    .addSubcommand((sub) => sub.setName('list').setDescription('Lihat semua playlist server ini'))
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
    const playlists = playlistStore.listPlaylists(interaction.guildId);
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
        await interaction.reply({ embeds: [textEmbed('Nama playlist nggak boleh kosong.')], flags: MessageFlags.Ephemeral });
        return;
      }

      const fromPosition = interaction.options.getInteger('dari_posisi');
      const queue = musicManager.getQueue(interaction.guildId);
      let tracks = [queue.current, ...queue.tracks].filter(Boolean);

      if (fromPosition) {
        if (fromPosition > tracks.length) {
          await interaction.reply({
            embeds: [textEmbed(`Posisi ${fromPosition} nggak valid -- antrian cuma ada ${tracks.length} lagu.`)],
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        tracks = tracks.slice(fromPosition - 1);
      }

      if (tracks.length === 0) {
        await interaction.reply({
          embeds: [textEmbed('Nggak ada musik yang lagi diputar/diantrikan buat disimpan.')],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      let result;
      try {
        result = playlistStore.savePlaylist(interaction.guildId, name, tracks);
      } catch (err) {
        await interaction.reply({ embeds: [textEmbed(err.message)], flags: MessageFlags.Ephemeral });
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
        await interaction.reply({ embeds: [textEmbed('Nama playlist nggak boleh kosong.')], flags: MessageFlags.Ephemeral });
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
        await interaction.reply({ embeds: [textEmbed('Nggak ada link yang valid.')], flags: MessageFlags.Ephemeral });
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
        result = playlistStore.appendToPlaylist(interaction.guildId, name, resolvedTracks);
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
      const tracks = playlistStore.getPlaylist(interaction.guildId, name);
      if (!tracks || tracks.length === 0) {
        await interaction.reply({ embeds: [textEmbed(`Playlist **${name}** nggak ketemu.`)], flags: MessageFlags.Ephemeral });
        return;
      }

      await interaction.deferReply();
      const tracksCopy = tracks.map((t) => ({ ...t, requestedBy: interaction.user.tag, requestedById: interaction.user.id }));
      musicManager.setTextChannel(interaction.guildId, interaction.channelId);
      const { startedImmediately } = musicManager.enqueueMany(interaction.guildId, tracksCopy);

      await interaction.editReply({
        embeds: [textEmbed(`Playlist **${name}** (${tracks.length} lagu) ditambahkan ke antrian.`)],
      });

      if (startedImmediately) {
        await claimNowPlayingCard(interaction.guildId, interaction.client, (embed, components) =>
          interaction.channel.send({ embeds: [embed], components })
        );
      }
      return;
    }

    if (sub === 'list') {
      const playlists = playlistStore.listPlaylists(interaction.guildId);
      if (playlists.length === 0) {
        await interaction.reply({ embeds: [textEmbed('Server ini belum punya playlist tersimpan.')], flags: MessageFlags.Ephemeral });
        return;
      }
      const lines = playlists.map(
        (p, i) => `${i + 1}. **${p.name}** — ${p.trackCount} lagu (${formatDurationLong(p.totalSeconds)})`
      );
      const embed = new EmbedBuilder().setColor(COLOR).setTitle('Playlist Server').setDescription(lines.join('\n'));
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      return;
    }

    if (sub === 'delete') {
      const name = interaction.options.getString('nama', true);
      const deleted = playlistStore.deletePlaylist(interaction.guildId, name);
      if (!deleted) {
        await interaction.reply({ embeds: [textEmbed(`Playlist **${name}** nggak ketemu.`)], flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.reply({ embeds: [textEmbed(`Playlist **${name}** dihapus.`)], flags: MessageFlags.Ephemeral });
      return;
    }
  },
};

module.exports = [playlistCommand];
module.exports.buildPlaylistOverviewEmbed = buildPlaylistOverviewEmbed;
module.exports.buildPlaylistSelectRow = buildPlaylistSelectRow;
module.exports.buildPlaylistDetailEmbed = buildPlaylistDetailEmbed;
module.exports.buildPlaylistDetailButtons = buildPlaylistDetailButtons;
module.exports.playPlaylistForPanel = playPlaylistForPanel;
module.exports.addCurrentTrackToPlaylist = addCurrentTrackToPlaylist;
module.exports.buildRenameModal = buildRenameModal;
module.exports.handleRenameModalSubmit = handleRenameModalSubmit;
