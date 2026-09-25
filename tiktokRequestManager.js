// Handler buat request musik yang datang dari comment "!request <judul>" di
// live TikTok -- alurnya sama persis kayak /play (resolve -> enqueue ->
// card Now Playing), cuma balesannya dikirim ke channel biasa (channel.send)
// soalnya nggak ada "interaction" Discord di sini, beda dari /play.

const { EmbedBuilder } = require('discord.js');
const musicManager = require('./musicManager');
const { resolveTrack } = require('./trackResolver');
const { claimNowPlayingCard } = require('./nowPlayingCard');
const { COLOR, textEmbed, formatEta } = require('./musicFormat');

async function handleTikTokRequest({ guildId, channel, client, query, requester, log }) {
  const requestedByLabel = `${requester} (TikTok LIVE)`;

  let track;
  try {
    track = await resolveTrack(query);
  } catch (err) {
    log(`[TIKTOK] Resolve gagal buat request "${query}" dari @${requester}: ${err.message}`);
    try {
      await channel.send({
        embeds: [textEmbed(`❌ Request TikTok LIVE dari **${requester}** gagal: ${err.message}\n> \`!request ${query}\``)],
      });
    } catch (sendErr) {
      log(`[TIKTOK] Gagal kirim pesan error request: ${sendErr?.message || sendErr}`);
    }
    return;
  }

  track.requestedBy = requestedByLabel;
  track.requestedById = null;

  musicManager.setTextChannel(guildId, channel.id);
  const { position, startedImmediately, etaSeconds } = musicManager.enqueue(guildId, track);

  try {
    if (startedImmediately) {
      await claimNowPlayingCard(guildId, client, (embed, components) => channel.send({ embeds: [embed], components }));
    } else {
      const embed = new EmbedBuilder()
        .setColor(COLOR)
        .setDescription(`🎵 **${track.title}** ditambahkan ke antrian\n📱 Request dari TikTok LIVE **${requester}**`)
        .setThumbnail(track.thumbnail || null)
        .addFields(
          { name: 'Estimated time until played', value: formatEta(etaSeconds), inline: true },
          { name: 'Track Length', value: track.durationText || '?', inline: true },
          { name: 'Position in queue', value: `#${position}`, inline: true },
          { name: 'Request by', value: requestedByLabel, inline: true }
        );
      await channel.send({ embeds: [embed] });
    }
  } catch (err) {
    log(`[TIKTOK] Gagal kirim pesan hasil request "${query}": ${err?.message || err}`);
  }
}

module.exports = { handleTikTokRequest };
