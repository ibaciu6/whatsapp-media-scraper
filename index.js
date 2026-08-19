const { Client, LocalAuth } = require('whatsapp-web.js');
const ChatFactory = require('whatsapp-web.js/src/factories/ChatFactory');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');

async function getChatsCompat(client) {
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

const MIME_TO_EXT = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'video/mp4': '.mp4',
  'video/3gpp': '.3gp',
  'video/quicktime': '.mov',
  'video/x-matroska': '.mkv',
  'video/webm': '.webm',
  'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/aac': '.aac',
  'audio/amr': '.amr',
  'application/pdf': '.pdf',
};

function extFromMime(mimetype) {
  if (!mimetype) return '.bin';
  const base = mimetype.split(';')[0].trim().toLowerCase();
  return MIME_TO_EXT[base] || '.' + base.split('/')[1];
}

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

// CLI: node index.js                              → list groups + personal chats
//      node index.js "name"                       → export all media + conversation.txt (group or personal chat)
//      node index.js "name" "2026-06-13"          → limited to that date only
//      node index.js "name" "2026-06-13" "Folder" → save to named folder
const groupArg  = process.argv[2] ? process.argv[2].toLowerCase() : null;
const dateArg   = process.argv[3] || null;
const folderArg = process.argv[4] || null;

// Parse date range (local timezone = Bucharest)
let startTs = null, endTs = null;
if (dateArg) {
  const d = new Date(dateArg + 'T00:00:00');
  const e = new Date(dateArg + 'T23:59:59');
  startTs = Math.floor(d.getTime() / 1000);
  endTs   = Math.floor(e.getTime() / 1000);
  console.log(`[INFO] Date filter: ${d.toLocaleString()} → ${e.toLocaleString()}`);
}

// Output directory
const outDir = folderArg
  ? path.join(__dirname, folderArg)
  : path.join(__dirname, 'media');

function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Load all messages back to targetStartTs by calling fetchMessages with
// an ever-increasing limit — each call triggers whatsapp-web.js's own
// loadEarlierMsgs when in-memory count < limit.
//
// WhatsApp Web only has as much history as it has synced from the phone over
// the multi-device link. A stalled message count doesn't mean history is
// exhausted — the phone may need a few retries (with delay) to push the next
// older batch, especially for chats with years of backlog. Only give up
// after several consecutive stalls.
async function loadHistory(chat, targetStartTs) {
  // Mimics opening the chat in the real app/UI, which is what actually
  // prompts the phone to push older history over the multi-device link —
  // fetchMessages()/loadEarlierMsgs() alone only page through what's
  // already synced locally.
  await chat.sendSeen();
  await sleep(2000);

  process.stdout.write('[INFO] Loading message history');
  let limit = 100, prevCount = -1, stalls = 0;
  const MAX_STALLS = 6;

  while (true) {
    const msgs = await chat.fetchMessages({ limit });
    process.stdout.write('.');

    if (!msgs || msgs.length === 0) break;

    if (msgs.length === prevCount) {
      stalls++;
      if (stalls >= MAX_STALLS) break;
      await sleep(1500);
    } else {
      stalls = 0;
    }
    prevCount = msgs.length;

    const oldest = msgs[0];
    // Reached (or passed) our target start date
    if (targetStartTs && oldest.timestamp <= targetStartTs) break;

    limit += 100;
    if (limit > 50000) break; // safety cap
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

  if (!inRange.length) { console.log('[INFO] No messages found for this range.'); return { saved: 0, total: 0 }; }
  console.log(`[INFO] ${inRange.length} message(s) in range.\n`);

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
          console.log(`  [${i + 1}/${inRange.length}] skip (no data)`);
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
          console.log(`  [${i + 1}/${inRange.length}] skip (exists): ${filename}`);
        } else {
          fs.writeFileSync(fp, Buffer.from(m.data, 'base64'));
          console.log(`  [${i + 1}/${inRange.length}] ${filename}`);
        }
        saved++;
        const caption = msg.body ? ` - "${msg.body}"` : '';
        transcriptLines.push(`[${ts}] ${who}: [${subdir}/${filename}]${caption}`);
      } catch (err) {
        console.log(`  [${i + 1}/${inRange.length}] error: ${err.message}`);
        transcriptLines.push(`[${ts}] ${who}: [${msg.type} attachment - download failed: ${err.message}]`);
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

console.log('[INFO] Launching browser (Chromium)... this can take a while');

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '.wwebjs_auth') }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  },
});

let authed = false;
// The 'authenticated' event can fire more than once during session
// restore — only report the first one.
client.on('authenticated', () => {
  if (authed) return;
  authed = true;
  console.log('[OK] Authenticated — resolving session, syncing chats...');
});
client.on('qr', qr => {
  console.log('\n[QR] Scan with WhatsApp → Linked Devices → Link a Device:\n');
  qrcode.generate(qr, { small: true });
  console.log('\nWaiting for scan...');
});

client.on('auth_failure', msg => { console.error('[ERR] Auth failed:', msg); process.exit(1); });

client.on('ready', async () => {
  console.log('[OK] WhatsApp ready.\n');

  const chats = await getChatsCompat(client);
  const groups = chats.filter(c => c.isGroup);
  const personalChats = chats.filter(c => !c.isGroup && c.id._serialized !== 'status@broadcast');

  if (!groupArg) {
    console.log('=== YOUR GROUPS ===');
    groups.forEach((g, i) => console.log(`  ${i + 1}. ${g.name}`));
    console.log('\n=== YOUR PERSONAL CHATS ===');
    personalChats.forEach((c, i) => console.log(`  ${i + 1}. ${c.name}`));
    console.log('\nUsage: node index.js "Name" ["YYYY-MM-DD"] ["OutputFolder"]');
    await client.destroy();
    return;
  }

  const group = [...groups, ...personalChats].find(c => c.name.toLowerCase().includes(groupArg));
  if (!group) {
    console.log(`[ERR] No chat matching "${groupArg}"`);
    await client.destroy();
    return;
  }

  console.log(`[OK] Chat: "${group.name}"`);
  console.log(`[INFO] Output: ${outDir}\n`);
  ensureDir(outDir);

  // Load history back to start date
  await loadHistory(group, startTs);

  const { saved, total } = await exportChat(group, startTs, endTs, outDir);

  console.log(`\n[DONE] ${saved} file(s) + conversation.txt (${total} messages) saved to ${outDir}`);
  await client.destroy();
  process.exit(0);
});

client.initialize();
