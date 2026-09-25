// Fitur "Welcome Message" -- pesan sambutan yang dikirim ke text chat
// bawaan voice channel Satpam Voice sendiri ("Voice Channel Chat" khas
// Discord) tiap kali ada member yang BARU join channel itu. Ini beda dari
// "member baru di server" -- triggernya murni "baru masuk voice channel
// ini", siapapun dia, kapanpun.

const { EmbedBuilder } = require('discord.js');

const WELCOME_COLOR = 0x3b82f6; // biru, senada tema panel & fitur lain

// Beberapa variasi kalimat sambutan biar nggak keliatan template/monoton
// tiap kali ada yang join -- dipilih random tiap kali welcome dikirim.
const TAGLINES = [
  'Santai aja, anggap rumah sendiri. Nyalain musik, ngobrol, atau sekadar nongkrong. 🎧',
  'Siap-siap seru-seruan! Ketik apa aja atau klik panel bot buat mulai. ✨',
  'Selamat bergabung di lingkaran Satpam Voice -- tempat nongkrong paling asik. 🔥',
  'Semoga betah ya! Jangan sungkan buat ikutan ngobrol atau minta diputerin lagu. 🎶',
  'Kamu resmi jadi bagian dari Satpam Voice. Have fun! 🚀',
  'Enjoy the vibe -- dari musik sampai obrolan seru, semua ada di sini. 💎',
];

function pickTagline() {
  return TAGLINES[Math.floor(Math.random() * TAGLINES.length)];
}

/**
 * Embed sambutan yang dikirim ke chat voice channel Satpam Voice tiap kali
 * ada member yang baru join channel ini. `member` = GuildMember yang baru
 * join (dipakai buat nama tampilan & foto profil Discord-nya).
 */
function buildWelcomeEmbed(member) {
  const displayName = member.displayName || member.user.username;

  return new EmbedBuilder()
    .setColor(WELCOME_COLOR)
    .setAuthor({ name: '🎙️  Member Baru Masuk Voice!' })
    .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
    .setDescription(
      [
        `Selamat datang, **${displayName}**, di **Satpam Voice Channel**! 👋`,
        '',
        pickTagline(),
      ].join('\n')
    )
    .setFooter({ text: 'KokoKrunch Studios' })
    .setTimestamp();
}

module.exports = { buildWelcomeEmbed };
