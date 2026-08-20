const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execSync } = require('child_process');
const PKG = require('./package.json');

// ── ESC = back/exit for every prompt ─────────────────────────────────────
// inquirer v8 has no "back" key handling. Patch the Base prompt so a `q`
// keypress resolves the active prompt with a sentinel value; each menu then
// maps that sentinel to "back"/"exit" instead of making the user scroll to
// the exit option.
// `q` is used instead of Esc because Esc needs a 500ms escape-code timeout
// and is not reliably delivered as a keypress here; `q` fires immediately.
// Lazy-loaded inside the flow — requiring inquirer up front costs ~11s
// (rxjs) and would delay the banner.
let BACK_RESULT = null;
let activePrompt = null;

function patchInquirerEsc() {
  const inquirer = require('inquirer');
  BACK_RESULT = '\u0000__BACK__';
  readline.emitKeypressEvents(process.stdin);

  // Persistent listener, attached once: keeps the stream's keypress decoder
  // armed between prompts (readline's emitKeypressEvents self-detaches its
  // data handler when no 'keypress' listeners remain) and resolves whichever
  // prompt is currently active. `q` instead of Esc — Esc needs a 500ms
  // escape-code timeout and is not reliably delivered as a keypress here.
  // Only list prompts get the keypress interception — they can't accept
  // typed text, so a bare `q` press is the only way to go back without
  // scrolling to the Back entry. Input prompts (date, folder, ...) and
  // confirms take plain text instead: the user types `q` and hits Enter,
  // and the flow treats the submitted value 'q' as "back"/"no". No ESC.
  const onQ = (str, key) => {
    if (!key || key.name !== 'q') return;
    const p = activePrompt;
    if (!p) return;
    if (p.constructor.name !== 'ListPrompt') return;
    // The decoder (attached before any prompt) emits the keypress before the
    // prompt's own readline processes the byte, which would insert 'q' into
    // its line buffer and redraw it right after we resolve — leaking a stray
    // 'q' into the next rendered prompt. Drop the rl's listeners so it never
    // sees the byte.
    p.rl.removeAllListeners();
    const fn = p.onSubmit ? p.onSubmit.bind(p)
      : p.onEnd ? p.onEnd.bind(p) : null;
    if (!fn) return;
    fn(BACK_RESULT);
  };
  process.stdin.setMaxListeners(0);
  process.stdin.on('keypress', onQ);

  const Base = require('inquirer/lib/prompts/base');
  const origRun = Base.prototype.run;
  Base.prototype.run = function () {
    activePrompt = this;
    const result = origRun.call(this);
    const origClose = this.close.bind(this);
    this.close = () => {
      if (activePrompt === this) activePrompt = null;
      return origClose();
    };
    return result;
  };

  // inquirer pauses+closes its readline after every prompt(); the pause
  // happens AFTER our prompt-level close hook runs, so re-arm the tty at the
  // very end of the UI close instead — otherwise the next prompt's keypresses
  // can be dropped in the gap between close and the next createInterface.
  // Ctrl+C fires this close more than once (puppeteer's SIGINT handler plus
  // inquirer's signal-exit hook), and the second call would make readline
  // throw ERR_USE_AFTER_CLOSE — guard + swallow so exits are always clean.
  const UI = require('inquirer/lib/ui/baseUI');
  const origUIClose = UI.prototype.close;
  UI.prototype.close = function () {
    if (this.__uiClosed) return;
    this.__uiClosed = true;
    try { origUIClose.call(this); } catch {}
    try { process.stdin.setRawMode(true); } catch {}
    process.stdin.resume();
  };
  return inquirer;
}

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
  return Math.max(0, prevCount);
}

// Downloads media files and writes a conversation.txt transcript covering
// every message (text and media) in range, so personal chats can be
// exported in full rather than just their attachments.
async function exportChat(chat, startTs, endTs, outDir, loadedCount = 0) {
  // Never fetch less than loadHistory() already accumulated, otherwise
  // "all time" exports of large chats silently truncate the oldest
  // messages.
  const all = await chat.fetchMessages({ limit: Math.max(99999, loadedCount) });
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
  console.log('═'.repeat(W));
  console.log('   ' + title);
  console.log('═'.repeat(W) + '\n');
}

// ── Live scrape over WhatsApp Web ───────────────────────────────────────
// If a previous run was killed mid-execution (Ctrl+C, crash, OOM), the
// chromium it launched keeps the session dir locked and the next launch
// fails with "The browser is already running". Clean those stragglers up
// before starting so the app always boots into a fresh browser.
function killStaleBrowsers() {
  try {
    const out = execSync('ps -eo pid=,args=').toString();
    for (const line of out.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(.+)$/);
      if (!m) continue;
      if (/\.wwebjs_auth/.test(m[2]) && /chrome|headless_shell/i.test(m[2])) {
        try { process.kill(parseInt(m[1], 10), 'SIGKILL'); } catch {}
      }
    }
  } catch {}
  const sessionDir = path.join(__dirname, '.wwebjs_auth', 'session');
  try { fs.rmSync(path.join(sessionDir, 'SingletonLock'), { force: true }); } catch {}
  try { fs.rmSync(path.join(sessionDir, 'DevToolsActivePort'), { force: true }); } catch {}
}

async function liveScrapeFlow() {
  killStaleBrowsers();
  console.log('\n── Connecting to WhatsApp Web ──\n');
  console.log('  • Loading prompts library...');
  const inquirer = patchInquirerEsc();
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
    client.initialize().catch(e => reject(new Error(
      'WhatsApp session could not be restored (stale or corrupt session data). ' +
      'Fix: delete the .wwebjs_auth/session folder and scan the QR to re-link.\n' + e
    )));
  });

  console.log('  • Connected — loading chat list...');
  const chats = await getChatsCompat(client);
  const groups = chats.filter(c => c.isGroup);
  const personalChats = chats.filter(c => !c.isGroup && c.id._serialized !== 'status@broadcast');

  console.log(`  ✓ Ready — ${chats.length} chats found (${groups.length} groups, ${personalChats.length} personal).\n`);

  while (true) {
    // ── Chat type ─────────────────────────────────────────
    // This is the app's "main menu" — q deliberately does nothing here
    // so the app can't be closed accidentally; use ⛔ Exit.
    // Clear + redraw every time the menu is shown, so no stray keystroke
    // residue from a previous prompt can linger on screen.
    printBanner();
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

    if (chatType === BACK_RESULT) { console.clear(); continue; }
    if (chatType === 'exit') break;
    const list = chatType === 'group' ? groups : personalChats;

    // ── Chat selection ────────────────────────────────────
    while (true) {
      const { chatName } = await inquirer.prompt([{
        type: 'list',
        name: 'chatName',
        message: chatType === 'group' ? 'Select a group (q = back):' : 'Select a personal chat (q = back):',
        // Some contacts have no name set — fall back to their id so the
        // list never contains undefined entries.
        choices: [...list.map(c => c.name || c.id._serialized), new inquirer.Separator(), '⛔  Back'],
        pageSize: 15,
      }]);

      if (chatName === BACK_RESULT || chatName === '⛔  Back') break;
      const group = list.find(c => (c.name || c.id._serialized) === chatName);
      const groupName = chatName;

      // ── Timeframe ────────────────────────────────────────
      while (true) {
        const { timeframe } = await inquirer.prompt([{
          type: 'list',
          name: 'timeframe',
          message: 'Timeframe (q = back):',
          choices: [
            { name: `Today          (${todayLocal()})`, value: 'today' },
            { name: `Yesterday      (${yesterdayLocal()})`, value: 'yesterday' },
            { name: 'Specific date', value: 'date' },
            { name: 'Date range     (from → to)', value: 'range' },
            { name: 'All time', value: 'all' },
          ],
        }]);

        if (timeframe === BACK_RESULT) { console.clear(); break; }

        let startTs = null, endTs = null, label = '';

        if (timeframe === 'today') {
          const r = parseRange(todayLocal());
          startTs = r.start; endTs = r.end; label = todayLocal();
        } else if (timeframe === 'yesterday') {
          const r = parseRange(yesterdayLocal());
          startTs = r.start; endTs = r.end; label = yesterdayLocal();
        } else if (timeframe === 'date') {
          const { d } = await inquirer.prompt([{
            type: 'input', name: 'd', message: 'Date (YYYY-MM-DD, q = back):',
            default: todayLocal(),
            // 'q' passes the check so typing q + Enter is caught below.
            validate: v => v === 'q' || isValidDate(v) || 'Enter a valid date (YYYY-MM-DD)',
          }]);
          if (d === 'q') { console.clear(); break; }
          const r = parseRange(d);
          startTs = r.start; endTs = r.end; label = d;
        } else if (timeframe === 'range') {
          const { from, to } = await inquirer.prompt([
            { type: 'input', name: 'from', message: 'From date (YYYY-MM-DD, q = back):', default: yesterdayLocal(),
              validate: v => v === 'q' || isValidDate(v) || 'Invalid date' },
            { type: 'input', name: 'to',   message: 'To date   (YYYY-MM-DD, q = back):', default: todayLocal(),
              validate: v => v === 'q' || isValidDate(v) || 'Invalid date' },
          ]);
          if (from === 'q' || to === 'q') { console.clear(); break; }
          startTs = Math.floor(new Date(from + 'T00:00:00').getTime()/1000);
          endTs   = Math.floor(new Date(to   + 'T23:59:59').getTime()/1000);
          label = `${from}_to_${to}`;
        } else {
          label = 'all';
        }

        // ── Output folder ──────────────────────────────────
        const defaultFolder = label === 'all'
          ? groupName.replace(/[^a-zA-Z0-9]/g, '_').slice(0,20)
          : label.replace(/-/g,'');

        const { folder } = await inquirer.prompt([{
          type: 'input', name: 'folder',
          message: 'Output folder name (q = back):',
          default: defaultFolder,
          // Keep the name inside the output root — no path separators or
          // traversal. 'q' passes so typing q + Enter is caught below.
          validate: v => v === 'q' || (/^[\w .\-+()]+$/.test(v.trim()) && v.trim().length > 0 || 'Folder name: letters, numbers, space, . - _ + ( ) only'),
        }]);
        if (folder === 'q') { console.clear(); break; }

        const outDir = path.join(BASE_OUT, folder.trim());

        // ── Confirm ────────────────────────────────────────
        console.log('\n  ┌─────────────────────────────────────┐');
        console.log(`    Chat:    ${groupName}`);
        console.log(`    Range:   ${label||'all time'}`);
        console.log(`    Output:  ${folder.trim()}`);
        console.log('  └─────────────────────────────────────┘\n');

        const { ok } = await inquirer.prompt([{
          type: 'confirm', name: 'ok', message: 'Start export? (q = no)', default: true,
        }]);

        if (ok === true) {
          ensureDir(outDir);
          const loaded = await loadHistory(group, startTs);
          const { saved, total } = await exportChat(group, startTs, endTs, outDir, loaded);
          console.log(`\n  ✓ Done — ${saved} file(s) + conversation.txt (${total} messages) saved to:\n    ${outDir}\n`);
        }

        // ── Pause ──────────────────────────────────────────
        // Lets the user read the result before the screen clears.
        // Either answer returns to the same-type chat list (group stays
        // group, personal stays personal) so consecutive purges are quick.
        // q at the chat list goes back to the main menu, which is the only
        // place the app exits (⛔ Exit).
        await inquirer.prompt([{
          type: 'input', name: '_', message: 'Press Enter to continue',
        }]);

        // ── Back to this chat list ─────────────────────────
        printBanner();
        break; // out of the timeframe loop → chat list re-renders
      }
    }
  }

  await client.destroy();
}

// ── Entry point ────────────────────────────────────────────────────────
// Catch everything: an unexpected error should never dump a raw stack and
// leave the terminal in a broken state — print a short message, restore the
// tty, and exit.
process.on('uncaughtException', e => {
  console.error('\n⚠ Unexpected error: ' + (e && e.message ? e.message : e) + '\n');
  process.exit(1);
});
process.on('unhandledRejection', e => {
  console.error('\n⚠ Unhandled error: ' + (e && e.message ? e.message : e) + '\n');
  process.exit(1);
});

async function main() {
  printBanner();
  await liveScrapeFlow();
  console.log('\nGoodbye!\n');
  process.exit(0);
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
