const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const store = require('./giveawayStore');

const { loadAll, saveAll } = store;

// ============================================================
// DURATION PARSER ("1h30m", "2d", dst)
// ============================================================
const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

function parseDuration(input) {
  if (!input || typeof input !== 'string') return null;
  const cleaned = input.trim().toLowerCase().replace(/\s+/g, '');
  const regex = /(\d+)(s|m|h|d|w)/g;
  let match;
  let total = 0;
  let matchedAnything = false;
  while ((match = regex.exec(cleaned)) !== null) {
    matchedAnything = true;
    total += parseInt(match[1], 10) * UNIT_MS[match[2]];
  }
  return matchedAnything ? total : null;
}

function formatDuration(ms) {
  if (ms <= 0) return '0s';
  const units = [
    ['w', UNIT_MS.w],
    ['d', UNIT_MS.d],
    ['h', UNIT_MS.h],
    ['m', UNIT_MS.m],
    ['s', UNIT_MS.s],
  ];
  const parts = [];
  let remaining = ms;
  for (const [label, unitMs] of units) {
    const value = Math.floor(remaining / unitMs);
    if (value > 0) {
      parts.push(`${value}${label}`);
      remaining -= value * unitMs;
    }
  }
  return parts.slice(0, 2).join(' ') || '0s';
}

// ============================================================
// GIVEAWAY MANAGER (embed, tombol, undian, scheduler)
// ============================================================
const COLOR_ACTIVE = 0xf5b301;
const COLOR_ENDED_WIN = 0x57f287;
const COLOR_ENDED_EMPTY = 0xed4245;
const JOIN_BUTTON_ID = 'giveaway_join';
const CHECK_INTERVAL_MS = 15_000;

function tsField(ms) {
  return Math.floor(ms / 1000);
}

// "11/08/2026, 21:12 WIB" style timestamp untuk footer.
function formatFooterNow(date = new Date()) {
  const datePart = new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'Asia/Jakarta',
  }).format(date);
  const timePart = new Intl.DateTimeFormat('id-ID', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Jakarta',
  }).format(date);
  return `${datePart}, ${timePart} WIB`;
}

function footerText() {
  return `KokoKrunch Studio • Giveaway System • ${formatFooterNow()}`;
}

function buildActiveEmbed(g) {
  return new EmbedBuilder()
    .setColor(COLOR_ACTIVE)
    .setTitle('🎉 Giveaway Started!')
    .setDescription('Klik tombol **Join** di bawah untuk ikut giveaway ini!')
    .addFields(
      { name: '🎁 Prize', value: `**${g.prize}**`, inline: false },
      { name: '🏆 Winners', value: `${g.winnerCount}`, inline: true },
      { name: '👥 Participants', value: `${g.participants.length}`, inline: true },
      { name: '⏰ Ends', value: `<t:${tsField(g.endTime)}:F>\n(<t:${tsField(g.endTime)}:R>)`, inline: false }
    )
    .setFooter({ text: footerText() });
}

function buildActiveButtonRow(disabled = false) {
  const button = new ButtonBuilder()
    .setCustomId(JOIN_BUTTON_ID)
    .setLabel(disabled ? 'Giveaway Ended' : '🎉 Join Giveaway')
    .setStyle(disabled ? ButtonStyle.Secondary : ButtonStyle.Success)
    .setDisabled(disabled);
  return new ActionRowBuilder().addComponents(button);
}

function buildEndedEmbed(g, winnerIds, { title = '🎉 Giveaway Ended' } = {}) {
  const hasWinners = winnerIds.length > 0;
  const embed = new EmbedBuilder()
    .setColor(hasWinners ? COLOR_ENDED_WIN : COLOR_ENDED_EMPTY)
    .setTitle(title)
    .setFooter({ text: footerText() });

  if (!hasWinners) {
    embed.setDescription(`**${g.prize}**\n\n😢 Tidak ada peserta yang valid, giveaway ini tidak memiliki pemenang.`);
    return embed;
  }

  const winnerMentions = winnerIds.map((id) => `<@${id}>`).join(', ');
  embed.setDescription(
    [
      `**Congratulations ${winnerMentions}!**`,
      `You won **${g.prize}**! 🎊`,
      '',
      '📩 Kirim Username Roblox ke DM.',
      '⏳ Deadline: 5 Jam',
    ].join('\n')
  );
  return embed;
}

async function createGiveaway({ channel, host, prize, winnerCount, durationMs }) {
  const now = Date.now();
  const draft = {
    id: null,
    guildId: channel.guildId,
    channelId: channel.id,
    messageId: null,
    hostId: host.id,
    hostTag: host.tag ?? host.username,
    prize,
    winnerCount,
    participants: [],
    endTime: now + durationMs,
    createdAt: now,
    ended: false,
    winners: [],
  };

  const row = buildActiveButtonRow(false);
  const message = await channel.send({ embeds: [buildActiveEmbed({ ...draft, id: 'pending' })], components: [row] });

  draft.id = message.id;
  draft.messageId = message.id;
  await message.edit({ embeds: [buildActiveEmbed(draft)], components: [row] });

  const all = loadAll();
  all.push(draft);
  await saveAll(all);
  return draft;
}

async function toggleParticipant(giveawayId, userId) {
  const all = loadAll();
  const g = all.find((x) => x.id === giveawayId);
  if (!g || g.ended) return { ok: false, reason: 'not_found_or_ended' };

  const idx = g.participants.indexOf(userId);
  let joined;
  if (idx === -1) {
    g.participants.push(userId);
    joined = true;
  } else {
    g.participants.splice(idx, 1);
    joined = false;
  }
  await saveAll(all);
  return { ok: true, joined, giveaway: g };
}

function pickRandomWinners(participants, count) {
  const pool = [...participants];
  const winners = [];
  const n = Math.min(count, pool.length);
  for (let i = 0; i < n; i++) {
    winners.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  }
  return winners;
}

async function disableJoinButton(client, g) {
  let channel;
  try {
    channel = await client.channels.fetch(g.channelId);
  } catch (err) {
    console.error(`[giveaway] Gagal fetch channel ${g.channelId} untuk giveaway ${g.id}:`, err.message);
    return;
  }
  const message = await channel.messages.fetch(g.messageId).catch(() => null);
  if (!message) return console.warn(`[giveaway] Pesan asli ${g.messageId} untuk giveaway ${g.id} tidak ditemukan.`);

  try {
    await message.edit({ components: [buildActiveButtonRow(true)] });
  } catch (err) {
    if (err.code === 50013) {
      console.error(
        `[giveaway] Missing Permissions saat menonaktifkan tombol Join giveaway ${g.id} di #${channel.name ?? channel.id}. Cek izin "Send Messages" & "Embed Links" untuk role bot.`
      );
    } else {
      console.error(`[giveaway] Gagal menonaktifkan tombol Join giveaway ${g.id}:`, err);
    }
  }
}

async function announceWinners(client, g, embed) {
  let channel;
  try {
    channel = await client.channels.fetch(g.channelId);
  } catch (err) {
    console.error(`[giveaway] Gagal fetch channel ${g.channelId} untuk giveaway ${g.id}:`, err.message);
    return;
  }
  try {
    await channel.send({
      content: g.winners.length ? g.winners.map((id) => `<@${id}>`).join(' ') : undefined,
      embeds: [embed],
    });
  } catch (err) {
    if (err.code === 50013) {
      console.error(
        `[giveaway] Missing Permissions saat mengirim pengumuman pemenang giveaway ${g.id} di #${channel.name ?? channel.id}. Cek izin "Send Messages" & "Embed Links" untuk role bot.`
      );
    } else {
      console.error(`[giveaway] Gagal mengirim pengumuman pemenang giveaway ${g.id}:`, err);
    }
  }
}

async function updateGiveawayMessage(client, g, embed, components) {
  let channel;
  try {
    channel = await client.channels.fetch(g.channelId);
  } catch (err) {
    console.error(`[giveaway] Gagal fetch channel ${g.channelId} untuk giveaway ${g.id}:`, err.message);
    return;
  }
  const message = await channel.messages.fetch(g.messageId).catch(() => null);
  if (!message) return console.warn(`[giveaway] Pesan asli ${g.messageId} untuk giveaway ${g.id} tidak ditemukan.`);

  try {
    await message.edit({ embeds: [embed], components: components ?? [] });
  } catch (err) {
    if (err.code === 50013) {
      console.error(
        `[giveaway] Missing Permissions saat update pesan giveaway ${g.id} di #${channel.name ?? channel.id}. Cek izin "View Channel", "Send Messages", "Embed Links" untuk role bot.`
      );
    } else {
      console.error(`[giveaway] Gagal update pesan giveaway ${g.id}:`, err);
    }
  }
}

async function endGiveaway(client, giveawayId) {
  const all = loadAll();
  const g = all.find((x) => x.id === giveawayId);
  if (!g) return { ok: false, reason: 'not_found' };
  if (g.ended) return { ok: false, reason: 'already_ended' };

  const winners = pickRandomWinners(g.participants, g.winnerCount);
  g.ended = true;
  g.winners = winners;
  g.endedAt = Date.now();
  await saveAll(all);

  const endedEmbed = buildEndedEmbed(g, winners);
  await disableJoinButton(client, g);
  await announceWinners(client, g, endedEmbed);

  return { ok: true, giveaway: g, winners };
}

async function rerollGiveaway(client, giveawayId) {
  const all = loadAll();
  const g = all.find((x) => x.id === giveawayId);
  if (!g) return { ok: false, reason: 'not_found' };
  if (!g.ended) return { ok: false, reason: 'not_ended' };

  const winners = pickRandomWinners(g.participants, g.winnerCount);
  g.winners = winners;
  await saveAll(all);

  const endedEmbed = buildEndedEmbed(g, winners, { title: '🔄 Giveaway Reroll' });
  await announceWinners(client, g, endedEmbed);

  return { ok: true, giveaway: g, winners };
}

async function refreshParticipantCount(client, giveawayId) {
  const all = loadAll();
  const g = all.find((x) => x.id === giveawayId);
  if (!g || g.ended) return;
  await updateGiveawayMessage(client, g, buildActiveEmbed(g), [buildActiveButtonRow(false)]);
}

let checkerStarted = false;
function startScheduler(client) {
  if (checkerStarted) return;
  checkerStarted = true;

  const tick = async () => {
    try {
      const all = loadAll();
      const due = all.filter((g) => !g.ended && g.endTime <= Date.now());
      for (const g of due) await endGiveaway(client, g.id);
    } catch (err) {
      console.error('[giveaway] Scheduler tick gagal:', err);
    }
  };

  tick();
  setInterval(tick, CHECK_INTERVAL_MS);
}

module.exports = {
  JOIN_BUTTON_ID,
  loadAll,
  parseDuration,
  formatDuration,
  createGiveaway,
  toggleParticipant,
  endGiveaway,
  rerollGiveaway,
  refreshParticipantCount,
  startScheduler,
};
