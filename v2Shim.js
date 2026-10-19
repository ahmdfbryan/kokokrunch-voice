// Penerjemah terpusat: semua pesan yang masih ditulis dalam format embed
// (`embeds: [...]`) otomatis dikirim sebagai Components V2 bergaya "premium"
// (Container beraksen warna, judul besar, thumbnail di sisi kanan, pemisah
// tipis, tombol/dropdown ikut masuk ke dalam kartu). Dipasang SEKALI di
// MessagePayload.resolveBody milik discord.js, jadi berlaku untuk semua jalur
// kirim sekaligus: interaction.reply/update/editReply/followUp, channel.send,
// message.edit, dll -- nggak perlu ubah ratusan titik pemanggilan satu-satu.
//
// Aturan Components V2 yang ditangani di sini:
//  - `content` & `embeds` DILARANG di pesan V2 -> content dilipat jadi teks
//    di atas kartu, embed dikonversi jadi Container.
//  - Maks 40 komponen & 4000 karakter teks per pesan -> teks dipotong rapi.
//  - TextDisplay/Section tidak boleh kosong.

const {
  ContainerBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  ThumbnailBuilder,
  ActionRowBuilder,
  MessageFlags,
  MessagePayload,
} = require('discord.js');

const BRAND_COLOR = 0x3b82f6; // biru Noname -- dipakai kalau embed nggak punya warna sendiri
const MAX_TOTAL_TEXT = 3900; // batas Discord 4000, sisakan ruang aman
const MAX_COMPONENTS = 40;

function toJSON(x) {
  return x && typeof x.toJSON === 'function' ? x.toJSON() : x;
}

function clip(text, max) {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

/**
 * Ubah 1 embed (+ opsional action row) jadi satu ContainerBuilder.
 * `budget.text` = sisa jatah karakter teks buat seluruh pesan (dimutasi).
 * `budget.count` = sisa jatah jumlah komponen (dimutasi).
 */
function embedToContainer(rawEmbed, rows, budget) {
  const e = toJSON(rawEmbed) || {};
  const container = new ContainerBuilder().setAccentColor(typeof e.color === 'number' ? e.color : BRAND_COLOR);
  budget.count -= 1; // container itu sendiri

  const take = (text) => {
    const clipped = clip(text, Math.max(1, budget.text));
    budget.text -= clipped.length;
    return clipped;
  };

  // --- Blok utama: header kecil (author) + judul + deskripsi ---
  const head = [];
  if (e.author?.name) head.push(`-# ${e.author.name.trim()}`);
  if (e.title) head.push(e.url ? `## [${e.title}](${e.url})` : `## ${e.title}`);
  if (e.description) head.push(e.description);
  const mainText = take(head.join('\n').trim());

  const thumbUrl = e.thumbnail?.url;
  if (mainText) {
    if (thumbUrl && budget.count >= 3) {
      container.addSectionComponents(
        new SectionBuilder()
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(mainText))
          .setThumbnailAccessory(new ThumbnailBuilder().setURL(thumbUrl))
      );
      budget.count -= 3;
    } else {
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(mainText));
      budget.count -= 1;
    }
  }

  // --- Fields -> blok teks, dipisah garis tipis dari blok utama ---
  const fieldLines = (e.fields || [])
    .map((f) => {
      const name = (f.name || '').replace(/​/g, '').trim();
      const value = (f.value || '').replace(/​/g, '').trim();
      if (!name && !value) return '';
      return name ? `**${name}**\n${value}` : value;
    })
    .filter(Boolean);
  if (fieldLines.length > 0 && budget.count >= 3) {
    const fieldText = take(fieldLines.join('\n\n'));
    if (fieldText) {
      if (mainText) {
        container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
        budget.count -= 1;
      }
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(fieldText));
      budget.count -= 1;
    }
  }

  // --- Gambar besar ---
  if (e.image?.url && budget.count >= 2) {
    container.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(e.image.url)));
    budget.count -= 2;
  }

  // --- Footer kecil ---
  if (e.footer?.text && budget.count >= 3) {
    const foot = take(`-# ${e.footer.text}`);
    if (foot) {
      container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(false));
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(foot));
      budget.count -= 2;
    }
  }

  // Container kosong nggak valid -> kasih isi minimal.
  if (container.components.length === 0) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent('​'));
    budget.count -= 1;
  }

  // --- Tombol / dropdown ikut masuk ke dalam kartu ---
  if (rows && rows.length > 0) {
    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(false));
    budget.count -= 1;
    for (const row of rows) container.addActionRowComponents(row);
  }

  return container;
}

function rowCost(row) {
  const json = toJSON(row);
  return 1 + (json?.components?.length || 0);
}

function normalizeRow(row) {
  if (row instanceof ActionRowBuilder) return row;
  return ActionRowBuilder.from(toJSON(row));
}

/**
 * Konversi opsi pesan bergaya embed -> opsi pesan Components V2.
 * Dikembalikan objek BARU (opsi asli nggak diubah).
 */
function convertOptionsToV2(options) {
  const embeds = options.embeds || [];
  const rawRows = (options.components || []).filter(Boolean);
  const budget = { text: MAX_TOTAL_TEXT, count: MAX_COMPONENTS };

  const topLevel = [];

  if (options.content) {
    const content = clip(String(options.content), 1500);
    topLevel.push(new TextDisplayBuilder().setContent(content));
    budget.text -= content.length;
    budget.count -= 1;
  }

  // Hitung jatah komponen yang harus disisakan buat action row.
  const rows = rawRows.map(normalizeRow);
  const rowsCost = rows.reduce((sum, r) => sum + rowCost(r), 0) + (rows.length ? 1 : 0);
  budget.count -= rowsCost;

  embeds.forEach((embed, i) => {
    const isLast = i === embeds.length - 1;
    topLevel.push(embedToContainer(embed, isLast ? rows : null, budget));
  });

  // Nggak ada embed sama sekali tapi ada tombol -> bungkus tombolnya dalam 1 kartu.
  if (embeds.length === 0 && rows.length > 0) {
    const c = new ContainerBuilder().setAccentColor(BRAND_COLOR);
    for (const r of rows) c.addActionRowComponents(r);
    topLevel.push(c);
  }

  const next = { ...options };
  delete next.embeds;
  delete next.content;
  next.components = topLevel;
  next.flags = (Number(next.flags) || 0) | MessageFlags.IsComponentsV2;
  next.__v2 = true;
  return next;
}

function needsConversion(options) {
  if (!options || typeof options !== 'object' || options.__v2) return false;
  return Array.isArray(options.embeds) && options.embeds.length > 0;
}

let installed = false;
function install() {
  if (installed || typeof MessagePayload !== 'function') return false; // di test (discord.js ke-mock) otomatis no-op
  const original = MessagePayload.prototype.resolveBody;
  MessagePayload.prototype.resolveBody = function patchedResolveBody(...args) {
    if (!this.body && needsConversion(this.options)) {
      this.options = convertOptionsToV2(this.options);
    }
    return original.apply(this, args);
  };
  installed = true;
  return true;
}

module.exports = { install, convertOptionsToV2, needsConversion, BRAND_COLOR };
