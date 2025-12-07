const fs = require('fs');
const path = require('path');
const express = require('express');
const qrcode = require('qrcode-terminal');
const fetch = require('node-fetch');
const { default: makeWASocket, useMultiFileAuthState } = require('@adiwajshing/baileys');
const { DisconnectReason } = require('@adiwajshing/baileys');
const { loadCommands } = require('./lib/loader');
const { consume } = require('./lib/antispam');
const CONFIG = require('./config');
if (!fs.existsSync(CONFIG.DATA_DIR)) fs.mkdirSync(CONFIG.DATA_DIR, { recursive: true });
let latestQR = null;
let commands = loadCommands();
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(path.join(CONFIG.DATA_DIR, 'auth_info'));
  const sock = makeWASocket({ auth: state, printQRInTerminal: true });
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) { latestQR = qr; try { qrcode.generate(qr, { small: true }); } catch (e) {} console.log('New QR generated.'); }
    if (connection === 'close') {
      console.log('connection closed', lastDisconnect?.error);
      if (lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut) {
        console.log('Logged out — remove auth files to re-authenticate.');
      }
    }
    if (connection === 'open') { console.log(CONFIG.BOT_NAME + ' connected.'); latestQR = null; }
  });
  sock.ev.on('messages.upsert', async (m) => {
    try {
      const msg = m.messages[0];
      if (!msg || !msg.message) return;
      if (msg.key && msg.key.remoteJid === 'status@broadcast') return;
      const from = msg.key.remoteJid;
      const fromUser = msg.key.participant || from;
      const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
      if (!text) return;
      if (!consume(fromUser, CONFIG.RATE_LIMIT_PER_MINUTE)) {
        await sock.sendMessage(from, { text: 'Trop de requêtes — ralentis un peu 🤡' });
        return;
      }
      if (!text.startsWith(CONFIG.PREFIX)) return;
      const without = text.slice(CONFIG.PREFIX.length).trim();
      const parts = without.split(/\s+/);
      const cmdName = parts[0].toLowerCase();
      const args = parts.slice(1);
      if (cmdName === 'reload' && CONFIG.OWNER_NUMBER && fromUser.includes(CONFIG.OWNER_NUMBER)) {
        commands = loadCommands();
        return await sock.sendMessage(from, { text: 'Commands reloaded ✅' });
      }
      const command = commands.get(cmdName);
      if (!command) {
        return await sock.sendMessage(from, { text: `🤡 Commande inconnue : ${cmdName} — tape ${CONFIG.PREFIX}help` });
      }
      try {
        await command.exec({ sock, from, fromUser, args, CONFIG, commands });
      } catch (e) {
        console.error('Command exec error', e);
        await sock.sendMessage(from, { text: 'Erreur pendant l\'exécution. 😅' });
      }
    } catch (err) {
      console.error('message handler error', err);
    }
  });
  return sock;
}
const app = express();
app.use(express.json());
app.use(express.static('web'));
app.get('/api/qr', (req, res) => {
  if (!latestQR) return res.json({ ok: false, message: 'No QR available (bot may be connected).' });
  return res.json({ ok: true, qr: latestQR });
});
app.get('/api/commands_count', (req, res) => res.json({ count: commands.size }));
(async () => {
  try {
    const sock = await startBot();
    global.SOCK = sock;
    const port = CONFIG.PORT;
    app.listen(port, () => console.log('Web UI listening on port', port));
  } catch (e) {
    console.error('Failed to start', e);
  }
})();