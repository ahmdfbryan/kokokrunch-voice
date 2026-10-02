const { EmbedBuilder, PermissionFlagsBits, Routes } = require('discord.js');
const voiceControlStore = require('./voiceControlStore');

// =====================================================================
// PERMISSION HELPERS
// =====================================================================

/**
 * Boleh pakai aksi harian (Rename/Status/Lock-Unlock/Manage akses)?
 * Administrator SELALU boleh (override darurat), atau dia Owner, atau dia
 * ada di daftar Manager.
 */
function canManage(channelId, member) {
  if (!member) return false;
  if (member.permissions?.has?.(PermissionFlagsBits.Administrator)) return true;
  const entry = voiceControlStore.getEntry(channelId);
  if (entry.ownerId && entry.ownerId === member.id) return true;
  if (entry.managerIds.includes(member.id)) return true;
  return false;
}

/**
 * Boleh atur daftar Manager / transfer kepemilikan? Cuma Owner (atau
 * Administrator sebagai override) -- Manager BIASA nggak boleh, sesuai
 * yang diminta user.
 */
function canManageOwnership(channelId, member) {
  if (!member) return false;
  if (member.permissions?.has?.(PermissionFlagsBits.Administrator)) return true;
  const entry = voiceControlStore.getEntry(channelId);
  return !!(entry.ownerId && entry.ownerId === member.id);
}

/**
 * Boleh klaim kepemilikan pertama kali? Cuma kalau BELUM ada owner sama
 * sekali, DAN dia punya izin Manage Channels (atau Administrator).
 */
function canClaimOwnership(channelId, member) {
  if (!member) return false;
  const entry = voiceControlStore.getEntry(channelId);
  if (entry.ownerId) return false;
  return !!(
    member.permissions?.has?.(PermissionFlagsBits.Administrator) ||
    member.permissions?.has?.(PermissionFlagsBits.ManageChannels)
  );
}

// =====================================================================
// LOCK STATE
// =====================================================================

/** Cek apakah channel lagi dikunci (role @everyone di-deny izin Connect). */
function isChannelLocked(channel) {
  const everyoneId = channel.guild.roles.everyone.id;
  const overwrite = channel.permissionOverwrites.cache.get(everyoneId);
  if (!overwrite) return false;
  return overwrite.deny?.has?.(PermissionFlagsBits.Connect) || false;
}

// =====================================================================
// EMBED
// =====================================================================

function buildVoiceControlEmbed(channel, member) {
  const entry = voiceControlStore.getEntry(channel.id);
  const locked = isChannelLocked(channel);

  const ownerLine = entry.ownerId ? `<@${entry.ownerId}>` : '*Belum ada owner*';
  const managerLine = entry.managerIds.length > 0 ? entry.managerIds.map((id) => `<@${id}>`).join(', ') : '*Belum ada manager*';
  const statusLine = entry.statusText ? entry.statusText : '*Belum di-set*';

  const embed = new EmbedBuilder()
    .setColor(locked ? 0xed4245 : 0x57f287)
    .setTitle('🎛️ Voice Control')
    .setDescription(`Kontrol buat channel voice **${channel.name}**.`)
    .addFields(
      { name: 'Status Kunci', value: locked ? '🔒 Terkunci' : '🔓 Terbuka', inline: true },
      { name: 'Voice Status', value: statusLine, inline: true },
      { name: 'Owner', value: ownerLine, inline: false },
      { name: 'Manager', value: managerLine, inline: false },
    );

  return embed;
}

// =====================================================================
// ACTIONS
// =====================================================================

async function claimOwnership(channel, member) {
  return voiceControlStore.claimOwnership(channel.id, member.id, member.user?.tag || member.id);
}

async function transferOwnership(channel, newOwner) {
  return voiceControlStore.transferOwnership(channel.id, newOwner.id, newOwner.user?.tag || newOwner.id);
}

async function addManager(channel, newManager) {
  return voiceControlStore.addManager(channel.id, newManager.id);
}

async function removeManager(channel, managerMember) {
  return voiceControlStore.removeManager(channel.id, managerMember.id);
}

async function renameChannel(channel, newName, reason) {
  await channel.setName(newName, reason);
}

/** Set voice status native Discord -- belum ada helper resmi di discord.js, jadi manual lewat REST. */
async function setChannelStatus(client, channel, text) {
  await client.rest.put(Routes.channelVoiceStatus(channel.id), { body: { status: text || null } });
  voiceControlStore.setStatusText(channel.id, text || null);
}

/**
 * Toggle lock/unlock. Lock = deny Connect buat @everyone. Unlock = clear
 * (null) biar balik ke bawaan/role lain, BUKAN set `true` (biar nggak
 * nimpa pengaturan role lain yang mungkin udah ngatur akses sendiri).
 * Selalu mastiin bot sendiri punya allow-override Connect biar nggak
 * kejebak kelock pas reconnect gara-gara locking sendiri.
 */
async function toggleLock(channel) {
  const everyoneId = channel.guild.roles.everyone.id;
  const locked = isChannelLocked(channel);

  if (locked) {
    await channel.permissionOverwrites.edit(everyoneId, { Connect: null }, { reason: 'Voice Control: unlock' });
  } else {
    await channel.permissionOverwrites.edit(everyoneId, { Connect: false }, { reason: 'Voice Control: lock' });
    const botId = channel.client.user?.id;
    if (botId) {
      await channel.permissionOverwrites.edit(botId, { Connect: true }, { reason: 'Voice Control: self-protect saat lock' });
    }
  }

  return { ok: true, locked: !locked };
}

/** Izinkan member tertentu connect walau channel lagi dikunci. */
async function allowMember(channel, targetMember) {
  await channel.permissionOverwrites.edit(targetMember.id, { Connect: true }, { reason: 'Voice Control: izinkan masuk' });
}

/** Blokir member tertentu + keluarkan paksa kalau dia lagi connect di channel ini. */
async function blockMember(channel, targetMember) {
  const botId = channel.client.user?.id;
  if (botId && targetMember.id === botId) {
    return { ok: false, reason: 'cannot_block_self' };
  }

  await channel.permissionOverwrites.edit(targetMember.id, { Connect: false }, { reason: 'Voice Control: blokir' });

  if (targetMember.voice?.channelId === channel.id) {
    try {
      await targetMember.voice.disconnect('Voice Control: diblokir dari channel');
    } catch {
      // best-effort -- kalau gagal disconnect, overwrite-nya tetep kepasang
    }
  }

  return { ok: true };
}

/** Hapus override izin/blokir member tertentu, balik ke bawaan/role. */
async function clearMemberOverride(channel, targetMember) {
  await channel.permissionOverwrites.delete(targetMember.id, 'Voice Control: hapus izin/buka blokir');
}

module.exports = {
  canManage,
  canManageOwnership,
  canClaimOwnership,
  isChannelLocked,
  buildVoiceControlEmbed,
  claimOwnership,
  transferOwnership,
  addManager,
  removeManager,
  renameChannel,
  setChannelStatus,
  toggleLock,
  allowMember,
  blockMember,
  clearMemberOverride,
};
