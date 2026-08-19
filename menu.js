const qrcode = require('qrcode-terminal');
const inquirer = require('inquirer');
const fs = require('fs');
const path = require('path');
const PKG = require('./package.json');

const BASE_OUT = process.env.OUTPUT_DIR || __dirname;
let ChatFactory = null;

const MIME_TO_EXT = {
  'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png',
  'image/gif': '.gif', 'image/webp': '.webp', 'video/mp4': '.mp4',
  'video/3gpp': '.3gp', 'video/quicktime': '.mov',
  'video/x-matroska': '.mkv', 'video/webm': '.webm',
  'audio/ogg': '.ogg', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a',
  'audio/aac': '.aac', 'audio/amr': '.amr',
  'application/pdf': '.pdf',
};
function extFromMime(m) {
  if (!m) return '.bin';
  const b = m.split(';')[0].trim().toLowerCase();
  return MIME_TO_EXT[b] || '.' + b.split('/')[1];
}
function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }

// Message types worth saving as files, and the subfolder each goes in.
const MEDIA_SUBDIR = {
  image: 'images', video: 'videos',
  audio: 'audio', ptt: 'audio',
  document: 'documents', sticker: 'stickers',
};

async function senderLabel(msg, chat) {
  if (msg.fromMe) return 'Me';
  if (!chat.isGroup) return chat.name || 'Contact';
  try {
    const contact = await msg.getContact();
    return contact.pushname || contact.name || contact.number || msg.author || 'Unknown';
  } catch {
    return msg.author || 'Unknown';
  }
}

async function getChatsCompat(client) {
  if (!ChatFactory) ChatFactory = require('whatsapp-web.js/src/factories/ChatFactory');
  const models = await client.pupPage.evaluate(async () => {
    const messages = window.require('WAWebCollections').Msg;
    const originalGetMessagesById = messages.getMessagesById;

    // WhatsApp Web may expose lastReceivedKey without the legacy _serialized
    // field. whatsapp-web.js 1.34.7 otherwise sends [undefined] to IndexedDB.
    messages.getMessagesById = function(ids, ...args) {
      if (!Array.isArray(ids) || ids.some(id => !id)) {
        return Promise.resolve({ messages: [] });
      }
      return originalGetMessagesById.call(this, ids, ...args);
    };

    try {
      return await window.WWebJS.getChats();
    } finally {
      messages.getMessagesById = originalGetMessagesById;
    }
  });

  return models.map(model => ChatFactory.create(client, model));
}

function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function yesterdayLocal() {
  const d = new Date(); d.setDate(d.getDate()-1);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function parseRange(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const e = new Date(dateStr + 'T23:59:59');
  return { start: Math.floor(d.getTime()/1000), end: Math.floor(e.getTime()/1000) };
}
function isValidDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s)); }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// WhatsApp Web only has as much history as it has synced from the phone over
// the multi-device link. A stalled message count doesn't mean history is
// exhausted — the phone may need a few retries (with delay) to push the next
// older batch, especially for chats with years of backlog. Only give up after
// several consecutive stalls.
async function loadHistory(chat, targetStartTs) {
  // Mimics opening the chat in the real app/UI, which is what actually
  // prompts the phone to push older history over the multi-device link —
  // fetchMessages()/loadEarlierMsgs() alone only page through what's
  // already synced locally.
  await chat.sendSeen();
  await sleep(2000);

  process.stdout.write('  Loading history');
  let limit = 100, prevCount = -1, stalls = 0;
  const MAX_STALLS = 6;
  while (true) {
    const msgs = await chat.fetchMessages({ limit });
    process.stdout.write('.');
    if (!msgs || !msgs.length) break;

    if (msgs.length === prevCount) {
      stalls++;
      if (stalls >= MAX_STALLS) break;
      await sleep(1500);
    } else {
      stalls = 0;
    }
    prevCount = msgs.length;

    const oldest = msgs[0];
    if (targetStartTs && oldest.timestamp <= targetStartTs) break;
    limit += 100;
    if (limit > 50000) break;
  }
  console.log(` done (${prevCount < 0 ? 0 : prevCount} messages loaded).`);
}

// Downloads media files and writes a conversation.txt transcript covering
// every message (text and media) in range, so personal chats can be
// exported in full rather than just their attachments.
async function exportChat(chat, startTs, endTs, outDir) {
  const all = await chat.fetchMessages({ limit: 99999 });
  const inRange = all.filter(m => {
    if (startTs && m.timestamp < startTs) return false;
    if (endTs   && m.timestamp > endTs)   return false;
    return true;
  });
  for (const msg of inRange) {
    // WhatsApp Web (July 2026+) renamed the serialized message id from
    // `_serialized` to `$1`; whatsapp-web.js 1.34.7 still reads the old name
    // and passes `undefined` into the page, making downloadMedia() fail with
    // a cryptic `r: r` error. Backfill so the library sees the id it expects.
    if (msg.id && msg.id._serialized == null && msg.id.$1 != null) {
      msg.id._serialized = msg.id.$1;
    }
  }

  if (!inRange.length) { console.log('\n  No messages found for this range.'); return { saved: 0, total: 0 }; }
  console.log(`\n  Found ${inRange.length} message(s). Exporting...\n`);

  const transcriptLines = [];
  let saved = 0;

  for (let i = 0; i < inRange.length; i++) {
    const msg = inRange[i];
    const ts = msg.timestamp ? new Date(msg.timestamp * 1000).toLocaleString() : `msg${i}`;
    const who = await senderLabel(msg, chat);
    const subdir = MEDIA_SUBDIR[msg.type];

    if (msg.hasMedia && subdir) {
      try {
        const m = await msg.downloadMedia();
        if (!m || !m.data) {
          console.log(`  [${i+1}/${inRange.length}] skip (no data)`);
          transcriptLines.push(`[${ts}] ${who}: [${msg.type} attachment - download failed]`);
          continue;
        }
        const dir = path.join(outDir, subdir);
        ensureDir(dir);
        const fileTs = new Date(msg.timestamp * 1000).toISOString().replace(/[:.]/g, '-');
        const ext = m.filename ? path.extname(m.filename) || extFromMime(m.mimetype) : extFromMime(m.mimetype);
        const filename = `${fileTs}_${i}${ext}`;
        const fp = path.join(dir, filename);
        if (fs.existsSync(fp)) {
          console.log(`  [${i+1}/${inRange.length}] skip (exists): ${filename}`);
        } else {
          fs.writeFileSync(fp, Buffer.from(m.data, 'base64'));
          console.log(`  [${i+1}/${inRange.length}] ${filename}`);
        }
        saved++;
        const caption = msg.body ? ` - "${msg.body}"` : '';
        transcriptLines.push(`[${ts}] ${who}: [${subdir}/${filename}]${caption}`);
      } catch (e) {
        console.log(`  [${i+1}/${inRange.length}] error: ${e.message}`);
        transcriptLines.push(`[${ts}] ${who}: [${msg.type} attachment - download failed: ${e.message}]`);
      }
    } else if (msg.hasMedia) {
      transcriptLines.push(`[${ts}] ${who}: [unsupported attachment type: ${msg.type}]`);
    } else {
      transcriptLines.push(`[${ts}] ${who}: ${msg.body}`);
    }
  }

  ensureDir(outDir);
  fs.writeFileSync(path.join(outDir, 'conversation.txt'), transcriptLines.join('\n') + '\n');

  return { saved, total: inRange.length };
}

function printBanner() {
  console.clear();
  const title = `WhatsApp Media Scraper v${PKG.version}`;
  const W = 38;
  console.log('╔' + '═'.repeat(W) + '╗');
  console.log('║' + title.padStart(Math.floor((W + title.length) / 2)).padEnd(W) + '║');
  console.log('╚' + '═'.repeat(W) + '╝\n');
}

// ── Live scrape over WhatsApp Web ───────────────────────────────────────
async function liveScrapeFlow() {
  console.log('\n── Connecting to WhatsApp Web ──\n');
  console.log('  • Loading WhatsApp library...');
  const { Client, LocalAuth } = require('whatsapp-web.js');
  console.log('  • Launching browser (Chromium)...');

  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '.wwebjs_auth') }),
    puppeteer: { headless: true, args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage'] },
  });

  await new Promise((resolve, reject) => {
    let authed = false;
    client.on('qr', qr => {
      console.log('\n  • Scan this QR with WhatsApp → Linked Devices → Link a device:\n');
      qrcode.generate(qr, { small: true });
      console.log('\n  Waiting for scan...');
    });
    // The 'authenticated' event can fire more than once during session
    // restore — only report the first one.
    client.on('authenticated', () => {
      if (authed) return;
      authed = true;
      console.log('  • Authenticated — resolving session...');
    });
    client.on('auth_failure', e => reject(new Error('Auth failed: ' + e)));
    client.on('ready', resolve);
    client.initialize().catch(reject);
  });

  console.log('  • Connected — loading chat list...');
  const chats = await getChatsCompat(client);
  const groups = chats.filter(c => c.isGroup);
  const personalChats = chats.filter(c => !c.isGroup && c.id._serialized !== 'status@broadcast');

  console.log(`  ✓ Ready — ${chats.length} chats found (${groups.length} groups, ${personalChats.length} personal).\n`);

  while (true) {
    // ── Chat type ─────────────────────────────────────────
    const { chatType } = await inquirer.prompt([{
      type: 'list',
      name: 'chatType',
      message: 'Scrape a group or a personal chat?',
      choices: [
        { name: 'Group', value: 'group' },
        { name: 'Personal chat', value: 'personal' },
        new inquirer.Separator(),
        { name: '⛔  Exit', value: 'exit' },
      ],
    }]);

    if (chatType === 'exit') break;
    const list = chatType === 'group' ? groups : personalChats;

    // ── Chat selection ────────────────────────────────────
    const { chatName } = await inquirer.prompt([{
      type: 'list',
      name: 'chatName',
      message: chatType === 'group' ? 'Select a group:' : 'Select a personal chat:',
      choices: [...list.map(c => c.name), new inquirer.Separator(), '⛔  Back'],
      pageSize: 15,
    }]);

    if (chatName === '⛔  Back') continue;
    const group = list.find(c => c.name === chatName);
    const groupName = chatName;

    // ── Timeframe ────────────────────────────────────────
    const { timeframe } = await inquirer.prompt([{
      type: 'list',
      name: 'timeframe',
      message: 'Timeframe:',
      choices: [
        { name: `Today          (${todayLocal()})`, value: 'today' },
        { name: `Yesterday      (${yesterdayLocal()})`, value: 'yesterday' },
        { name: 'Specific date', value: 'date' },
        { name: 'Date range     (from → to)', value: 'range' },
        { name: 'All time', value: 'all' },
      ],
    }]);

    let startTs = null, endTs = null, label = '';

    if (timeframe === 'today') {
      const r = parseRange(todayLocal());
      startTs = r.start; endTs = r.end; label = todayLocal();
    } else if (timeframe === 'yesterday') {
      const r = parseRange(yesterdayLocal());
      startTs = r.start; endTs = r.end; label = yesterdayLocal();
    } else if (timeframe === 'date') {
      const { d } = await inquirer.prompt([{
        type: 'input', name: 'd', message: 'Date (YYYY-MM-DD):',
        default: todayLocal(),
        validate: v => isValidDate(v) || 'Enter a valid date (YYYY-MM-DD)',
      }]);
      const r = parseRange(d);
      startTs = r.start; endTs = r.end; label = d;
    } else if (timeframe === 'range') {
      const { from, to } = await inquirer.prompt([
        { type: 'input', name: 'from', message: 'From date (YYYY-MM-DD):', default: yesterdayLocal(),
          validate: v => isValidDate(v) || 'Invalid date' },
        { type: 'input', name: 'to',   message: 'To date   (YYYY-MM-DD):', default: todayLocal(),
          validate: v => isValidDate(v) || 'Invalid date' },
      ]);
      startTs = Math.floor(new Date(from + 'T00:00:00').getTime()/1000);
      endTs   = Math.floor(new Date(to   + 'T23:59:59').getTime()/1000);
      label = `${from}_to_${to}`;
    } else {
      label = 'all';
    }

    // ── Output folder ────────────────────────────────────
    const defaultFolder = label === 'all'
      ? groupName.replace(/[^a-zA-Z0-9]/g, '_').slice(0,20)
      : label.replace(/-/g,'');

    const { folder } = await inquirer.prompt([{
      type: 'input', name: 'folder',
      message: 'Output folder name:',
      default: defaultFolder,
      validate: v => v.trim().length > 0 || 'Enter a folder name',
    }]);

    const outDir = path.join(BASE_OUT, folder.trim());

    // ── Confirm ──────────────────────────────────────────
    console.log('\n  ┌─────────────────────────────────────┐');
    console.log(`  │ Chat:    ${groupName.padEnd(28)}│`);
    console.log(`  │ Range:   ${(label||'all time').padEnd(28)}│`);
    console.log(`  │ Output:  ${folder.trim().padEnd(28)}│`);
    console.log('  └─────────────────────────────────────┘\n');

    const { ok } = await inquirer.prompt([{
      type: 'confirm', name: 'ok', message: 'Start export?', default: true,
    }]);

    if (ok) {
      ensureDir(outDir);
      await loadHistory(group, startTs);
      const { saved, total } = await exportChat(group, startTs, endTs, outDir);
      console.log(`\n  ✓ Done — ${saved} file(s) + conversation.txt (${total} messages) saved to:\n    ${outDir}\n`);
    }

    // ── Continue? ────────────────────────────────────────
    const { again } = await inquirer.prompt([{
      type: 'confirm', name: 'again', message: 'Scrape another chat/date?', default: true,
    }]);
    if (!again) break;
    printBanner();
  }

  await client.destroy();
}

// ── Entry point ────────────────────────────────────────────────────────
async function main() {
  printBanner();
  await liveScrapeFlow();
  console.log('\nGoodbye!\n');
  process.exit(0);
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
