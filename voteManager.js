// Voteskip/votestop: kalau owner, staff, ATAU yang minta lagu yang lagi
// diputar nggak ada satupun di voice channel, orang biasa tetap bisa
// skip/stop lewat voting -- butuh mayoritas (>50%) dari orang yang lagi
// ada di voice channel (non-bot). Vote kadaluarsa otomatis 30 detik kalau
// nggak mencukupi. Cuma boleh ADA 1 sesi vote aktif per guild dalam waktu
// bersamaan (skip dan stop nggak bisa jalan bareng).

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const config = require('./config');
const permissions = require('./permissions');
const musicManager = require('./musicManager');

const VOTE_TIMEOUT_MS = 30_000;
const COLOR_ACTIVE = 0xfaa61a;
const COLOR_DONE = 0x5865f2;

const activeVotes = new Map(); // guildId -> session

function actionLabel(action) {
  return action === 'skip' ? 'Skip' : 'Stop';
}

/**
 * Semua member non-bot yang lagi ada di voice channel target bot.
 */
function getVoiceChannelMembers(guild) {
  const channel = guild.channels.cache.get(config.voiceChannelId);
  if (!channel || !channel.isVoiceBased()) return [];
  return [...channel.members.values()].filter((m) => !m.user.bot);
}

/**
 * Apakah ada owner/staff/requester lagu ini yang lagi standby di voice
 * channel? Kalau ada, voting nggak perlu -- mereka yang harus mutusin.
 */
function isAuthorityPresent(guild, currentTrack) {
  const members = getVoiceChannelMembers(guild);
  return members.some((m) => permissions.canControlPlayback(m, currentTrack));
}

function getActiveVote(guildId) {
  return activeVotes.get(guildId) || null;
}

function buildVoteMessage(session) {
  const label = actionLabel(session.action);
  const embed = new EmbedBuilder()
    .setColor(COLOR_ACTIVE)
    .setDescription(
      `🗳️ Vote **${label}** untuk **"${session.trackTitle}"**\n\n` +
        `${session.votes.size}/${session.required} vote (dari ${session.total} orang di voice channel)\n` +
        `Vote otomatis batal dalam 30 detik kalau nggak mencukupi.`
    );
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('vote_cast')
      .setLabel(`Vote ${label} (${session.votes.size}/${session.required})`)
      .setEmoji('🗳️')
      .setStyle(ButtonStyle.Primary)
  );
  return { embeds: [embed], components: [row] };
}

async function editSessionMessage(client, session, text) {
  try {
    const channel = await client.channels.fetch(session.channelId);
    const message = await channel.messages.fetch(session.messageId);
    await message.edit({ embeds: [new EmbedBuilder().setColor(COLOR_DONE).setDescription(text)], components: [] });
  } catch {
    // pesan udah kehapus / nggak ketemu, aman diabaikan
  }
}

/**
 * Vote udah cukup ATAU kadaluarsa -- eksekusi (kalau sukses) atau batalin,
 * lalu bersihin sesi.
 */
async function resolveVote(client, guildId, success) {
  const session = activeVotes.get(guildId);
  if (!session) return;
  clearTimeout(session.timeoutHandle);
  activeVotes.delete(guildId);

  if (!success) {
    await editSessionMessage(client, session, `⏱️ Vote ${actionLabel(session.action)} kadaluarsa, vote nggak mencukupi.`);
    return;
  }

  let resultText;
  if (session.action === 'skip') {
    const ok = musicManager.skip(guildId);
    resultText = ok ? `✅ Vote berhasil! **${session.trackTitle}** di-skip.` : '✅ Vote berhasil, tapi lagunya udah nggak ada.';
  } else {
    const ok = musicManager.stop(guildId);
    resultText = ok ? '✅ Vote berhasil! Musik dihentikan, antrian dikosongkan.' : '✅ Vote berhasil, tapi musiknya udah berhenti duluan.';
  }
  await editSessionMessage(client, session, resultText);
}

/**
 * Tombol "Vote Skip/Stop" diklik. `interaction` = ButtonInteraction.
 */
async function castVote(interaction) {
  const guildId = interaction.guildId;
  const session = activeVotes.get(guildId);
  if (!session) {
    await interaction.reply({ content: 'Vote ini udah kadaluarsa atau selesai.', flags: MessageFlags.Ephemeral });
    return;
  }

  const members = getVoiceChannelMembers(interaction.guild);
  if (!members.some((m) => m.id === interaction.user.id)) {
    await interaction.reply({ content: 'Kamu harus ada di voice channel buat ikut vote.', flags: MessageFlags.Ephemeral });
    return;
  }

  if (session.votes.has(interaction.user.id)) {
    await interaction.reply({ content: 'Kamu udah vote buat ini.', flags: MessageFlags.Ephemeral });
    return;
  }

  session.votes.add(interaction.user.id);

  if (session.votes.size >= session.required) {
    await interaction.deferUpdate();
    await resolveVote(interaction.client, guildId, true);
    return;
  }

  const { embeds, components } = buildVoteMessage(session);
  await interaction.update({ embeds, components });
}

/**
 * Titik masuk utama dari /skip, /stop, s!skip, s!stop -- dipanggil SETELAH
 * dipastikan `member` nggak punya izin langsung (bukan owner/staff/requester)
 * DAN nggak ada satupun otoritas yang standby di voice channel.
 *
 * `sendPublic(payload)` -> kirim pesan BARU yang keliatan semua orang,
 * harus resolve ke Message (buat di-track messageId-nya).
 * `replyPrivate(text)` -> kasih tau balik ke yang minta doang (ephemeral
 * kalau slash command, atau pesan biasa kalau prefix -- terserah caller).
 */
async function handleVoteRequest({ guild, member, channelId, action, currentTrack, client, sendPublic, replyPrivate }) {
  const members = getVoiceChannelMembers(guild);
  const isMemberInVoice = members.some((m) => m.id === member.id);
  if (!isMemberInVoice) {
    await replyPrivate('Kamu harus ada di voice channel buat mulai atau ikut vote.');
    return;
  }

  const existing = activeVotes.get(guild.id);
  if (existing) {
    if (existing.action !== action) {
      await replyPrivate(
        `Lagi ada vote buat **${actionLabel(existing.action)}** yang masih berlangsung, tunggu itu selesai dulu (maks 30 detik).`
      );
      return;
    }
    if (existing.votes.has(member.id)) {
      await replyPrivate('Kamu udah vote buat ini.');
      return;
    }

    existing.votes.add(member.id);

    if (existing.votes.size >= existing.required) {
      await resolveVote(client, guild.id, true);
    } else {
      const { embeds, components } = buildVoteMessage(existing);
      try {
        const channel = await client.channels.fetch(existing.channelId);
        const msg = await channel.messages.fetch(existing.messageId);
        await msg.edit({ embeds, components });
      } catch {
        // aman diabaikan
      }
      await replyPrivate(`Vote kamu buat **${actionLabel(action)}** udah dicatat (${existing.votes.size}/${existing.required}).`);
    }
    return;
  }

  const required = Math.floor(members.length / 2) + 1;
  const votes = new Set([member.id]);

  // Cuma dia sendirian (atau vote 1 orang udah cukup) -- langsung eksekusi,
  // nggak perlu bikin sesi vote formal.
  if (votes.size >= required) {
    if (action === 'skip') {
      const ok = musicManager.skip(guild.id);
      await sendPublic({
        embeds: [
          new EmbedBuilder()
            .setColor(COLOR_DONE)
            .setDescription(ok ? `**${currentTrack?.title}** di-skip (cuma kamu di voice channel).` : 'Nggak ada lagu yang lagi diputar.'),
        ],
      });
    } else {
      const ok = musicManager.stop(guild.id);
      await sendPublic({
        embeds: [
          new EmbedBuilder()
            .setColor(COLOR_DONE)
            .setDescription(ok ? 'Musik dihentikan (cuma kamu di voice channel).' : 'Nggak ada musik yang lagi diputar.'),
        ],
      });
    }
    return;
  }

  const session = {
    action,
    votes,
    required,
    total: members.length,
    channelId,
    trackTitle: currentTrack?.title || '(tidak diketahui)',
    timeoutHandle: null,
    messageId: null,
  };
  session.timeoutHandle = setTimeout(() => resolveVote(client, guild.id, false), VOTE_TIMEOUT_MS);
  activeVotes.set(guild.id, session);

  const { embeds, components } = buildVoteMessage(session);
  const sentMessage = await sendPublic({ embeds, components });
  session.messageId = sentMessage.id;
}

module.exports = { isAuthorityPresent, handleVoteRequest, castVote, getActiveVote };
