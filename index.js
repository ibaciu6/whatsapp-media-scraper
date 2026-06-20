const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');

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
};

function extFromMime(mimetype) {
  if (!mimetype) return '.bin';
  const base = mimetype.split(';')[0].trim().toLowerCase();
  return MIME_TO_EXT[base] || '.' + base.split('/')[1];
}

// CLI: node index.js                              → list groups
//      node index.js "name"                       → download all media from group
//      node index.js "name" "2026-06-13"          → media on that date only
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

// Load all messages back to targetStartTs by calling fetchMessages with
// an ever-increasing limit — each call triggers whatsapp-web.js's own
// loadEarlierMsgs when in-memory count < limit.
async function loadHistory(chat, targetStartTs) {
  process.stdout.write('[INFO] Loading message history');
  let limit = 100;
  let prevOldestId = null;

  while (true) {
    const msgs = await chat.fetchMessages({ limit });
    process.stdout.write('.');

    if (!msgs || msgs.length === 0) break;

    const oldest = msgs[0];
    const oldestId = oldest.id._serialized;

    // No new messages loaded — we've hit the beginning of history
    if (oldestId === prevOldestId) break;
    prevOldestId = oldestId;

    // Reached (or passed) our target start date
    if (targetStartTs && oldest.timestamp <= targetStartTs) break;

    limit += 100;
    if (limit > 50000) break; // safety cap
  }
  console.log(' done.');
}

async function downloadMedia(msg, index, total, dir) {
  try {
    const media = await msg.downloadMedia();
    if (!media || !media.data) return false;

    const isVideo = msg.type === 'video';
    const subdir = isVideo ? path.join(dir, 'videos') : path.join(dir, 'images');
    ensureDir(subdir);

    const ext = extFromMime(media.mimetype);
    const ts = msg.timestamp
      ? new Date(msg.timestamp * 1000).toISOString().replace(/[:.]/g, '-')
      : `msg${index}`;
    const filename = `${ts}_${index}${ext}`;
    const filepath = path.join(subdir, filename);

    if (fs.existsSync(filepath)) {
      console.log(`  [${index + 1}/${total}] skip (exists): ${filename}`);
      return true;
    }
    fs.writeFileSync(filepath, Buffer.from(media.data, 'base64'));
    console.log(`  [${index + 1}/${total}] ${filename}`);
    return true;
  } catch (err) {
    console.log(`  [skip] msg ${index}: ${err.message}`);
    return false;
  }
}

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '.wwebjs_auth') }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  },
});

client.on('qr', qr => {
  console.log('\n[QR] Scan with WhatsApp → Linked Devices → Link a Device:\n');
  qrcode.generate(qr, { small: true });
  console.log('\nWaiting for scan...');
});

client.on('authenticated', () => console.log('[OK] Authenticated.'));
client.on('auth_failure', msg => { console.error('[ERR] Auth failed:', msg); process.exit(1); });

client.on('ready', async () => {
  console.log('[OK] WhatsApp ready.\n');

  const chats = await client.getChats();
  const groups = chats.filter(c => c.isGroup);

  if (!groupArg) {
    console.log('=== YOUR GROUPS ===');
    groups.forEach((g, i) => console.log(`  ${i + 1}. ${g.name}`));
    console.log('\nUsage: node index.js "Group Name" ["YYYY-MM-DD"] ["OutputFolder"]');
    await client.destroy();
    return;
  }

  const group = groups.find(g => g.name.toLowerCase().includes(groupArg));
  if (!group) {
    console.log(`[ERR] No group matching "${groupArg}"`);
    await client.destroy();
    return;
  }

  console.log(`[OK] Group: "${group.name}"`);
  console.log(`[INFO] Output: ${outDir}\n`);
  ensureDir(outDir);

  // Load history back to start date
  await loadHistory(group, startTs);

  // Fetch all loaded messages
  const messages = await group.fetchMessages({ limit: 99999 });
  console.log(`[INFO] ${messages.length} messages in memory.`);

  // Filter by media type and date range
  const mediaMessages = messages.filter(m => {
    if (!m.hasMedia) return false;
    if (m.type !== 'image' && m.type !== 'video') return false;
    if (startTs && m.timestamp < startTs) return false;
    if (endTs   && m.timestamp > endTs)   return false;
    return true;
  });

  console.log(`[INFO] ${mediaMessages.length} image/video messages in range.\n`);

  if (mediaMessages.length === 0) {
    console.log('[INFO] Nothing to download.');
    await client.destroy();
    return;
  }

  let saved = 0;
  for (let i = 0; i < mediaMessages.length; i++) {
    const ok = await downloadMedia(mediaMessages[i], i, mediaMessages.length, outDir);
    if (ok) saved++;
  }

  console.log(`\n[DONE] ${saved}/${mediaMessages.length} files saved to ${outDir}`);
  await client.destroy();
  process.exit(0);
});

client.initialize();
