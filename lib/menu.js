#!/usr/bin/env node
// Interactive menu implementation (launched via ../menu.js).
const path = require('path');
const readline = require('readline');
const PKG = require('../package.json');
const core = require('./core');
const scrape = require('./scrape');

// ── `q` = back for list prompts ─────────────────────────────────────────
// inquirer v8 has no "back" key handling. A `q` keypress resolves the active
// list prompt with a sentinel that each menu maps to "back".
// Idempotent: main() and liveScrapeFlow() both call this; patching twice used
// to stack duplicate keypress listeners and break the UI close re-arm.
let BACK_RESULT = null;
let activePrompt = null;
let keypressListener = null;
let inquirerPatched = false;

function cleanupKeypressListener() {
  if (keypressListener) {
    process.stdin.removeListener('keypress', keypressListener);
    keypressListener = null;
  }
}

function patchInquirer() {
  const inquirer = require('inquirer');
  if (inquirerPatched) return inquirer;
  inquirerPatched = true;

  BACK_RESULT = '\u0000__BACK__';
  readline.emitKeypressEvents(process.stdin);

  // Only List prompts get the bare-`q` shortcut — they can't accept typed
  // text and have a reliable onSubmit. (Checkbox prompts are deliberately
  // excluded: stripping their readline mid-selection would freeze them.)
  // Input prompts / confirms take plain text instead: type `q` + Enter.
  const onQ = (str, key) => {
    if (!key) return;
    // Raw mode (re-armed between prompts) turns Ctrl+C into a keypress
    // instead of a SIGINT signal — handle it here or abort becomes impossible
    // during long operations like the QR wait.
    if (key.ctrl && key.name === 'c') { exitWithCleanup(130); return; }
    if (key.name !== 'q') return;
    const p = activePrompt;
    if (!p || p.constructor.name !== 'ListPrompt') return;
    const fn = p.onSubmit ? p.onSubmit.bind(p)
      : p.onEnd ? p.onEnd.bind(p) : null;
    if (!fn) return;
    // The decoder emits the keypress before the prompt's readline sees it,
    // which would leak a stray 'q' into the next rendered prompt. Drop the
    // readline listeners only once we know we're taking over.
    p.rl.removeAllListeners();
    fn(BACK_RESULT);
  };
  process.stdin.setMaxListeners(0);
  process.stdin.on('keypress', onQ);
  keypressListener = onQ;

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

  // Re-arm the tty at the very end of inquirer's UI close; guard so repeated
  // Ctrl+C closes never throw ERR_USE_AFTER_CLOSE.
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

// ── Banner ──────────────────────────────────────────────────────────────
let firstBanner = true;
function printBanner() {
  // Clear only once at startup; afterwards just redraw the header so the
  // terminal scrollback (QR codes, results) is preserved.
  if (firstBanner) { console.clear(); firstBanner = false; }
  else console.log('');
  const title = `WhatsApp Media Scraper v${PKG.version}`;
  console.log('═'.repeat(44));
  console.log(`   ${title}`);
  console.log('═'.repeat(44));
}

// Kill stale browsers / connect are shared with the CLI — live in scrape.js.
const { killStaleBrowsers, connectClient } = require('./scrape');

// Short human suffix for duplicate / unnamed entries: local id part only
// (e.g. "1234567890@c.us" → "1234567890"), never the raw "@c.us" blob.
function shortId(chat) {
  const s = (chat.id && (chat.id._serialized || chat.id.$1)) || '';
  return s.split('@')[0] || '?';
}

function buildChatChoices(list) {
  const names = list.map(c => scrape.getDisplayName(c));
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  return list.map((c, i) => {
    let label = names[i];
    if (dupes.includes(label) || label === 'Unnamed Group') label += ` (${shortId(c)})`;
    return { name: label, value: i };
  });
}

// ── Export flow ─────────────────────────────────────────────────────────
async function pickMediaScope(inquirer) {
  const { scope } = await inquirer.prompt([{
    type: 'list', name: 'scope',
    message: 'What should be exported? (q = back)',
    choices: [
      { name: 'Everything (media + transcript)', value: 'all' },
      { name: 'Transcript only — no media downloads', value: 'text' },
      { name: 'Choose specific media types…', value: 'pick' },
    ],
  }]);
  if (scope === BACK_RESULT) return null;
  if (scope === 'text') return { textOnly: true };
  if (scope === 'all') return {};
  const { types } = await inquirer.prompt([{
    type: 'checkbox', name: 'types',
    message: 'Include which types? (space=toggle, enter=confirm)',
    choices: Object.entries(core.MEDIA_SUBDIR)
      .map(([type, dir]) => ({ name: `${dir} (${type})`, value: type, checked: true })),
    validate: v => v.length > 0 || 'Select at least one type',
  }]);
  return { mediaTypes: types };
}

async function confirmAndExport(inquirer, ctx) {
  const { group, groupName, startTs, endTs, label } = ctx;

  // Output folder
  const safeName = core.sanitizeName(groupName);
  const dateStr = label === 'all' ? 'all' : label.replace(/-/g, '');
  const sessionId = `${dateStr}_${core.sessionSuffix()}`;
  let outDir = path.join(core.getBaseOutputDir(), safeName, sessionId);

  const { sessionName } = await inquirer.prompt([{
    type: 'input', name: 'sessionName',
    message: 'Session label (optional, q = back):',
    default: '',
    // Forbid only characters that are unsafe in file paths — Unicode,
    // emojis and accents are all fine now.
    validate: v => v === 'q' || !/[\\/:*?"<>|\x00-\x1f]/.test(v.trim()) ||
      'Cannot contain: \\ / : * ? " < > |',
  }]);
  if (sessionName === 'q') return 'back';

  if (sessionName.trim()) outDir += '_' + core.sanitizeName(sessionName.trim());

  // Media scope
  const scope = await pickMediaScope(inquirer);
  if (scope === null) return 'back';

  // Summary + confirm (with live preview option)
  while (true) {
    const displayOutDir = path.relative(core.getBaseOutputDir(), outDir);
    console.log('\n  ┌─────────────────────────────────────────────┐');
    console.log(`    Chat:     ${groupName}`);
    console.log(`    Range:    ${label || 'all time'}`);
    console.log(`    Media:    ${scope.textOnly ? 'none (text-only)'
      : scope.mediaTypes ? scope.mediaTypes.join(', ') : 'everything'}`);
    console.log(`    Output:   ${displayOutDir}`);
    if (ctx.preview) {
      console.log(`    Messages: ~${ctx.preview.total} in range (${ctx.preview.media} with media` +
        (scope.textOnly ? ', text-only' : scope.mediaTypes ? `, ${ctx.preview.downloads} match filter` : '') + ')');
    }
    console.log('  └─────────────────────────────────────────────┘\n');

    const { action } = await inquirer.prompt([{
      type: 'list', name: 'action',
      message: 'Start export?',
      choices: [
        { name: 'Yes — start export', value: 'go' },
        ...(ctx.preview ? [] : [{ name: 'Preview message count first', value: 'preview' }]),
        { name: 'No — back', value: 'no' },
      ],
    }]);
    if (action === BACK_RESULT || action === 'no') return 'back';

    if (action === 'preview') {
      console.log('');
      const loaded = await scrape.loadHistory(group, startTs);
      const all = loaded && loaded.length ? loaded : await group.fetchMessages({ limit: Math.max(99999, Array.isArray(loaded) ? loaded.length : 0) });
      const inRange = all.filter(m =>
        (!startTs || m.timestamp >= startTs) && (!endTs || m.timestamp <= endTs));
      const keepType = t => !scope.mediaTypes || scope.mediaTypes.includes(t);
      const downloadable = inRange.filter(m => m.hasMedia &&
        core.MEDIA_SUBDIR[m.type] && keepType(m.type) && !scope.textOnly).length;
      ctx.preview = {
        total: inRange.length,
        media: inRange.filter(m => m.hasMedia).length,
        downloads: downloadable,
      };
      continue; // redisplay summary with counts
    }

    if (!core.ensureDir(outDir)) return 'done'; // friendly error already shown
    const loaded = await scrape.loadHistory(group, startTs);
    const { saved, skippedExisting, total } =
      await scrape.exportChat(group, { startTs, endTs, outDir, loadedMessages: loaded, ...scope });
    console.log(`\n  ✓ Done — ${saved} file(s) saved` +
      (skippedExisting ? `, ${skippedExisting} already existed` : '') +
      ` · conversation.txt written (${total} messages).`);
    console.log(`    Folder: ${outDir}\n`);
    return 'done';
  }
}

async function liveScrapeFlow(accountName) {
  killStaleBrowsers();

  const lockFile = core.acquireAccountLock(accountName);
  if (!lockFile) {
    console.error(`\n  ✗ Account "${accountName}" is in use by another process.`);
    console.error('    Close the other session (or wait 6h for the stale lock to expire).\n');
    return;
  }

  const inquirer = patchInquirer();
  let client = null;
  activeClient = null;
  let includeBroadcast = false;
  try {
    console.log('\n── Connecting to WhatsApp Web ──\n');
    console.log('  • Launching browser (Chromium)…');
    console.log(`  • Account: ${accountName}`);
    client = await connectClient(accountName, { onClient: c => { activeClient = c; } });
    activeClient = client;

    console.log('  • Loading chat list…');
    const chats = await scrape.getChatsCompat(client);
    scrape.cacheChats(accountName, chats);
    const groups = chats.filter(c => c.isGroup);
    const allPersonal = chats.filter(c => !c.isGroup &&
      (c.id._serialized || c.id.$1) !== 'status@broadcast');
    const personalChats = () => includeBroadcast
      ? chats.filter(c => !c.isGroup)
      : allPersonal;

    console.log(`  ✓ Ready — ${chats.length} chats (${groups.length} groups, ${personalChats().length} personal).\n`);

    // Batch-export many chats with one timeframe/media choice.
    async function runBatch(list, noun) {
      printBanner();
      const tf = await inquirer.prompt([{
        type: 'list', name: 'timeframe',
        message: `Timeframe for ALL ${noun}s:`,
        choices: [
          { name: `Today       (${core.todayLocal()})`, value: 'today' },
          { name: `Yesterday   (${core.yesterdayLocal()})`, value: 'yesterday' },
          { name: 'Specific date', value: 'date' },
          { name: 'Date range  (from → to)', value: 'range' },
          { name: 'All time', value: 'all' },
        ],
      }]);
      if (tf.timeframe === BACK_RESULT) return;

      let startTs = null, endTs = null, label = '';
      if (tf.timeframe === 'today') {
        ({ startTs, endTs } = core.parseRange(core.todayLocal())); label = core.todayLocal();
      } else if (tf.timeframe === 'yesterday') {
        ({ startTs, endTs } = core.parseRange(core.yesterdayLocal())); label = core.yesterdayLocal();
      } else if (tf.timeframe === 'date') {
        const { d } = await inquirer.prompt([{
          type: 'input', name: 'd', message: 'Date YYYY-MM-DD (q = back):',
          default: core.todayLocal(),
          validate: v => v === 'q' || core.isValidDate(v) || 'Use YYYY-MM-DD',
        }]);
        if (d === 'q' || d === BACK_RESULT) return;
        ({ startTs, endTs } = core.parseRange(d)); label = d;
      } else if (tf.timeframe === 'range') {
        const { from, to } = await inquirer.prompt([
          { type: 'input', name: 'from', message: 'From YYYY-MM-DD:', default: core.yesterdayLocal(),
            validate: v => core.isValidDate(v) || 'Use YYYY-MM-DD' },
          { type: 'input', name: 'to', message: 'To   YYYY-MM-DD:', default: core.todayLocal(),
            validate: v => core.isValidDate(v) || 'Use YYYY-MM-DD' },
        ]);
        if (new Date(from) > new Date(to)) {
          console.log('\n  ✗ "From" is after "To".'); return;
        }
        startTs = Math.floor(new Date(from + 'T00:00:00').getTime() / 1000);
        endTs = Math.floor(new Date(to + 'T23:59:59').getTime() / 1000);
        label = `${from}_to_${to}`;
      } else label = 'all';

      const scope = await pickMediaScope(inquirer);
      if (scope === null) return;

      const baseOut = core.getBaseOutputDir();
      const sessionId = `${label.replace(/-/g, '')}_${core.sessionSuffix()}`;
      const ok = [], bad = [];
      for (let i = 0; i < list.length; i++) {
        const chat = list[i];
        const name = scrape.getDisplayName(chat);
        console.log(`\n  [${i + 1}/${list.length}] ${name}`);
        const outDir = path.join(baseOut, core.sanitizeName(name), sessionId);
        if (!core.ensureDir(outDir)) { bad.push([name, 'output dir']); continue; }
        try {
          const loaded = await scrape.loadHistory(chat, startTs);
          const r = await scrape.exportChat(chat, { startTs, endTs, outDir, loadedMessages: loaded, ...scope });
          ok.push([name, r]);
          if (r.resumed === 'complete') console.log('  already exported — skipped');
        } catch (e) { bad.push([name, e.message]); }
      }
      console.log('\n  ── Batch summary ──');
      ok.forEach(([n, r]) => console.log(`   ✓ ${n}: ${r.saved} file(s), ${r.total} msgs`));
      bad.forEach(([n, why]) => console.log(`   ✗ ${n}: ${why}`));
      console.log('');
    }

    while (true) {
      printBanner();
      const { chatType } = await inquirer.prompt([{
        type: 'list', name: 'chatType',
        message: 'Scrape what?  (main menu — ⛔ Exit quits)',
        choices: [
          { name: 'Group', value: 'group' },
          { name: 'Personal chat', value: 'personal' },
          new inquirer.Separator(),
          { name: `⚡  ALL groups (batch)`, value: 'group-all' },
          { name: `⚡  ALL personal chats (batch)`, value: 'personal-all' },
          new inquirer.Separator(),
          { name: `${includeBroadcast ? '🔔' : '🔕'} Include status/broadcast: ${includeBroadcast ? 'ON' : 'off'}`, value: 'toggle-broadcast' },
          { name: '⛔  Exit', value: 'exit' },
        ],
      }]);
      if (chatType === 'exit') break;
      if (chatType === 'toggle-broadcast') { includeBroadcast = !includeBroadcast; continue; }
      if (chatType === BACK_RESULT) continue;

      if (chatType === 'group-all') { await runBatch(groups, 'group'); continue; }
      if (chatType === 'personal-all') { await runBatch(personalChats(), 'personal chat'); continue; }

      const baseList = chatType === 'group' ? groups : personalChats();
      const noun = chatType === 'group' ? 'group' : 'chat';

      while (true) {
        printBanner();
        let choices = buildChatChoices(baseList);

        // Optional type-to-filter search (#41): keeps huge lists usable.
        const { useSearch } = await inquirer.prompt([{
          type: 'list', name: 'useSearch',
          message: `${baseList.length} ${noun}s found`,
          choices: [
            { name: `Browse list`, value: false },
            { name: `Search by name…`, value: true },
            new inquirer.Separator(),
            { name: '⛔  Back', value: BACK_RESULT },
          ],
        }]);
        if (useSearch === BACK_RESULT) break;

        if (useSearch) {
          const { needle } = await inquirer.prompt([{
            type: 'input', name: 'needle',
            message: 'Search (blank = show all, q = back):',
          }]);
          if (needle === 'q' || needle === BACK_RESULT) break;
          const n = needle.trim().toLowerCase();
          choices = choices.filter(c => c.name.toLowerCase().includes(n));
          if (!choices.length) { console.log('\n  No matches.'); continue; }
        }

        choices.push(new inquirer.Separator(), { name: '⛔  Back', value: -1 });
        const { chatIndex } = await inquirer.prompt([{
          type: 'list', name: 'chatIndex',
          message: `Select a ${noun}:`,
          choices, pageSize: 15,
        }]);
        if (chatIndex === BACK_RESULT || chatIndex === -1) continue;

        const group = baseList[chatIndex];
        const groupName = scrape.getDisplayName(group);

        // Timeframe
        while (true) {
          const tf = await inquirer.prompt([{
            type: 'list', name: 'timeframe',
            message: 'Timeframe:',
            choices: [
              { name: `Today       (${core.todayLocal()})`, value: 'today' },
              { name: `Yesterday   (${core.yesterdayLocal()})`, value: 'yesterday' },
              { name: 'Specific date', value: 'date' },
              { name: 'Date range  (from → to)', value: 'range' },
              { name: 'All time', value: 'all' },
            ],
          }]);
          if (tf.timeframe === BACK_RESULT) break;

          let startTs = null, endTs = null, label = '';
          if (tf.timeframe === 'today') {
            ({ startTs, endTs } = core.parseRange(core.todayLocal())); label = core.todayLocal();
          } else if (tf.timeframe === 'yesterday') {
            ({ startTs, endTs } = core.parseRange(core.yesterdayLocal())); label = core.yesterdayLocal();
          } else if (tf.timeframe === 'date') {
            const { d } = await inquirer.prompt([{
              type: 'input', name: 'd', message: 'Date YYYY-MM-DD (q = back):',
              default: core.todayLocal(),
              validate: v => v === 'q' || core.isValidDate(v) || 'Use YYYY-MM-DD, e.g. 2026-06-13',
            }]);
            if (d === 'q' || d === BACK_RESULT) continue;
            ({ startTs, endTs } = core.parseRange(d)); label = d;
          } else if (tf.timeframe === 'range') {
            const { from, to } = await inquirer.prompt([
              { type: 'input', name: 'from', message: 'From YYYY-MM-DD:', default: core.yesterdayLocal(),
                validate: v => core.isValidDate(v) || 'Use YYYY-MM-DD, e.g. 2026-06-12' },
              { type: 'input', name: 'to', message: 'To   YYYY-MM-DD:', default: core.todayLocal(),
                validate: v => core.isValidDate(v) || 'Use YYYY-MM-DD, e.g. 2026-06-13' },
            ]);
            if (new Date(from) > new Date(to)) {
              console.log('\n  ✗ "From" is after "To" — swap the dates and retry.');
              continue;
            }
            startTs = Math.floor(new Date(from + 'T00:00:00').getTime() / 1000);
            endTs = Math.floor(new Date(to + 'T23:59:59').getTime() / 1000);
            label = `${from}_to_${to}`;
          } else {
            label = 'all';
          }

          const result = await confirmAndExport(inquirer, { group, groupName, startTs, endTs, label });
          if (result === 'back') continue;      // timeframe menu
          // done → pause then back to chat list
          await inquirer.prompt([{ type: 'input', name: '_', message: 'Press Enter to return to the chat list' }]);
          printBanner();
          break;
        }
      }
    }
  } finally {
    activeClient = null;
    if (client) { try { await client.destroy(); } catch {} }
    core.releaseAccountLock(lockFile);
  }
}

// ── Account & settings flows ────────────────────────────────────────────
let activeClient = null;   // best-effort destroy on forced exits

function exitWithCleanup(code) {
  cleanupKeypressListener();
  try { process.stdin.setRawMode(false); } catch {}
  process.stdin.pause();
  // Give the WhatsApp client a moment to close Chromium, but never hang.
  if (activeClient) {
    const c = activeClient;
    setTimeout(() => process.exit(code), 1000).unref();
    c.destroy().catch(() => {}).finally(() => { try { process.exit(code); } catch {} });
    return;
  }
  process.exit(code);
}

process.on('uncaughtException', e => {
  console.error('\n⚠ Unexpected error: ' + (e && e.message ? e.message : e) + '\n');
  exitWithCleanup(1);
});
process.on('unhandledRejection', e => {
  console.error('\n⚠ Unexpected failure: ' + (e && e.message ? e.message : e) + '\n');
  exitWithCleanup(1);
});

// dirSize walks every file recursively — multi-GB accounts would stall the
// menu on every render, so cache sizes for a minute.
const sizeCache = new Map();
function accountSize(acc) {
  const hit = sizeCache.get(acc);
  if (hit && Date.now() - hit.at < 60_000) return hit.size;
  const size = core.dirSize(core.getAccountPath(acc));
  sizeCache.set(acc, { size, at: Date.now() });
  return size;
}

async function accountSelectionMenu(inquirer) {
  const accounts = core.listAccounts();
  const current = core.getCurrentAccount();
  const baseDir = core.getBaseOutputDir();
  // Keep long paths readable inside one menu row.
  const shownDir = baseDir.length > 42 ? '…' + baseDir.slice(-40) : baseDir;

  const choices = [];
  if (accounts.length) {
    choices.push(new inquirer.Separator('── Accounts (size · last used) ──'));
    for (const acc of accounts) {
      const meta = core.readAccountMeta(acc);
      const size = core.humanSize(accountSize(acc));
      const last = core.relTime(meta.lastUsed) || 'never';
      choices.push({
        name: `${acc}${acc === current ? '  (current)' : ''}   · ${size} · ${last}`,
        value: `use:${acc}`,
      });
    }
    choices.push(new inquirer.Separator());
    choices.push({ name: '➕  Add new account', value: 'add' });
    choices.push({ name: '🗑️  Disconnect an account', value: 'disconnect' });
  } else {
    choices.push(new inquirer.Separator('── First run ──'));
    choices.push({ name: '➕  Add new account (scan QR)', value: 'add' });
  }
  choices.push(new inquirer.Separator('── Settings ──'));
  choices.push({ name: `📁  Download location: ${shownDir}`, value: 'settings' });
  choices.push(new inquirer.Separator());
  choices.push({ name: '⛔  Exit', value: 'exit' });

  const { action } = await inquirer.prompt([{
    type: 'list', name: 'action',
    message: 'Select account or action  (q = nothing)',
    choices, pageSize: 15,
  }]);
  return action;
}

async function addAccountFlow(inquirer) {
  const { name } = await inquirer.prompt([{
    type: 'input', name: 'name',
    message: 'Account name (letters, numbers, dash, underscore):',
    validate: v => /^[\w-]{1,32}$/.test(v.trim()) || '1–32 chars: letters, numbers, dash, underscore',
  }]);
  const accountName = name.trim();
  if (core.accountExists(accountName)) {
    console.log(`\n  ✗ Account "${accountName}" already exists.\n`);
    return null;
  }
  return accountName;
}

async function disconnectAccountFlow(inquirer) {
  const accounts = core.listAccounts();
  if (!accounts.length) { console.log('\n  No accounts to disconnect.\n'); return; }

  const { name } = await inquirer.prompt([{
    type: 'list', name: 'name',
    message: 'Which account?',
    choices: accounts.map(a => ({ name: a, value: a })),
  }]);

  // Destructive action: require typing the exact name — no accidental deletes.
  // `q` is the universal escape hatch back to safety.
  const { typed } = await inquirer.prompt([{
    type: 'input', name: 'typed',
    message: `Type "${name}" to confirm deletion (q = cancel):`,
    validate: v => v.trim() === name || v.trim() === 'q' ||
      'Name does not match — type the account name exactly, or q to cancel',
  }]);
  if (typed.trim() !== name) {
    console.log('\n  Deletion cancelled.\n');
    return;
  }

  core.deleteAccount(name);
  if (core.getCurrentAccount() === name) core.clearCurrentAccount();
  console.log(`\n  ✓ Account "${name}" disconnected (session files deleted).\n`);
}

async function switchAccountFlow(inquirer, current) {
  const accounts = core.listAccounts();
  if (!accounts.length) { console.log('\n  No accounts yet — add one first.\n'); return null; }
  const { name } = await inquirer.prompt([{
    type: 'list', name: 'name',
    message: current ? `Switch away from "${current}" to:` : 'Switch to:',
    choices: accounts.map(a => ({
      name: a === current ? `${a}  (current)` : a,
      value: a,
      disabled: a === current ? 'already active' : false,
    })),
  }]);
  return name;
}

async function settingsFlow(inquirer) {
  const cur = core.getBaseOutputDir();
  console.log(`\n  Current download location:\n    ${cur}\n`);
  const { newDir } = await inquirer.prompt([{
    type: 'input', name: 'newDir',
    message: 'New absolute path (q = back):',
    default: cur,
    validate: v => v === 'q' || !!v.trim() || 'Path cannot be empty',
  }]);
  if (newDir === 'q' || newDir === BACK_RESULT) return;

  const err = core.validateOutputDir(newDir);   // absolute + creatable + writable
  if (err) { console.log(`\n  ✗ ${err}\n`); return; }
  core.setBaseOutputDir(path.resolve(newDir.trim()));
  console.log(`\n  ✓ Download location set to: ${path.resolve(newDir.trim())}\n`);
}

async function main() {
  printBanner();
  console.log('  Loading prompts library…');
  const inquirer = patchInquirer();

  while (true) {
    const action = await accountSelectionMenu(inquirer);
    if (action === 'exit') break;
    if (action === BACK_RESULT) continue;

    let accountName = null;
    if (action === 'add') {
      accountName = await addAccountFlow(inquirer);
      if (!accountName) continue;
      core.setCurrentAccount(accountName);
    } else if (typeof action === 'string' && action.startsWith('use:')) {
      accountName = action.slice(4);
      core.setCurrentAccount(accountName);
    } else if (action === 'disconnect') { await disconnectAccountFlow(inquirer); continue; }
    else if (action === 'settings') { await settingsFlow(inquirer); continue; }

    if (accountName) {
      await liveScrapeFlow(accountName);
      printBanner();
    }
  }

  console.log('\nGoodbye!\n');
  exitWithCleanup(0);
}

if (require.main === module) {
  main().catch(e => { console.error(e); exitWithCleanup(1); });
}

module.exports = { patchInquirer, liveScrapeFlow, main };
