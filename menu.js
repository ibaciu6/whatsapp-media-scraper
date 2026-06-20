const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const inquirer = require('inquirer');
const fs = require('fs');
const path = require('path');

const BASE_OUT = process.env.OUTPUT_DIR || __dirname;

const MIME_TO_EXT = {
  'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png',
  'image/gif': '.gif', 'image/webp': '.webp', 'video/mp4': '.mp4',
  'video/3gpp': '.3gp', 'video/quicktime': '.mov',
  'video/x-matroska': '.mkv', 'video/webm': '.webm',
};
function extFromMime(m) {
  if (!m) return '.bin';
  const b = m.split(';')[0].trim().toLowerCase();
  return MIME_TO_EXT[b] || '.' + b.split('/')[1];
}
function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }

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

async function loadHistory(chat, targetStartTs) {
  process.stdout.write('  Loading history');
  let limit = 100, prevId = null;
  while (true) {
    const msgs = await chat.fetchMessages({ limit });
    process.stdout.write('.');
    if (!msgs || !msgs.length) break;
    const oldest = msgs[0];
    if (oldest.id._serialized === prevId) break;
    prevId = oldest.id._serialized;
    if (targetStartTs && oldest.timestamp <= targetStartTs) break;
    limit += 100;
    if (limit > 50000) break;
  }
  console.log(' done.');
}

async function downloadAll(chat, startTs, endTs, outDir) {
  const all = await chat.fetchMessages({ limit: 99999 });
  const media = all.filter(m => {
    if (!m.hasMedia) return false;
    if (m.type !== 'image' && m.type !== 'video') return false;
    if (startTs && m.timestamp < startTs) return false;
    if (endTs   && m.timestamp > endTs)   return false;
    return true;
  });

  if (!media.length) { console.log('\n  No media found for this range.'); return 0; }
  console.log(`\n  Found ${media.length} file(s). Downloading...\n`);

  let saved = 0;
  for (let i = 0; i < media.length; i++) {
    try {
      const m = await media[i].downloadMedia();
      if (!m || !m.data) { console.log(`  [${i+1}/${media.length}] skip (no data)`); continue; }
      const isVideo = media[i].type === 'video';
      const subdir = path.join(outDir, isVideo ? 'videos' : 'images');
      ensureDir(subdir);
      const ext = extFromMime(m.mimetype);
      const ts = media[i].timestamp
        ? new Date(media[i].timestamp*1000).toISOString().replace(/[:.]/g,'-')
        : `msg${i}`;
      const filename = `${ts}_${i}${ext}`;
      const fp = path.join(subdir, filename);
      if (fs.existsSync(fp)) { console.log(`  [${i+1}/${media.length}] skip (exists): ${filename}`); saved++; continue; }
      fs.writeFileSync(fp, Buffer.from(m.data, 'base64'));
      console.log(`  [${i+1}/${media.length}] ${filename}`);
      saved++;
    } catch(e) { console.log(`  [${i+1}/${media.length}] error: ${e.message}`); }
  }
  return saved;
}

async function main() {
  console.clear();
  console.log('╔══════════════════════════════════════╗');
  console.log('║   WhatsApp Media Scraper             ║');
  console.log('╚══════════════════════════════════════╝\n');
  console.log('Connecting to WhatsApp...\n');

  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '.wwebjs_auth') }),
    puppeteer: { headless: true, args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage'] },
  });

  await new Promise((resolve, reject) => {
    client.on('qr', qr => {
      console.log('\nScan this QR with WhatsApp → Linked Devices:\n');
      qrcode.generate(qr, { small: true });
    });
    client.on('authenticated', () => console.log('✓ Authenticated'));
    client.on('auth_failure', e => reject(new Error('Auth failed: ' + e)));
    client.on('ready', resolve);
    client.initialize();
  });

  console.log('✓ Connected\n');

  const chats = await client.getChats();
  const groups = chats.filter(c => c.isGroup);

  while (true) {
    // ── Group selection ──────────────────────────────────
    const { groupName } = await inquirer.prompt([{
      type: 'list',
      name: 'groupName',
      message: 'Select a group:',
      choices: [...groups.map(g => g.name), new inquirer.Separator(), '⛔  Exit'],
      pageSize: 15,
    }]);

    if (groupName === '⛔  Exit') break;
    const group = groups.find(g => g.name === groupName);

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
    console.log(`  │ Group:   ${groupName.padEnd(28)}│`);
    console.log(`  │ Range:   ${(label||'all time').padEnd(28)}│`);
    console.log(`  │ Output:  ${folder.trim().padEnd(28)}│`);
    console.log('  └─────────────────────────────────────┘\n');

    const { ok } = await inquirer.prompt([{
      type: 'confirm', name: 'ok', message: 'Start download?', default: true,
    }]);

    if (ok) {
      ensureDir(outDir);
      await loadHistory(group, startTs);
      const saved = await downloadAll(group, startTs, endTs, outDir);
      console.log(`\n  ✓ Done — ${saved} file(s) saved to:\n    ${outDir}\n`);
    }

    // ── Continue? ────────────────────────────────────────
    const { again } = await inquirer.prompt([{
      type: 'confirm', name: 'again', message: 'Scrape another group/date?', default: true,
    }]);
    if (!again) break;
    console.clear();
  }

  console.log('\nGoodbye!\n');
  await client.destroy();
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
