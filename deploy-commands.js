const { REST, Routes } = require('discord.js');
const config = require('./config');
const commands = require('./commands');

const body = commands.map((cmd) => cmd.data.toJSON());

const rest = new REST({ version: '10' }).setToken(config.token);

(async () => {
  try {
    if (config.guildId) {
      // Guild command: langsung muncul, cocok buat development/1 server aja.
      await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), { body });
      console.log(`[DEPLOY] ${body.length} command berhasil di-deploy ke guild ${config.guildId}.`);
    } else {
      // Global command: bisa dipake di semua server bot ini invited, tapi
      // propagasi ke Discord bisa makan waktu sampai ~1 jam.
      await rest.put(Routes.applicationCommands(config.clientId), { body });
      console.log(`[DEPLOY] ${body.length} command berhasil di-deploy secara global (bisa lambat propagasi ~1 jam).`);
      console.log('[DEPLOY] Tip: isi GUILD_ID di .env supaya command langsung muncul instan pas development.');
    }
  } catch (err) {
    console.error('[DEPLOY] Gagal deploy command:', err);
    process.exit(1);
  }
})();
