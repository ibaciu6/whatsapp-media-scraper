// Shared WhatsApp Web scraping pipeline used by index.js and menu.js.
// Single source of truth so behavior can't drift between the CLI and the
// interactive menu (it did before — sessionId formats differed).
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const qrcode = require('qrcode-terminal');
const core = require('./core');

let ChatFactory = null;

const CONNECT_TIMEOUT_MS = 5 * 60 * 1000; // 5 min to scan QR / restore session

// Kill Chromium stragglers from a previous crashed run of THIS project only
// (match the absolute .wwebjs_auth path, not any whatsapp-web.js project).
function killStaleBrowsers() {
  try {
    const marker = core.AUTH_ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rx = new RegExp(marker);
    const out = execSync('ps -eo pid=,args=').toString();
    for (const line of out.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(.+)$/);
      if (!m) continue;
      // Only kill when the process BINARY is Chromium — matching the auth
      // path anywhere in args would also hit e.g. `tail -f …/chrome.log`.
      const bin = m[2].trim().split(/\s+/)[0];
      if (rx.test(m[2]) && /(^|\/)(chrome|chromium|headless_shell)(?=[-\s]|$)/i.test(bin)) {
        try { process.kill(parseInt(m[1], 10), 'SIGKILL'); } catch {}
      }
    }
  } catch {}
  const candidates = [path.join(core.AUTH_ROOT, 'session')];
  try {
    for (const acc of core.listAccounts()) {
      candidates.push(path.join(core.getAccountPath(acc), 'session'));
    }
  } catch {}
  for (const dir of candidates) {
    for (const f of ['SingletonLock', 'DevToolsActivePort']) {
      try { fs.rmSync(path.join(dir, f), { force: true }); } catch {}
    }
  }
}

// Connect a Client for the given account (or default session when null).
// Rejects after CONNECT_TIMEOUT_MS so an unscanned QR can't hang forever,
// and tightens permissions on the account's session material once live.
// hooks.onClient(client) fires as soon as the Client exists — lets callers
// abort cleanly even while initialize() is still pending.
async function connectClient(accountName, hooks = {}) {
  const { Client, LocalAuth } = require('whatsapp-web.js');
  const dataPath = accountName ? core.getAccountPath(accountName) : core.AUTH_ROOT;
  // Pre-create with owner-only perms so session material is never briefly
  // world-readable under a permissive umask before post-connect hardening.
  try { fs.mkdirSync(dataPath, { recursive: true }); fs.chmodSync(dataPath, 0o700); } catch {}
  const client = new Client({
    authStrategy: new LocalAuth({ dataPath }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      // Default is 180 s; huge chat stores can legitimately take longer on
      // the first post-ready evaluate (see getChatsCompat retries).
      protocolTimeout: 300000,
    },
  });
  try { hooks.onClient && hooks.onClient(client); } catch {}

  await new Promise((resolve, reject) => {
    let settled = false, authed = false;
    // Own SIGINT while connecting so Ctrl+C reliably kills Chromium + exits,
    // even if some dependency swallowed the default handler. Removed again
    // once connected (or failed) to restore normal behavior afterwards.
    const onSigint = () => {
      console.log('\n\nAborted by user (Ctrl+C) — closing browser…');
      try { client.destroy().catch(() => {}); } catch {}
      setTimeout(() => process.exit(130), 500).unref();
    };
    process.on('SIGINT', onSigint);
    const done = (fn, val) => {
      if (settled) return;
      settled = true;
      clearInterval(tick);
      process.removeListener('SIGINT', onSigint);
      clearTimeout(timer);
      fn(val);
    };
    const timer = setTimeout(() =>
      done(reject, new Error(
        'Timed out waiting for WhatsApp Web (5 minutes).\n' +
        'The QR may not have been scanned, or session restore is stuck.\n' +
        'Restart and scan promptly, or disconnect/re-link the account.')),
      CONNECT_TIMEOUT_MS);

    // Restore can legitimately take minutes on large profiles (and was
    // far worse when sessions lived on a Windows drive under WSL). Keep
    // the user informed instead of staring at a silent prompt.
    console.log('  • Restoring WhatsApp session…');
    const tConnect = Date.now();
    const tick = setInterval(() => {
      const s = Math.round((Date.now() - tConnect) / 1000);
      if (s % 15 === 0)
        console.log(`    … still connecting (${s}s elapsed — big sessions can take a few minutes)`);
    }, 5000);

    let qrShown = 0;
    client.on('qr', qr => {
      qrShown++;
      if (qrShown > 1) console.log('\n(QR refreshed — old one expired)');
      console.log('\nScan with WhatsApp → Linked Devices → Link a device:\n');
      qrcode.generate(qr, { small: true });
      console.log('\nWaiting for scan… (Ctrl+C aborts)');
    });
    client.on('authenticated', () => {
      if (authed) return;
      authed = true;
      clearInterval(tick);
      console.log('Authenticated — resolving session…');
    });
    client.on('auth_failure', e => done(reject, new Error('Auth failed: ' + (e && e.message ? e.message : e))));
    client.on('ready', () => done(resolve, client));
    client.initialize().catch(e => done(reject, new Error(
      'WhatsApp session could not be restored (stale or corrupt session data).\n' +
      'Fix: disconnect the account (menu or --disconnect), then re-add and scan the QR.\n' + e)));
  });

  // The QR is sensitive — wipe it from the visible screen once linked
  // (scrollback clearing is terminal-dependent; this covers the common case).
  process.stdout.write('\u001b[2J\u001b[H');

  if (accountName) {
    core.hardenSessionPerms(core.getAccountPath(accountName));
    try { core.updateAccountMeta(accountName, { lastUsed: Date.now() }); } catch {}
  }
  return client;
}

// Persist the freshly loaded chat list so the CLI can fail fast on unknown
// names without ever launching Chromium.
function cacheChats(accountName, chats) {
  if (!accountName) return;
  try { core.saveChatCache(accountName, chats); } catch {}
}

// Display name for chat lists and transcripts. Falls back to the bare phone
// number for unsaved personal contacts (id "1234567890@c.us").
function getDisplayName(chat) {
  if (chat.name) return chat.name;
  const id = (chat.id && (chat.id._serialized || chat.id.$1)) || '';
  if (id === 'status@broadcast') return 'Status / Broadcast';
  if (chat.isGroup) return 'Unnamed Group';
  const m = id.match(/^(\d+)@(c\.us|lid)$/);
  return m ? m[1] : 'Contact';
}

async function senderLabel(msg, chat) {
  if (msg.fromMe) return 'Me';
  if (!chat.isGroup) return getDisplayName(chat);
  try {
    const contact = await msg.getContact();
    return contact.pushname || contact.name || contact.number || msg.author || 'Unknown';
  } catch {
    return msg.author || 'Unknown';
  }
}

// Transcript lines must stay one-per-message; embed real newlines literally
// escaped so the "[ts] sender: body" format stays machine-parseable.
function oneline(s) {
  return String(s == null ? '' : s).replace(/\r?\n/g, '\\n');
}

// Load the chat list. Right after `ready` the WhatsApp Web store may still
// be hydrating (or Chromium briefly stall), which used to surface as a fatal
// "Runtime.callFunctionOn timed out". Retry transient failures with backoff.
async function getChatsCompat(client) {
  if (!ChatFactory) ChatFactory = require('whatsapp-web.js/src/factories/ChatFactory');

  const models = await core.retry(async () => {
    return await client.pupPage.evaluate(async () => {
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
  }, {
    attempts: 3,
    delayMs: 5000,
    isRetryable: e => /timed out|Target closed|Session closed|Protocol error|detached/i.test(e && e.message || String(e)),
    onRetry: (e, attempt, wait) =>
      console.log(`  • Chat list load stalled (attempt ${attempt} failed: ${String(e.message).split('\n')[0]}) — retrying in ${Math.round(wait / 1000)}s…`),
  });

  return models.map(model => ChatFactory.create(client, model));
}

// Load history back to targetStartTs. Progress now prints the live count and
// retries use exponential backoff (1s → 2s → 4s…) instead of a fixed wait,
// giving slow multi-device sync more room without dragging out fast cases.
async function loadHistory(chat, targetStartTs, log = console.log) {
  // Mimics opening the chat in the real app/UI, which is what actually
  // prompts the phone to push older history over the multi-device link.
  await chat.sendSeen();
  await core.sleep(2000);

  let limit = 100, prevCount = -1, prevMsgs = [], stalls = 0, backoff = 1000;
  const MAX_STALLS = 8;
  const t0 = Date.now();
  process.stdout.write('  Loading history…');
  while (true) {
    const msgs = await chat.fetchMessages({ limit });
    // Live count + elapsed + throughput (a true ETA is impossible here —
    // total history size is unknown until the phone stops pushing batches).
    const el = Math.floor((Date.now() - t0) / 1000);
    const rate = el > 1 ? Math.round((msgs ? msgs.length : 0) / el) : 0;
    process.stdout.write(`\r  Loading history… ${msgs ? msgs.length : 0} msgs` +
      (el > 2 ? ` · ${el}s · ~${rate}/s` : '') + '   ');
    if (!msgs || !msgs.length) break;

    if (msgs.length === prevCount) {
      stalls++;
      if (stalls >= MAX_STALLS) break;
      await core.sleep(backoff);
      backoff = Math.min(backoff * 2, 8000);
    } else {
      stalls = 0;
      backoff = 1000;
    }
    prevCount = msgs.length;
    prevMsgs = msgs;

    const oldest = msgs[0];
    if (targetStartTs && oldest.timestamp <= targetStartTs) break;
    limit += 100;
    if (limit > 50000) break;
  }
  process.stdout.write('\r' + ' '.repeat(40) + '\r');
  const count = prevCount < 0 ? 0 : prevCount;
  console.log(`  ✓ Loaded ${count} messages.`);
  return prevMsgs;
}

// Local-time file stamp (matches transcript timestamps — previously media
// files were stamped UTC while conversation.txt showed local time).
function localFileStamp(date) {
  const p = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}` +
         `-${p(date.getHours())}-${p(date.getMinutes())}-${p(date.getSeconds())}`;
}

// Export a chat: downloads media + writes conversation.txt incrementally
// so a crash mid-export still leaves a usable transcript. Re-running into
// the same session folder RESUMES via a `.export-meta.json` sidecar that is
// flushed during the run: it records the id of the last processed message,
// so resume stays correct even if the fetched history window shifted between
// runs (media files are covered by skip-existing).
//
// opts: { startTs, endTs, outDir, loadedCount, textOnly, mediaTypes }
async function exportChat(chat, opts) {
  const { startTs = null, endTs = null, outDir, loadedMessages = null, loadedCount = 0 } = opts;
  const textOnly = !!opts.textOnly;
  const wantAll = !opts.mediaTypes;
  const mediaTypes = new Set(opts.mediaTypes || []);

  // Refuse to write through planted symlinks (e.g. a pre-made conversation.txt
  // or images/ pointing somewhere else on disk).
  if (core.isSymlink(path.join(outDir, 'conversation.txt')) ||
      core.isSymlink(metaPathOf(outDir))) {
    console.error(`\n  [ERR] "${outDir}" contains a symlink where regular export files belong — refusing to write.`);
    return { saved: 0, skippedExisting: 0, total: 0, resumed: false, error: 'symlink' };
  }

  // ── Resume bookkeeping ────────────────────────────────────────────────
  const chatKey = (chat.id && (chat.id._serialized || chat.id.$1)) || '';
  const metaPath = metaPathOf(outDir);
  let resumeFrom = 0, append = false, meta = null;
  try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch {}
  const paramsMatch = meta && meta.chat === chatKey &&
    (meta.startTs || null) === (startTs || null) &&
    (meta.endTs || null) === (endTs || null);
  if (paramsMatch && meta.completed) {
    console.log('\n  This range was already fully exported into this folder — nothing to do.');
    return { saved: 0, skippedExisting: 0, total: 0, resumed: 'complete' };
  }
  if (paramsMatch && !meta.completed) append = true;   // provisional; index fixed below

  core.ensureDir(outDir);

  // Re-use messages already fetched by loadHistory() when available;
  // only fall back to a fresh fetch when no pre-loaded data was provided
  // (e.g. standalone callers or resume paths that need extra headroom).
  let all;
  if (loadedMessages && loadedMessages.length > 0) {
    all = loadedMessages;
  } else {
    process.stdout.write('  Fetching messages…');
    all = await chat.fetchMessages({ limit: Math.max(99999, loadedCount) });
    process.stdout.write('\r' + ' '.repeat(40) + '\r');
  }
  const inRangeFull = all.filter(m => {
    if (startTs && m.timestamp < startTs) return false;
    if (endTs && m.timestamp > endTs) return false;
    return true;
  });

  const msgKey = m => (m.id && (m.id._serialized || m.id.$1)) || '';
  let inRange;
  if (append) {
    // Anchor on the last processed message's ID rather than a bare index:
    // loading deeper history between runs PREPENDS older messages and would
    // silently shift index-based offsets (duplicating/skipping segments).
    let anchor = -1;
    if (meta.lastId) anchor = inRangeFull.findIndex(m => msgKey(m) === meta.lastId);
    if (anchor >= 0) {
      resumeFrom = anchor + 1;
    } else if (meta.lastIndex != null) {
      resumeFrom = Math.min(Math.max(0, meta.lastIndex | 0) + 1, inRangeFull.length);
      console.log('\n  (Could not re-locate previous position by message id — using stored offset.)');
    } else {
      append = false;
    }
    inRange = inRangeFull.slice(resumeFrom);
    if (append) console.log(`\n  Resuming previous export — skipping first ${resumeFrom} message(s).`);
    else console.log('\n  Previous session state no longer matches — starting fresh.');
  } else {
    inRange = inRangeFull;
  }

  for (const msg of inRange) {
    // WhatsApp Web (July 2026+) renamed the serialized message id from
    // `_serialized` to `$1`; whatsapp-web.js 1.34.7 still reads the old name
    // and passes undefined into the page, making downloadMedia() fail with a
    // cryptic `r: r` error. Backfill so the library sees the id it expects.
    if (msg.id && msg.id._serialized == null && msg.id.$1 != null) {
      msg.id._serialized = msg.id.$1;
    }
  }

  if (!inRange.length) {
    console.log('\n  No (further) messages found for this range.');
    if (!append) fs.writeFileSync(path.join(outDir, 'conversation.txt'), '');
    fs.writeFileSync(metaPath, JSON.stringify({
      chat: chatKey, startTs, endTs,
      lastIndex: Math.max(0, resumeFrom - 1),
      lastId: resumeFrom ? msgKey(inRangeFull[resumeFrom - 1]) : null,
      completed: true,
    }));
    return { saved: 0, skippedExisting: 0, total: resumeFrom, resumed: append ? 'complete' : 'empty' };
  }
  // Group contact lookups are one Puppeteer round-trip per message — the
  // single biggest latency outside media downloads. Warn up front so the
  // user isn't surprised by a long, silent stretch.
  const groupContactHint = chat.isGroup
    ? ' (resolving sender names — this can be slow for large groups)' : '';
  console.log(`\n  Found ${inRange.length} message(s). Exporting…${groupContactHint}\n`);

  const FLUSH_EVERY = 25;
  const transcript = fs.createWriteStream(path.join(outDir, 'conversation.txt'), { flags: append ? 'a' : 'w' });
  const writeLine = line => transcript.write(line + '\n');
  let saved = 0, skippedExisting = 0, pending = 0;

  // ── Pre-flight summary: show the user what's about to happen ──────────
  // Counts media downloads up front so the exported (and time) is clear
  // before starting, not discovered mid-run.
  const totalMedia = inRange.filter(m => m.hasMedia && core.MEDIA_SUBDIR[m.type] &&
    (wantAll || mediaTypes.has(m.type))).length;
  if (totalMedia > 0 && !textOnly) {
    const est = totalMedia > 100 ? ` (~${Math.round(totalMedia / 3)}s at 3/s)`
      : totalMedia > 20 ? ` (~${Math.round(totalMedia / 2)}s at 2/s)`
      : '';
    console.log(`    ↗ ${totalMedia} media file(s) will be downloaded${est}`);
  }

  const flushMeta = lastProcessedIdx => {
    try {
      fs.writeFileSync(metaPath, JSON.stringify({
        chat: chatKey, startTs, endTs,
        lastIndex: lastProcessedIdx,
        lastId: lastProcessedIdx >= 0 ? msgKey(inRangeFull[lastProcessedIdx]) : null,
        completed: false,
      }));
    } catch {}
  };

  // Single updating status line with elapsed time + ETA; extra noise only on
  // errors so long exports stay readable.
  const t0 = Date.now();
  const fmtDur = s => s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
  let lastShown = -1;
  const statusEl = () => Math.floor((Date.now() - t0) / 1000);
  const showStatus = i => {
    if (i === lastShown) return;
    lastShown = i;
    const el = statusEl();
    const rate = el > 0 ? i / el : 0;
    const eta = rate > 0 && i < inRange.length ? Math.round((inRange.length - i) / rate) : null;
    const line = `  [${i}/${inRange.length}] saved:${saved}` +
      (skippedExisting ? ` existed:${skippedExisting}` : '') +
      ` · ${fmtDur(el)} elapsed` + (eta != null ? ` · ~${fmtDur(eta)} left` : '');
    const width = (process.stdout.columns || 120) - 2;
    process.stdout.write('\r' + line.slice(0, width).padEnd(width));
  };
  // A heartbeat so a single slow message (CDN download / contact lookup)
  // still gives live feedback instead of a frozen cursor.
  let heartbeat = null;
  const withHeartbeat = async (i, fn) => {
    heartbeat = setInterval(() => {
      const line = `  [${i}] working… ${fmtDur(statusEl())} elapsed` +
        (chat.isGroup ? ' (resolving sender…) ' : ' (downloading…) ');
      const width = (process.stdout.columns || 120) - 2;
      process.stdout.write('\r' + line.slice(0, width).padEnd(width));
    }, 5000);
    heartbeat.unref();
    try { return await fn(); }
    finally { clearInterval(heartbeat); heartbeat = null; showStatus(i); }
  };

  for (let i = 0; i < inRange.length; i++) {
    const msg = inRange[i];
    showStatus(i);
    const date = msg.timestamp ? new Date(msg.timestamp * 1000) : null;
    const ts = date ? date.toLocaleString() : `msg${i}`;
    const who = oneline(await withHeartbeat(i, () => senderLabel(msg, chat)));
    const subdir = core.MEDIA_SUBDIR[msg.type];
    const keepMedia = wantAll || mediaTypes.has(msg.type);

    if (msg.hasMedia && subdir && keepMedia && !textOnly) {
      try {
        const m = await withHeartbeat(i, () => msg.downloadMedia());
        if (!m || !m.data) {
          process.stdout.write('\n');
          console.log(`  [${i + 1}] skip (no data)`);
          writeLine(`[${ts}] ${who}: [${msg.type} attachment - download failed]`);
          continue;
        }
        const dir = path.join(outDir, subdir);
        if (!core.isSymlink(dir)) core.ensureDir(dir);
        const ext = (m.filename && path.extname(m.filename)) || core.extFromMime(m.mimetype);
        const filename = `${localFileStamp(date)}_${i + resumeFrom}${ext}`;
        const fp = path.join(dir, filename);
        if (core.isSymlink(fp) || core.isSymlink(dir)) {
          throw new Error(`refusing symlink at ${fp}`);
        }
        // O_EXCL write: never follows an existing file/symlink, and doubles as
        // the existing-file check (EEXIST → counted as already downloaded).
        let fd;
        try {
          fd = fs.openSync(fp, 'wx');
        } catch (e) {
          if (e.code === 'EEXIST') skippedExisting++;
          else throw e;
        }
        if (fd != null) {
          try {
            fs.writeFileSync(fd, Buffer.from(m.data, 'base64'));
            saved++;
          } catch (e) {
            // Disk full / permission error: don't leave a truncated file behind.
            try { fs.closeSync(fd); } catch {}
            try { fs.unlinkSync(fp); } catch {}
            throw e;
          }
          fs.closeSync(fd);
        }
        const caption = msg.body ? ` - "${oneline(msg.body)}"` : '';
        writeLine(`[${ts}] ${who}: [${subdir}/${filename}]${caption}`);
      } catch (e) {
        process.stdout.write('\n');
        console.log(`  [${i + 1}] error: ${e.message}`);
        writeLine(`[${ts}] ${who}: [${msg.type} attachment - download failed: ${e.message}]`);
      }
    } else if (msg.hasMedia && subdir && keepMedia && textOnly) {
      const caption = msg.body ? ` "${oneline(msg.body)}"` : '';
      writeLine(`[${ts}] ${who}: [${msg.type} attachment - not downloaded (text-only mode)]${caption}`);
    } else if (msg.hasMedia && subdir && !keepMedia) {
      writeLine(`[${ts}] ${who}: [${msg.type} attachment - excluded by filter]`);
    } else if (msg.hasMedia) {
      writeLine(`[${ts}] ${who}: [unsupported attachment type: ${msg.type}]`);
    } else {
      writeLine(`[${ts}] ${who}: ${oneline(msg.body)}`);
    }

    // Persist progress DURING the run so a crash leaves a resumable state
    // (previously the sidecar was only written on completion, making the
    // documented "re-run to continue" story false for mid-run crashes).
    // Media saves are the slow steps — flush on each of them too so even
    // short interrupted runs leave recoverable state.
    const didMedia = msg.hasMedia && subdir && keepMedia && !textOnly;
    if (++pending >= FLUSH_EVERY || didMedia) {
      pending = 0;
      flushMeta(i + resumeFrom);
      // Yield so big chats don't starve the event loop between downloads.
      await core.sleep(0);
    }
  }
  showStatus(inRange.length);
  process.stdout.write('\n');

  await new Promise((resolve, reject) => {
    transcript.end(resolve);
    transcript.on('error', reject);
  });

  flushMeta(resumeFrom + inRange.length - 1);
  fs.writeFileSync(metaPath, JSON.stringify({
    chat: chatKey, startTs, endTs,
    lastIndex: resumeFrom + inRange.length - 1,
    lastId: msgKey(inRange[inRange.length - 1]),
    completed: true,
  }));

  return { saved, skippedExisting, total: inRange.length + resumeFrom, resumed: append ? 'resumed' : false };
}

function metaPathOf(outDir) { return path.join(outDir, '.export-meta.json'); }

module.exports = {
  getDisplayName, senderLabel, getChatsCompat,
  loadHistory, exportChat, oneline,
  killStaleBrowsers, connectClient, cacheChats, CONNECT_TIMEOUT_MS,
};
