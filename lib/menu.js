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
const BANNER_W = 56;

// Terminal display width (columns), not JS string length: Wide/Fullwidth
// ranges and emoji occupy 2 columns, ZWJ / variation selectors take none.
function dispWidth(t) {
  let w = 0;
  for (const ch of Array.from(String(t))) {
    const c = ch.codePointAt(0);
    if (c === 0x200d) continue;                 // zero-width joiner
    if (c >= 0xfe00 && c <= 0xfe0f) continue;   // variation selectors
    if (c >= 0x20d0 && c <= 0x20ff) continue;   // combining marks
    if ((c >= 0x2600 && c <= 0x27bf) ||         // symbols, dingbats (⚡ ✓ ➕)
        (c >= 0x1f000 && c <= 0x1faff) ||       // chess + most emoji (📱 🔍 ⛔)
        (c >= 0x1100 && c <= 0x115f) ||         // Hangul Jamo
        (c >= 0x2e80 && c <= 0xa4cf) ||         // CJK radicals, Kana, Han
        (c >= 0xac00 && c <= 0xd7a3) ||         // Hangul syllables
        (c >= 0xf900 && c <= 0xfaff) ||
        (c >= 0xfe10 && c <= 0xfe19) ||         // vertical forms
        (c >= 0xfe30 && c <= 0xfe6f) ||
        (c >= 0xff00 && c <= 0xff60) ||         // full-width forms
        (c >= 0xffe0 && c <= 0xffe6)) w += 2;   // ￠￡￥
    else w += 1;
  }
  return w;
}

function padInner(txt, W = BANNER_W) {
  const t = String(txt);
  const d = dispWidth(t);
  if (d >= W) {                                 // truncate to fit, never overflow
    let out = '', w = 0;
    for (const ch of Array.from(t)) {
      const cw = dispWidth(ch);
      if (w + cw > W) break;
      out += ch; w += cw;
    }
    return out;
  }
  return t + ' '.repeat(W - d);                 // pad to display width, not length
}

function centerInner(txt, W = BANNER_W) {
  const t = String(txt);
  const d = dispWidth(t);
  const pad = Math.max(1, Math.floor((W - d) / 2));
  return ' '.repeat(pad) + t + ' '.repeat(Math.max(1, W - d - pad));
}

// One horizontal line of a box: interior is exactly W chars wide, so it
// matches the `┌┼└` borders (which are W dashes wide) in every renderer.
function boxLine(inner, W = BANNER_W) {
  return '│' + padInner(inner, W) + '│';
}

function printBanner() {
  // Clear only once at startup; afterwards just redraw the header so the
  // terminal scrollback (QR codes, results) is preserved.
  if (firstBanner) { console.clear(); firstBanner = false; }
  else console.log('');
  console.log('┌' + '─'.repeat(BANNER_W) + '┐');
  console.log('│' + ' '.repeat(BANNER_W) + '│');
  console.log(boxLine(centerInner('📱 WhatsApp Media Scraper')));
  console.log(boxLine(centerInner('export chats & media — v' + PKG.version)));
  console.log('│' + ' '.repeat(BANNER_W) + '│');
  console.log('└' + '─'.repeat(BANNER_W) + '┘');
  console.log('');
}

// Section card drawn above each inquirer menu.
function menuHeader(title, hint) {
  console.log('┌' + '─'.repeat(BANNER_W) + '┐');
  console.log(boxLine(' ' + title));
  if (hint) console.log(boxLine('   ' + hint));
  console.log('└' + '─'.repeat(BANNER_W) + '┘');
  console.log('');
}

// Small box for status screens (connect, summaries, messages). Width grows
// to fit the longest line (account names / paths can be long).
function boxLines(lines, { title } = {}) {
  const ls = lines.map(l => String(l));
  const inner = Math.max(24, ...ls.map(dispWidth));
  // One box width everywhere — title too (display-width, like the rows) — so
  // the top border, rows, and bottom border always line up.
  const W = Math.max(inner + 4, (title ? dispWidth(title) : 0) + 4);
  console.log('┌' + '─'.repeat(W) + '┐');
  if (title) console.log(boxLine(' ' + title + ' ', W));
  for (const l of ls) console.log(boxLine(' ' + l, W));
  console.log('└' + '─'.repeat(W) + '┘');
}

// Section divider inside an inquirer list menu.
function group(sep) { return new (require('inquirer').Separator)(sep); }

// Dead-end recovery menu: a core step could not proceed. Shows what failed
// and lets the user retry, bail back one level, or exit — a phase error must
// never silently kill the whole menu. Returns 'retry' | 'back' | 'exit'
// (bare `q` on the List prompt = 'back').
async function recoveryMenu(inquirer, title, err, extraActions = []) {
  const errText = String((err && err.message) || err).split('\n');
  menuHeader(title, 'this step did not complete');
  boxLines(['', ...errText.map(l => `  ${l}`), ''], { title: 'Why it failed' });
  console.log('');
  const { choice } = await inquirer.prompt([{
    type: 'list', name: 'choice',
    message: 'What now?',
    choices: [
      { name: '🔁  Retry', value: 'retry' },
      ...extraActions.map(a => ({ name: a.label, value: a.value })),
      { name: '↩  Back', value: 'back' },
      { name: '⛔  Exit', value: 'exit' },
    ],
  }]);
  return choice === BACK_RESULT ? 'back' : choice;
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
  menuHeader('Export scope', 'what media should be downloaded? (q = back)');
  const { scope } = await inquirer.prompt([{
    type: 'list', name: 'scope',
    message: 'What should be exported?',
    choices: [
      { name: '📦  Everything — media + transcript', value: 'all' },
      { name: '📝  Transcript only — no media downloads', value: 'text' },
      new inquirer.Separator(),
      { name: '🎚️  Choose specific media types…', value: 'pick' },
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
    boxLines([
      '',
      `  Chat       ${groupName}`,
      `  Range      ${label || 'all time'}`,
      `  Media      ${scope.textOnly ? 'none (text-only)'
        : scope.mediaTypes ? scope.mediaTypes.join(', ') : 'everything'}`,
      `  Output     ${displayOutDir}`,
      ctx.preview
        ? `  Messages   ~${ctx.preview.total} in range (${ctx.preview.media} with media` +
          (scope.textOnly ? ', text-only' : scope.mediaTypes ? `, ${ctx.preview.downloads} match filter` : '') + ')'
        : '  Messages   — run preview to count',
      '',
    ], { title: 'Export summary' });
    console.log('');

    menuHeader('Start export', 'review before writing files (q = back)');
    const { action } = await inquirer.prompt([{
      type: 'list', name: 'action',
      message: 'Ready?',
      choices: [
        { name: '🚀  Yes — start export', value: 'go' },
        ...(ctx.preview ? [] : [{ name: '🔍  Preview message count first', value: 'preview' }]),
        new inquirer.Separator(),
        { name: '↩  No — back', value: 'no' },
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
    let done = null;
    while (done === null) {
      let r;
      try {
        const loaded = await scrape.loadHistory(group, startTs);
        r = await scrape.exportChat(group, { startTs, endTs, outDir, loadedMessages: loaded, ...scope });
      } catch (err) {
        const go = await recoveryMenu(inquirer, 'Export failed', err, [
          { label: '⏭️  Skip this chat', value: 'skip' },
        ]);
        if (go === 'exit') exitWithCleanup(0);
        if (go === 'back' || go === 'skip') return 'done';
        // retry → rerun export for this chat
      }
      if (!r) r = { error: 'returned no result' };   // never spin: surface & prompt
      if (r.error) {
        // exportChat fell back to a refusal/empty result — never show a fake
        // "done" box; surface it through recovery so the user can act on it.
        const go = await recoveryMenu(inquirer, 'Export blocked', new Error(
          r.error === 'symlink'
            ? 'The output folder contains symlinks where regular files belong (possible path traversal).\nRemove the symlink and retry — or pick a different folder.'
            : String(r.error)),
        );
        if (go === 'exit') exitWithCleanup(0);
        if (go === 'back') return 'done';
        continue; // retry → rerun export for this chat
      }
      done = r;
    }
    const { saved, skippedExisting, total } = done;
    boxLines([
      '',
      `  ✓ Done — ${saved} file(s) saved` +
        (skippedExisting ? `, ${skippedExisting} already existed` : ''),
      `    conversation.txt written (${total} messages).`,
      `    Folder: ${outDir}`,
      '',
    ], { title: 'Export finished' });
    console.log('');
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
    boxLines([
      '  Browser:  Chromium (auto-provisioned if missing)',
      `  Account:  ${accountName}`,
      '  Session:  restoring…',
    ], { title: 'Connecting to WhatsApp Web' });
    console.log('');
    while (true) {
      try {
        client = await connectClient(accountName, { onClient: c => { activeClient = c; } });
        break;
      } catch (err) {
        const go = await recoveryMenu(inquirer, 'Connection failed', err);
        if (go === 'exit') exitWithCleanup(0);
        if (go === 'back') return;
        // retry → fresh attempt
      }
    }
    activeClient = client;

    console.log('  • Loading chat list…');
    let chats;
    while (true) {
      try {
        chats = await scrape.getChatsCompat(client);
        break;
      } catch (err) {
        const go = await recoveryMenu(inquirer, 'Chat list failed', err, [
          { label: '🗑️  Disconnect & re-add this account', value: 'reinit' },
        ]);
        if (go === 'exit') exitWithCleanup(0);
        if (go === 'back') return;
        if (go === 'reinit') {
          if (!core.deleteAccount(accountName)) {
            console.log(`\n  ✗ Could not remove "${accountName}" (files in use?) — delete it manually if needed.\n`);
          } else {
            if (core.getCurrentAccount() === accountName) core.clearCurrentAccount();
            console.log(`\n  ✓ Account "${accountName}" removed — re-add it to scan a fresh QR.\n`);
          }
          return;
        }
        // retry → fresh attempt
      }
    }
    scrape.cacheChats(accountName, chats);
    const groups = chats.filter(c => c.isGroup);
    const allPersonal = chats.filter(c => !c.isGroup &&
      (c.id._serialized || c.id.$1) !== 'status@broadcast');
    const personalChats = () => includeBroadcast
      ? chats.filter(c => !c.isGroup)
      : allPersonal;

    boxLines([
      `  ✓ Ready — ${chats.length} chats`,
      `    ${groups.length} groups · ${personalChats().length} personal`,
      '',
    ], { title: 'Connected' });
    console.log('');

    // Batch-export many chats with one timeframe/media choice.
    async function runBatch(list, noun) {
      printBanner();
      menuHeader(`Batch export — every ${noun}`, 'one timeframe + media scope for all (q = back)');
      const tf = await inquirer.prompt([{
        type: 'list', name: 'timeframe',
        message: `Timeframe for ALL ${noun}s:`,
        pageSize: 10,
        choices: [
          group(' Quick '),
          { name: `Today       (${core.todayLocal()})`, value: 'today' },
          { name: `Yesterday   (${core.yesterdayLocal()})`, value: 'yesterday' },
          group(' Custom '),
          { name: 'Specific date', value: 'date' },
          { name: 'Date range  (from → to)', value: 'range' },
          group(' Full '),
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
          if (r.error) {
            throw new Error(r.error === 'symlink'
              ? 'output folder contains a symlink where export files belong — refusing to write'
              : String(r.error));
          }
          ok.push([name, r]);
          if (r.resumed === 'complete') console.log('  already exported — skipped');
        } catch (e) { bad.push([name, e.message]); }
      }
      const rows = [];
      ok.forEach(([n, r]) => rows.push(`  ✓ ${n}: ${r.saved} file(s), ${r.total} msgs`));
      bad.forEach(([n, why]) => rows.push(`  ✗ ${n}: ${why}`));
      if (!rows.length) rows.push('  (nothing to do)');
      rows.push('');
      boxLines(rows, { title: 'Batch summary' });
      console.log('');
    }

    while (true) {
      printBanner();
      menuHeader('Main menu', 'export one chat — or batch everything (q = back)');
      const { chatType } = await inquirer.prompt([{
        type: 'list', name: 'chatType',
        message: 'Scrape what?',
        // Tall enough to show every entry (incl. separators) without scrolling.
        pageSize: 14,
        choices: [
          group(' Single chat '),
          { name: '👥  Group', value: 'group' },
          { name: '👤  Personal chat', value: 'personal' },
          group(' Batch export '),
          { name: '⚡  ALL groups', value: 'group-all' },
          { name: '⚡  ALL personal chats', value: 'personal-all' },
          group(' Options '),
          { name: `${includeBroadcast ? '🔔' : '🔕'}  Include status/broadcast: ${includeBroadcast ? 'ON' : 'off'}`, value: 'toggle-broadcast' },
          group(''),
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
        menuHeader(`Pick a ${noun}`, `${baseList.length} ${noun}s available (q = back)`);
        let choices = buildChatChoices(baseList);

        // Optional type-to-filter search (#41): keeps huge lists usable.
        const { useSearch } = await inquirer.prompt([{
          type: 'list', name: 'useSearch',
          message: `How do you want to pick from ${baseList.length} ${noun}s?`,
          pageSize: 9,
          choices: [
            { name: '📜  Browse list', value: false },
            { name: '🔎  Search by name…', value: true },
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

        // NOTE: the picked chat is `theChat`, never `group` — a local named
        // `group` would shadow the group(' … ') separator helper used by the
        // timeframe list below (crash: "group is not a function").
        const theChat = baseList[chatIndex];
        const groupName = scrape.getDisplayName(theChat);

        // Timeframe
        while (true) {
          menuHeader(`Timeframe — ${groupName}`, 'what date range to export? (q = back)');
          const tf = await inquirer.prompt([{
            type: 'list', name: 'timeframe',
            message: 'Timeframe:',
            pageSize: 10,
            choices: [
              group(' Quick '),
              { name: `Today       (${core.todayLocal()})`, value: 'today' },
              { name: `Yesterday   (${core.yesterdayLocal()})`, value: 'yesterday' },
              group(' Custom '),
              { name: 'Specific date', value: 'date' },
              { name: 'Date range  (from → to)', value: 'range' },
              group(' Full '),
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

          const result = await confirmAndExport(inquirer, { group: theChat, groupName, startTs, endTs, label });
          if (result === 'back') continue;      // timeframe menu
          // done → pause then back to chat list
          await inquirer.prompt([{ type: 'input', name: '_', message: 'Press Enter to return to the chat list' }]);
          printBanner();
          break;
        }
      }
    }
  } catch (err) {
    // Last resort: an unexpected error reached the top of the flow. Show what
    // happened and glide back to the account menu instead of crashing the
    // process with a bare stack trace.
    try {
      const lines = String((err && err.message) || err).split('\n');
      console.log('');
      boxLines(['', ...lines.map(l => `  ${l}`), '',
        '  The menu will return to the account screen. You can retry there.',
        ''], { title: 'Unexpected error' });
      console.log('');
      await inquirer.prompt([{ type: 'input', name: '_', message: 'Press Enter to continue…' }]);
    } catch {}
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

  const choices = [];
  if (accounts.length) {
    // Align the size/last-used columns across every account row.
    const nameW = Math.max(...accounts.map(a => a.length), 6) + (current ? 12 : 0);
    choices.push(group(' Accounts · size · last used '));
    for (const acc of accounts) {
      const meta = core.readAccountMeta(acc);
      const size = core.humanSize(accountSize(acc));
      const last = core.relTime(meta.lastUsed) || 'never';
      const name = `${acc}${acc === current ? '  (current)' : ''}`;
      choices.push({
        name: `  ${name.padEnd(nameW)} ${size.padStart(7)} · ${last}`,
        value: `use:${acc}`,
      });
    }
    choices.push(group(' Manage '));
    choices.push({ name: '➕  Add new account', value: 'add' });
    choices.push({ name: '🗑️  Disconnect an account', value: 'disconnect' });
  } else {
    choices.push(group(' First run '));
    choices.push({ name: '➕  Add new account (scan QR)', value: 'add' });
  }
  choices.push(group(' Settings '));
  choices.push({ name: '📁  Change download folder', value: 'settings' });
  choices.push(group(''));
  choices.push({ name: '⛔  Exit', value: 'exit' });

  menuHeader('Accounts', 'pick an account to scrape with (q = nothing)');
  // Full path under the header — never truncated, as the config can live
  // anywhere and a shortened row would hide where files actually land.
  boxLines(['', `  ${baseDir}`, ''], { title: 'Download folder' });
  console.log('');
  const { action } = await inquirer.prompt([{
    type: 'list', name: 'action',
    message: 'Select account or action',
    choices, pageSize: 15,
  }]);
  return action;
}

async function addAccountFlow(inquirer) {
  menuHeader('Add account', 'a QR code will appear — scan it from WhatsApp (q = back)');
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

  menuHeader('Disconnect an account', 'removes the session files (q = back)');
  const { name } = await inquirer.prompt([{
    type: 'list', name: 'name',
    message: 'Which account?',
    pageSize: 12,
    choices: [
      ...accounts.map(a => ({ name: `🗑️  ${a}`, value: a })),
      new inquirer.Separator(),
      { name: '↩  Cancel', value: BACK_RESULT },
    ],
  }]);
  if (name === BACK_RESULT) return;

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

  if (!core.deleteAccount(name)) {
    console.log(`\n  ✗ Could not delete "${name}" (files in use or not removable).\n`);
    return;
  }
  if (core.getCurrentAccount() === name) core.clearCurrentAccount();
  boxLines([`  ✓ Account "${name}" disconnected (session files deleted).`, ''], { title: 'Disconnected' });
  console.log('');
}

async function settingsFlow(inquirer) {
  const cur = core.getBaseOutputDir();
  boxLines(['', `  Current download location:`, `    ${cur}`, ''], { title: 'Download location' });
  console.log('');
  const { newDir } = await inquirer.prompt([{
    type: 'input', name: 'newDir',
    message: 'New absolute path (q = back):',
    default: cur,
    validate: v => v === 'q' || !!v.trim() || 'Path cannot be empty',
  }]);
  if (newDir === 'q' || newDir === BACK_RESULT) return;

  const err = core.validateOutputDir(newDir);   // absolute + creatable + writable
  if (err) { console.log(`\n  ✗ ${err}\n`); return; }
  if (!core.setBaseOutputDir(path.resolve(newDir.trim()))) {
    console.log('\n  ✗ Could not save the new location (check permissions / disk space).\n');
    return;
  }
  boxLines([`  ✓ Download location set to:`, `    ${path.resolve(newDir.trim())}`, ''], { title: 'Saved' });
  console.log('');
}

async function main() {
  printBanner();
  const t0 = Date.now();
  console.log('  Loading prompts library…');
  // Dynamic import fills the CJS cache on a ~2× faster compile path than a
  // cold require(); the sync `require('inquirer')` inside patchInquirer()
  // then resolves from the warm cache in milliseconds.
  try {
    await import('inquirer');
  } catch (e) {
    // Missing/broken dependencies are the one thing the menu can't recover
    // from — exit with the fix instead of an opaque stack trace.
    console.log('');
    boxLines(['',
      '  Failed to load the prompts library.',
      `  ${String((e && e.message) || e).split('\n')[0]}`,
      '  Run: npm install',
      ''], { title: 'Setup problem' });
    console.log('');
    process.exit(1);
  }
  const inquirer = patchInquirer();
  console.log(`  ✓ Prompts ready in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

  while (true) {
    try {
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
    } catch (err) {
      // A broken flow must fall back to the account menu, never kill the
      // process. (Global uncaughtException is the very last resort.)
      try {
        const lines = String((err && err.message) || err).split('\n');
        console.log('');
        boxLines(['', ...lines.map(l => `  ${l}`),
          '  Returning to the account menu.', ''], { title: 'Error in menu flow' });
        console.log('');
        await inquirer.prompt([{ type: 'input', name: '_', message: 'Press Enter to continue…' }]);
      } catch {}
      printBanner();
    }
  }

  console.log('\n  ── Goodbye! 👋 ─────────────────────────────\n');
  exitWithCleanup(0);
}

if (require.main === module) {
  main().catch(e => { console.error(e); exitWithCleanup(1); });
}

module.exports = { patchInquirer, liveScrapeFlow, main };
