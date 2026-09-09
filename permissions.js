const config = require('./config');

/**
 * Cek apakah member boleh /stop atau /skip musik: owner server, punya role
 * Staff, ATAU dia yang minta lagu yang LAGI DIPUTAR sekarang. Selain itu
 * (termasuk yang minta lagu LAIN di antrian, bukan yang lagi main), ditolak.
 *
 * `member` = GuildMember (dari interaction.member / message.member).
 * `currentTrack` = queue.current, boleh null.
 */
function canControlPlayback(member, currentTrack) {
  if (!member) return false;
  if (member.guild?.ownerId === member.id) return true;
  if (config.staffRoleId && member.roles?.cache?.has(config.staffRoleId)) return true;
  if (currentTrack && currentTrack.requestedById && currentTrack.requestedById === member.id) return true;
  return false;
}

/**
 * Versi async buat konteks yang cuma punya userId mentah (bukan member
 * object langsung) -- dipakai AI tool call, yang cuma nyimpen guildId +
 * userId, bukan reference GuildMember. Fetch dulu baru delegasiin ke
 * canControlPlayback yang sinkron di atas.
 */
async function canControlPlaybackByUserId(client, guildId, userId, currentTrack) {
  try {
    const guild = await client.guilds.fetch(guildId);
    const member = await guild.members.fetch(userId);
    return canControlPlayback(member, currentTrack);
  } catch {
    return false;
  }
}

module.exports = { canControlPlayback, canControlPlaybackByUserId };
