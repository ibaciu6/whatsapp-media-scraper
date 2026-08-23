#!/usr/bin/env node
// Headless CLI scraper. All shared logic lives in lib/; fast paths below
// (--help, --version, account admin, cached name checks) run BEFORE
// whatsapp-web.js is ever required, so they never launch Chromium.
const path = require('path');
const core = require('./lib/core');
const scrape = require('./lib/scrape');
const PKG = require('./package.json');

const HELP_TEXT = `WhatsApp Media Scraper v${PKG.version} — CLI

Usage:
  node index.js                                        list chats (current account)
  node index.js "Chat Name"                            export all time
  node index.js "Chat Name" today                      export today
  node index.js "Chat Name" yesterday                  export yesterday
  node index.js "Chat Name" 2026-06-13                 export a single date
  node index.js "Chat Name" 2026-06-01 2026-06-30      export an inclusive range
  node index.js "Chat Name" all "My Label"             custom folder label
  node index.js --all-chats today --text-only          batch: every chat in range

Options:
  --account <name>        use a specific saved account
  --all-chats             export EVERY chat with the chosen date/scope
  --text-only             transcript only — skip media downloads
  --media-types <list>    comma list: image,video,audio,ptt,document,sticker
  --include-broadcast     also include status/broadcast channels
  --timezone <tz>         IANA zone for date boundaries (e.g. Europe/Berlin);
                          the TZ env var works too and applies everywhere
  --output-dir <path>     set the download root (persists to config)
  --show-output-dir       print current download root and exit
  --list-accounts         list saved accounts and exit
  --disconnect <name>     delete an account's session data and exit
  -h, --help              this help
  -v, --version           version

Output layout:
  <download-root>/<ChatName>/<date>_<session>/
    conversation.txt + images/ videos/ audio/ documents/ stickers/ other/

Interrupted exports resume: re-run the same command into the same folder and
the transcript continues where it stopped (.export-meta.json sidecar).`;

async function main() {
  // Accept both "--flag value" and "--flag=value" for value-taking flags
  // (parity with import-export.js). Only known value-flags are split, so a
  // typo like "--media-types=image" still fails loudly as an unknown option…
  // but "--all-chats=x" correctly reports a stray "x" positional instead.
  const VALUE_FLAGS = ['--account', '--disconnect', '--output-dir', '--media-types', '--timezone'];
  const argv = [];
  for (const raw of process.argv.slice(2)) {
    const vf = VALUE_FLAGS.find(f => raw.startsWith(f + '='));
    if (vf) { argv.push(vf, raw.slice(vf.length + 1)); }
    else argv.push(raw);
  }
  const opts = {
    account: null, disconnect: null, outputDir: null, mediaTypes: null,
    textOnly: false, listAccounts: false, showOutputDir: false,
    allChats: false, includeBroadcast: false, timezone: null,
    name: null, dateFrom: null, dateTo: null, folder: null,
  };
  const seen = new Set();

  const fail = msg => {
    console.error(`[ERR] ${msg}`);
    console.error(`      Run "node index.js --help" for usage.`);
    process.exit(1);
  };

  // ── Timezone must be applied before any Date is created ───────────────
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--timezone') {
      const tz = argv[i + 1];
      if (!tz || tz.startsWith('-')) fail('"--timezone" needs an IANA zone, e.g. Europe/Berlin');
      try { new Intl.DateTimeFormat('en', { timeZone: tz }); }
      catch { fail(`Unknown timezone "${tz}"`); }
      opts.timezone = tz;
      process.env.TZ = tz;
      break;
    }
  }

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--') || a === '-h' || a === '-v') {
      const canon = a === '-h' ? '--help' : a === '-v' ? '--version' : a;
      if (!['--account', '--disconnect', '--output-dir', '--media-types',
        '--list-accounts', '--show-output-dir', '--text-only', '--all-chats',
        '--include-broadcast', '--timezone', '--help', '--version'].includes(canon))
        fail(`Unknown option "${a}"`);
      if (seen.has(canon) && !['--help', '--version'].includes(canon))
        console.error(`[WARN] "${canon}" given more than once — using the last value.`);
      seen.add(canon);

      if (canon === '--help') { console.log(HELP_TEXT); return; }
      if (canon === '--version') { console.log(PKG.version); return; }
      if (canon === '--text-only') { opts.textOnly = true; continue; }
      if (canon === '--all-chats') { opts.allChats = true; continue; }
      if (canon === '--include-broadcast') { opts.includeBroadcast = true; continue; }
      if (canon === '--list-accounts') { opts.listAccounts = true; continue; }
      if (canon === '--show-output-dir') { opts.showOutputDir = true; continue; }
      if (canon === '--timezone') { i++; continue; }   // already handled above

      // Flags that consume a value must not swallow another flag.
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) fail(`"${canon}" needs a value`);
      i++;
      if (canon === '--account') opts.account = next;
      else if (canon === '--disconnect') opts.disconnect = next;
      else if (canon === '--output-dir') opts.outputDir = next;
      else if (canon === '--media-types') opts.mediaTypes = next;
    } else if (!opts.name) {
      opts.name = a;
    } else if (core.isValidDate(a) || /^(today|yesterday|all)$/i.test(a)) {
      if (!opts.dateFrom) opts.dateFrom = a.toLowerCase();
      else if (!opts.dateTo) opts.dateTo = a.toLowerCase();
      else if (!opts.folder) opts.folder = a;
    } else if (!opts.folder) {
      opts.folder = a;
    }
  }

  // ── Fast paths — no browser launched ─────────────────────────────────
  if (opts.showOutputDir) { console.log(core.getBaseOutputDir()); return; }

  if (opts.outputDir) {
    const err = core.validateOutputDir(opts.outputDir);
    if (err) fail(err);
    core.setBaseOutputDir(path.resolve(opts.outputDir.trim()));
    console.log(`[OK] Download location set to: ${path.resolve(opts.outputDir.trim())}`);
    if (!opts.name && !opts.allChats) return;     // setting-only invocation
  }

  if (opts.listAccounts) {
    const accounts = core.listAccounts();
    const current = core.getCurrentAccount();
    console.log('=== Accounts ===');
    if (!accounts.length) console.log('  (none)');
    for (const a of accounts) console.log(`  ${a}${a === current ? '  (current)' : ''}`);
    return;
  }

  if (opts.disconnect) {
    if (!core.accountExists(opts.disconnect)) fail(`Account "${opts.disconnect}" does not exist`);
    core.deleteAccount(opts.disconnect);
    if (core.getCurrentAccount() === opts.disconnect) core.clearCurrentAccount();
    console.log(`[OK] Account "${opts.disconnect}" disconnected.`);
    return;
  }

  // ── Date range resolution ────────────────────────────────────────────
  let startTs = null, endTs = null, label = 'all';
  if (opts.dateFrom && opts.dateFrom !== 'all') {
    const fromStr = opts.dateFrom === 'today' ? core.todayLocal()
      : opts.dateFrom === 'yesterday' ? core.yesterdayLocal() : opts.dateFrom;
    let toStr = fromStr;
    if (opts.dateTo) {
      toStr = opts.dateTo === 'today' ? core.todayLocal()
        : opts.dateTo === 'yesterday' ? core.yesterdayLocal() : opts.dateTo;
    }
    startTs = Math.floor(new Date(fromStr + 'T00:00:00').getTime() / 1000);
    endTs = Math.floor(new Date(toStr + 'T23:59:59').getTime() / 1000);
    if (startTs > endTs) fail(`Date range inverted: ${fromStr} → ${toStr}`);
    label = fromStr === toStr ? fromStr : `${fromStr}_to_${toStr}`;
  }

  // Media type filter
  let mediaTypes = null;
  if (opts.mediaTypes) {
    const valid = new Set(Object.keys(core.MEDIA_SUBDIR));
    mediaTypes = opts.mediaTypes.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const bad = mediaTypes.filter(t => !valid.has(t));
    if (bad.length) fail(`Unknown media type(s): ${bad.join(', ')}. Valid: ${[...valid].join(', ')}`);
    if (!mediaTypes.length) mediaTypes = null;
  }

  const accountName = opts.account || core.getCurrentAccount();

  // ── Chat-name fast-fail via cache (no Chromium needed to reject typos) ─
  if (opts.name && !opts.allChats && accountName && !core.accountExists(accountName)) {
    fail(`Account "${accountName}" does not exist (see --list-accounts)`);
  }
  if (opts.name && !opts.allChats && accountName) {
    const cache = core.loadChatCache(accountName);
    if (cache && cache.chats.length) {
      const needle = opts.name.toLowerCase();
      const hit = cache.chats.some(c =>
        ((c.name || '') + ' ' + c.id.split('@')[0]).toLowerCase().includes(needle));
      if (!hit) {
        console.error(`[ERR] No chat matching "${opts.name}" in the cached list ` +
          `for account "${accountName}" (${cache.chats.length} chats, saved ${core.relTime(cache.savedAt)}).`);
        console.error('      If the chat is brand-new, run once without this name to refresh the cache.');
        process.exit(1);
      }
    }
  }

  // ── Connect & export ─────────────────────────────────────────────────
  scrape.killStaleBrowsers();

  const lockFile = accountName ? core.acquireAccountLock(accountName) : null;
  if (accountName && !lockFile) {
    console.error(`[ERR] Account "${accountName}" is in use by another process.`);
    console.error('      Close the other session (or wait 6h for the stale lock to expire).');
    process.exit(1);
  }

  const scopeOpts = { textOnly: opts.textOnly, mediaTypes };
  let client = null;
  try {
    console.log('[INFO] Launching browser (Chromium)…');
    if (accountName) console.log(`[INFO] Using account: ${accountName}` +
      (opts.timezone ? ` · timezone: ${opts.timezone}` : ''));
    client = await scrape.connectClient(accountName);
    console.log('[OK] WhatsApp ready.');

    const chats = await scrape.getChatsCompat(client);
    scrape.cacheChats(accountName, chats);

    const keepId = id => id !== 'status@broadcast';
    const groups = chats.filter(c => c.isGroup);
    const personalChats = chats.filter(c => !c.isGroup &&
      (keepId(c.id._serialized || c.id.$1) || opts.includeBroadcast));

    if (!opts.name && !opts.allChats) {
      console.log('=== YOUR GROUPS ===');
      groups.forEach((g, i) => console.log(`  ${i + 1}. ${g.name || `Unnamed Group (${scrape.getDisplayName(g)})`}`));
      console.log('\n=== YOUR PERSONAL CHATS ===');
      personalChats.forEach((c, i) => console.log(`  ${i + 1}. ${scrape.getDisplayName(c)}`));
      console.log('\nRun "node index.js --help" for usage.');
      return;
    }

    const targets = [];
    if (opts.allChats) {
      if (opts.name) console.log(`[WARN] --all-chats given; ignoring chat name "${opts.name}".`);
      targets.push(...groups, ...personalChats);
      console.log(`[INFO] Batch mode: exporting ${targets.length} chat(s).`);
    } else {
      // Exact match → unique partial → interactive pick on ambiguity.
      const needle = opts.name.toLowerCase();
      const allChats = [...groups, ...personalChats];
      let group = allChats.find(c => scrape.getDisplayName(c).toLowerCase() === needle);
      if (!group) {
        const matches = allChats.filter(c => scrape.getDisplayName(c).toLowerCase().includes(needle));
        if (matches.length === 1) group = matches[0];
        else if (matches.length > 1) {
          console.log(`[INFO] Multiple chats match "${opts.name}":`);
          matches.forEach((m, idx) => console.log(`  ${idx + 1}. ${scrape.getDisplayName(m)} (${(m.id._serialized || m.id.$1 || '?').split('@')[0]})`));
          if (!process.stdin.isTTY) {
            console.error('[ERR] Re-run with a more specific name.');
            process.exitCode = 1;
            return;
          }
          const readline = require('readline/promises');
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          const ans = (await rl.question('Pick 1-' + matches.length + ': ')).trim();
          rl.close();
          const pick = parseInt(ans, 10);
          if (!(pick >= 1 && pick <= matches.length)) { console.error('[ERR] Invalid choice.'); process.exitCode = 1; return; }
          group = matches[pick - 1];
        }
      }
      if (!group) { console.error(`[ERR] No chat matching "${opts.name}"`); process.exitCode = 1; return; }
      targets.push(group);
    }

    // ── Export loop (single or batch) ────────────────────────────────────
    const baseOut = core.getBaseOutputDir();
    const sessionId = `${label.replace(/-/g, '')}_${core.sessionSuffix()}`;
    const results = [], failures = [];

    for (let t = 0; t < targets.length; t++) {
      const chat = targets[t];
      const displayName = scrape.getDisplayName(chat);
      const safeName = core.sanitizeName(displayName);
      const outDir = opts.folder
        ? path.join(baseOut, safeName, core.sanitizeName(opts.folder), `${sessionId}${targets.length > 1 ? `_${t + 1}` : ''}`)
        : path.join(baseOut, safeName, sessionId);

      console.log(`\n[${t + 1}/${targets.length}] Chat: "${displayName}"`);
      console.log(`[INFO] Output: ${outDir}`);
      if (!core.ensureDir(outDir)) { failures.push([displayName, 'cannot create output dir']); continue; }

      try {
        const loaded = await scrape.loadHistory(chat, startTs);
        const r = await scrape.exportChat(chat, { startTs, endTs, outDir, loadedCount: loaded, ...scopeOpts });
        results.push([displayName, r]);
        if (r.resumed === 'complete') console.log(`[DONE] Already exported — skipped.`);
        else console.log(`[DONE] ${r.saved} file(s)` +
          (r.skippedExisting ? `, ${r.skippedExisting} existed` : '') +
          ` · conversation.txt (${r.total} msgs) → ${outDir}` +
          (r.resumed === 'resumed' ? ' [resumed]' : ''));
      } catch (e) {
        failures.push([displayName, e.message]);
        console.error(`[ERR] ${displayName}: ${e.message} — continuing.`);
      }
    }

    if (targets.length > 1) {
      console.log(`\n===== BATCH SUMMARY =====`);
      for (const [name, r] of results)
        console.log(`  ✓ ${name}: ${r.saved} file(s), ${r.total} msgs` +
          (r.resumed === 'resumed' ? ' [resumed]' : ''));
      for (const [name, why] of failures)
        console.log(`  ✗ ${name}: ${why}`);
      console.log(`=========================`);
      if (failures.length) process.exitCode = 1;
    }
  } finally {
    if (client) { try { await client.destroy(); } catch {} }
    if (lockFile) core.releaseAccountLock(lockFile);
  }
}

if (require.main === module) {
  main().catch(e => {
    console.error('[ERR] ' + (e && e.message ? e.message : e));
    process.exit(1);
  });
}

module.exports = { main };
