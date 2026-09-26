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
  PermissionFlagsBits,
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

  const lines = playlists.map((p, i) => {
    const ownerSuffix = p.ownerTag ? ` — dibuat oleh **${p.ownerTag}**` : '';
    return `${i + 1}. **${p.name}** — ${p.trackCount} lagu (${formatDurationLong(p.totalSeconds)})${ownerSuffix}`;
  });
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

  const owner = playlistStore.getPlaylistOwner(guildId, name);
  const ownerLine = owner?.ownerTag
    ? `Dibuat oleh **${owner.ownerTag}** — cuma dia yang bisa Add/Rename/Hapus, yang lain cuma bisa Play.`
    : 'Dibuat sebelum fitur "pemilik playlist" ada — cuma yang punya izin Manage Server yang bisa Add/Rename/Hapus.';

  const totalSeconds = tracks.reduce((sum, t) => sum + (t.durationSeconds || 0), 0);
  const shown = tracks.slice(0, MAX_TRACKS_SHOWN_IN_DETAIL);
  const trackLines = shown.map((t, i) => `${i + 1}. ${t.title}${t.durationText ? ` — \`${t.durationText}\`` : ''}`);
  if (tracks.length > shown.length) {
    trackLines.push(`*+${tracks.length - shown.length} lagu lainnya*`);
  }

  return new EmbedBuilder()
    .setColor(COLOR)
    .setAuthor({ name: `📁  ${name}` })
    .setDescription(
      [`**${tracks.length}** lagu • **${formatDurationLong(totalSeconds)}**`, ownerLine, '', ...trackLines].join('\n')
    );
}

/**
 * Tombol-tombol di layar detail playlist -- 8 tombol dibagi 3 baris
 * berdasarkan fungsinya (bukan asal dipepetin biar muat 5/baris), biar
 * enak diliat:
 *   row1 (Secondary, buat SEMUA member): Play, Add, Add Antrian
 *   row2 (aksi ngubah playlist -- Danger buat yang destruktif): Rename, Hapus, Hapus Playlist
 *   row3 (navigasi): Back, Home
 * Nama playlist-nya dikodein di tiap customId (`::<nama>`) biar handler-nya
 * di index.js tau lagi ngurusin playlist yang mana. "Add" cuma nambahin SATU
 * lagu yang lagi diputar sekarang, sedangkan "Add Antrian" nambahin SEMUA
 * lagu yang lagi diputar + di antrian sekaligus (dobel/link yang udah ada di
 * playlist otomatis dilewatin, nggak nyimpen 2x). "Hapus" cuma ngehapus SATU
 * lagu (lewat modal, minta nomor urutnya), sedangkan "Hapus Playlist"
 * ngehapus SELURUH playlist-nya langsung (nggak ada modal, langsung ke
 * overview) -- ini versi tombol dari `/playlist delete`.
 *
 * `canManage` = boolean (dari `playlistStore.canDelete(...).allowed` yang
 * manggil) -- kalau `false` (bukan pemilik playlist ini), Add/Add
 * Antrian/Rename/Hapus/Hapus Playlist ditampilin DISABLED (member itu cuma
 * boleh Play). Server-side tetep ada pengecekan sendiri di tiap handler-nya
 * (jaga-jaga), ini cuma biar UI-nya nggak nawarin tombol yang bakal ditolak.
 */
function buildPlaylistDetailButtons(name, canManage) {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`panelplaylist_play::${name}`).setLabel('Play').setEmoji('▶️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`panelplaylist_add::${name}`)
      .setLabel('Add')
      .setEmoji('➕')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!canManage),
    new ButtonBuilder()
      .setCustomId(`panelplaylist_addqueue::${name}`)
      .setLabel('Add Antrian')
      .setEmoji('📥')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!canManage)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`panelplaylist_rename::${name}`)
      .setLabel('Rename')
      .setEmoji('✏️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!canManage),
    new ButtonBuilder()
      .setCustomId(`panelplaylist_deletetrack::${name}`)
      .setLabel('Hapus')
      .setEmoji('🗑️')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!canManage),
    new ButtonBuilder()
      .setCustomId(`panelplaylist_deleteall::${name}`)
      .setLabel('Hapus Playlist')
      .setEmoji('💥')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!canManage)
  );
  const row3 = new ActionRowBuilder().addComponents(
    buildBackButton('panel_music'),
    buildHomeButton()
  );
  return [row1, row2, row3];
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
  // Playlist ini SHARED (dibuka dari layar detail playlist yang udah ADA),
  // tapi yang boleh nambahin lagu ke situ cuma pemilik/pembuatnya -- member
  // lain cuma boleh Play. Playlist "yatim" fallback ke izin Manage Server.
  const hasManageGuild = !!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
  const check = playlistStore.canDelete(interaction.guildId, name, interaction.user.id, hasManageGuild);
  if (!check.allowed) {
    await interaction.reply({ embeds: [textEmbed(buildAddDenialMessage(name, check))], flags: MessageFlags.Ephemeral });
    return;
  }

  const queue = musicManager.getQueue(interaction.guildId);
  const current = queue.current;
  if (!current) {
    await interaction.reply({
      embeds: [textEmbed('Nggak ada lagu yang lagi diputar buat ditambahin ke playlist.')],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const result = playlistStore.appendToPlaylist(interaction.guildId, name, [current], {
    id: interaction.user.id,
    tag: interaction.user.tag,
  });

  const message =
    result.addedCount > 0
      ? `**${current.title}** ditambahin ke playlist **${name}** (total sekarang: ${result.trackCount} lagu).`
      : `**${current.title}** udah ada di playlist **${name}**, nggak ditambahin lagi (biar nggak dobel).`;
  await interaction.reply({ embeds: [textEmbed(message)], flags: MessageFlags.Ephemeral });
}

/**
 * Tombol "Add Antrian" di layar detail playlist -- nambahin SEMUA lagu yang
 * lagi diputar SEKARANG + yang lagi ANTRI (bukan cuma 1 lagu kayak tombol
 * "Add" biasa) ke playlist yang lagi dibuka sekaligus. Cocok dipakai pas
 * user udah nge-queue banyak lagu terus mau nyimpen semuanya jadi playlist
 * tanpa harus Add satu-satu. Lagu yang linknya UDAH ADA di playlist ini
 * otomatis dilewatin (nggak nyimpen dobel) -- makanya pesannya nyebutin
 * berapa yang beneran baru vs berapa yang dilewatin karena dobel.
 */
async function addQueueToPlaylist(interaction, name) {
  const hasManageGuild = !!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
  const check = playlistStore.canDelete(interaction.guildId, name, interaction.user.id, hasManageGuild);
  if (!check.allowed) {
    await interaction.reply({ embeds: [textEmbed(buildAddDenialMessage(name, check))], flags: MessageFlags.Ephemeral });
    return;
  }

  const queue = musicManager.getQueue(interaction.guildId);
  const tracks = [queue.current, ...queue.tracks].filter(Boolean);
  if (tracks.length === 0) {
    await interaction.reply({
      embeds: [textEmbed('Nggak ada musik yang lagi diputar/diantrikan buat ditambahin ke playlist.')],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const result = playlistStore.appendToPlaylist(interaction.guildId, name, tracks, {
    id: interaction.user.id,
    tag: interaction.user.tag,
  });

  let message = `${result.addedCount} lagu ditambahin ke playlist **${name}** (total sekarang: ${result.trackCount} lagu).`;
  if (result.skippedDuplicates > 0) {
    message += ` ${result.skippedDuplicates} lagu dilewatin karena udah ada di playlist ini (dobel).`;
  }
  if (result.truncated) {
    message += `\n\nPlaylist udah kena batas maksimal ${playlistStore.MAX_TRACKS_PER_PLAYLIST} lagu, sisanya dipotong.`;
  }
  await interaction.reply({ embeds: [textEmbed(message)], flags: MessageFlags.Ephemeral });
}

/**
 * Pesan penolakan seragam buat SEMUA aksi yang dibatesin ke pemilik playlist
 * (hapus, rename, add/nambah lagu -- lewat tombol panel, slash command,
 * prefix command, atau lewat AI) -- `actionPhrase` ngisi kata kerjanya
 * (misal "hapus", "ganti nama", "nambahin lagu ke"). Teksnya beda tergantung
 * alasan: playlist nggak ketemu, bukan pemilik, atau playlist "yatim"
 * (dibuat sebelum fitur pemilik ini ada, perlu izin Manage Server).
 */
function buildOwnerDenialMessage(name, check, actionPhrase) {
  if (check.reason === 'not_found') {
    return `Playlist **${name}** nggak ketemu.`;
  }
  if (check.reason === 'orphaned') {
    return `Playlist **${name}** dibuat sebelum fitur "pemilik playlist" ada -- cuma yang punya izin Manage Server yang bisa ${actionPhrase} playlist ini.`;
  }
  const ownerTag = check.owner?.ownerTag;
  return ownerTag
    ? `Cuma **${ownerTag}** (pemilik/pembuat playlist ini) yang bisa ${actionPhrase} playlist **${name}**. Member lain cuma bisa Play aja.`
    : `Cuma pemilik/pembuat playlist **${name}** yang bisa ${actionPhrase}nya. Member lain cuma bisa Play aja.`;
}

/** Pesan penolakan buat aksi HAPUS (whole-playlist maupun 1 lagu). */
function buildDeleteDenialMessage(name, check) {
  return buildOwnerDenialMessage(name, check, 'hapus');
}

/** Pesan penolakan buat aksi GANTI NAMA (rename). */
function buildRenameDenialMessage(name, check) {
  return buildOwnerDenialMessage(name, check, 'ganti nama');
}

/** Pesan penolakan buat aksi NAMBAHIN LAGU (add / save nimpa playlist yang udah ada). */
function buildAddDenialMessage(name, check) {
  return buildOwnerDenialMessage(name, check, 'nambahin lagu ke');
}

/** Modal hapus 1 lagu dari playlist -- minta nomor urut lagunya (liat daftar di layar detail). */
function buildDeleteTrackModal(name) {
  const modal = new ModalBuilder().setCustomId(`panelplaylist_deletetrack_modal::${name}`).setTitle('Hapus Lagu dari Playlist');
  const numberInput = new TextInputBuilder()
    .setCustomId('panelplaylist_track_number')
    .setLabel('Nomor lagu (liat daftar di atas)')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(4)
    .setPlaceholder('misal: 3');
  modal.addComponents(new ActionRowBuilder().addComponents(numberInput));
  return modal;
}

/**
 * Handler submit modal hapus lagu -- validasi nomor, cek pemilik playlist,
 * baru panggil playlistStore.removeTrackAt. Pengecekan pemilik diulang di
 * sini (bukan cuma di tombol yang munculin modalnya) buat jaga-jaga kalau
 * ada yang manggil submit modal ini langsung tanpa lewat tombol.
 */
async function handleDeleteTrackModalSubmit(interaction, name) {
  const hasManageGuild = !!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
  const check = playlistStore.canDelete(interaction.guildId, name, interaction.user.id, hasManageGuild);
  if (!check.allowed) {
    await interaction.reply({ embeds: [textEmbed(buildDeleteDenialMessage(name, check))], flags: MessageFlags.Ephemeral });
    return;
  }

  const raw = interaction.fields.getTextInputValue('panelplaylist_track_number')?.trim();
  const index = parseInt(raw, 10);
  if (!Number.isInteger(index) || index < 1) {
    await interaction.reply({
      content: 'Nomor lagu nggak valid -- masukin angka sesuai urutan di daftar (misal: 3).',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const result = playlistStore.removeTrackAt(interaction.guildId, name, index);
  if (!result.ok) {
    const msg =
      result.reason === 'not_found'
        ? `Playlist **${name}** nggak ketemu (mungkin udah kehapus).`
        : `Nomor ${index} nggak ada di playlist **${name}**.`;
    await interaction.reply({ embeds: [textEmbed(msg)], flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.reply({
    embeds: [
      textEmbed(`🗑️ **${result.removedTitle}** dihapus dari playlist **${name}** (sisa ${result.trackCount} lagu).`),
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

/**
 * Handler submit modal rename -- validasi nama baru, cek pemilik playlist,
 * baru panggil playlistStore.renamePlaylist. Pengecekan pemilik diulang di
 * sini (bukan cuma di tombol yang munculin modalnya) buat jaga-jaga kalau
 * ada yang manggil submit modal ini langsung tanpa lewat tombol.
 */
async function handleRenameModalSubmit(interaction, oldName) {
  const hasManageGuild = !!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
  const check = playlistStore.canDelete(interaction.guildId, oldName, interaction.user.id, hasManageGuild);
  if (!check.allowed) {
    await interaction.reply({ embeds: [textEmbed(buildRenameDenialMessage(oldName, check))], flags: MessageFlags.Ephemeral });
    return;
  }

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

      // Nama BARU (belum ada) selalu boleh -- yang nyimpen otomatis jadi
      // pemiliknya. Tapi kalau namanya udah dipakai playlist yang ADA, cuma
      // pemiliknya yang boleh nimpa isinya (member lain cuma boleh Play).
      const hasManageGuildSave = !!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
      const modifyCheck = playlistStore.canModify(interaction.guildId, name, interaction.user.id, hasManageGuildSave);
      if (!modifyCheck.allowed) {
        await interaction.reply({ embeds: [textEmbed(buildAddDenialMessage(name, modifyCheck))], flags: MessageFlags.Ephemeral });
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
        result = playlistStore.savePlaylist(interaction.guildId, name, tracks, {
          id: interaction.user.id,
          tag: interaction.user.tag,
        });
      } catch (err) {
        await interaction.reply({ embeds: [textEmbed(err.message)], flags: MessageFlags.Ephemeral });
        return;
      }

      const verb = result.isNew ? 'disimpan' : 'diupdate';
      let message = `Playlist **${name}** ${verb} (${result.trackCount} lagu).`;
      if (result.skippedDuplicates > 0) {
        message += ` ${result.skippedDuplicates} lagu dilewatin karena dobel (link sama).`;
      }
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

      // Nama BARU (belum ada) selalu boleh -- yang nambahin otomatis jadi
      // pemiliknya. Tapi kalau namanya udah dipakai playlist yang ADA, cuma
      // pemiliknya yang boleh nambahin lagu ke situ (member lain cuma boleh
      // Play). Dicek DULUAN sebelum resolve link satu-satu biar nggak
      // buang-buang waktu kalau bakal ditolak.
      const hasManageGuildAdd = !!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
      const modifyCheck = playlistStore.canModify(interaction.guildId, name, interaction.user.id, hasManageGuildAdd);
      if (!modifyCheck.allowed) {
        await interaction.reply({ embeds: [textEmbed(buildAddDenialMessage(name, modifyCheck))], flags: MessageFlags.Ephemeral });
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
        result = playlistStore.appendToPlaylist(interaction.guildId, name, resolvedTracks, {
          id: interaction.user.id,
          tag: interaction.user.tag,
        });
      } catch (err) {
        await interaction.editReply({ embeds: [textEmbed(err.message)] });
        return;
      }

      let message = `${result.addedCount} lagu ditambahkan ke playlist **${name}** (total sekarang: ${result.trackCount} lagu).`;
      if (result.skippedDuplicates > 0) message += ` ${result.skippedDuplicates} lagu dilewatin karena udah ada di playlist ini (dobel).`;
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

      // Playlist-nya SHARED (bisa dilihat & dipakai semua member server),
      // tapi yang boleh NGEHAPUS-nya cuma pemilik/pembuat aslinya -- biar
      // nggak sembarang member bisa ngilangin playlist yang dipakai
      // bareng-bareng. Playlist "yatim" (dibuat sebelum fitur ini ada)
      // fallback ke izin Manage Server.
      const hasManageGuild = !!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
      const check = playlistStore.canDelete(interaction.guildId, name, interaction.user.id, hasManageGuild);
      if (!check.allowed) {
        await interaction.reply({
          embeds: [textEmbed(buildDeleteDenialMessage(name, check))],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

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
module.exports.addQueueToPlaylist = addQueueToPlaylist;
module.exports.buildRenameModal = buildRenameModal;
module.exports.handleRenameModalSubmit = handleRenameModalSubmit;
module.exports.buildDeleteTrackModal = buildDeleteTrackModal;
module.exports.handleDeleteTrackModalSubmit = handleDeleteTrackModalSubmit;
module.exports.buildDeleteDenialMessage = buildDeleteDenialMessage;
module.exports.buildRenameDenialMessage = buildRenameDenialMessage;
module.exports.buildAddDenialMessage = buildAddDenialMessage;
