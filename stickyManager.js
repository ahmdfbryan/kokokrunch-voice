const { EmbedBuilder } = require('discord.js');
const stickyStore = require('./stickyMessage');

// Nunggu jeda ini dulu (nggak ada pesan baru) sebelum sticky dipindah ke
// bawah -- biar nggak delete+send berkali-kali kalau chat lagi rame.
const DEBOUNCE_MS = 3000;
// Tapi kalau chat-nya nggak berhenti-berhenti, tetep paksa repost maksimal
// tiap segini, biar sticky nggak "ketimbun" kelamaan.
const MAX_WAIT_MS = 20_000;

// channelId -> { debounceTimeout, maxTimeout }
const timers = new Map();

let client = null;
let log = console.log;

function init(discordClient, logger) {
  client = discordClient;
  if (logger) log = logger;
}

/**
 * Dipanggil tiap kali ada pesan baru (bukan dari bot) masuk ke channel yang
 * punya sticky aktif. Jadwalin repost dengan debounce.
 */
function scheduleRepost(channelId) {
  const sticky = stickyStore.getSticky(channelId);
  if (!sticky) return;

  let entry = timers.get(channelId);
  if (!entry) {
    entry = { debounceTimeout: null, maxTimeout: null };
    timers.set(channelId, entry);
    entry.maxTimeout = setTimeout(() => doRepost(channelId), MAX_WAIT_MS);
  }

  if (entry.debounceTimeout) clearTimeout(entry.debounceTimeout);
  entry.debounceTimeout = setTimeout(() => doRepost(channelId), DEBOUNCE_MS);
}

async function doRepost(channelId) {
  const entry = timers.get(channelId);
  if (entry) {
    clearTimeout(entry.debounceTimeout);
    clearTimeout(entry.maxTimeout);
    timers.delete(channelId);
  }

  const sticky = stickyStore.getSticky(channelId);
  if (!sticky) return;

  try {
    const channel = await client.channels.fetch(channelId);

    if (sticky.stickyMessageId) {
      try {
        const oldMsg = await channel.messages.fetch(sticky.stickyMessageId);
        await oldMsg.delete();
      } catch {
        // udah kehapus manual / nggak ketemu, aman diabaikan
      }
    }

    const embeds = (sticky.embeds || []).map((e) => EmbedBuilder.from(e));
    const sent = await channel.send({ content: sticky.content || undefined, embeds });
    stickyStore.setStickyMessageId(channelId, sent.id);
  } catch (err) {
    log(`[STICKY] Gagal repost sticky di channel ${channelId}: ${err.message}`);
  }
}

module.exports = { init, scheduleRepost };
