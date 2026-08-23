// Unit tests for the pure helpers (no WhatsApp/browser needed).
// Run: npm test   (node --test test/)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../lib/core');
const ie = require('../import-export');

// ── sanitizeName ────────────────────────────────────────────────────────
test('sanitizeName: keeps letters, digits and unicode words', () => {
  assert.strictEqual(core.sanitizeName('John Doe'), 'John_Doe');
  assert.strictEqual(core.sanitizeName('Family 👨‍👩‍👧 Group'), 'Family_👨‍👩‍👧_Group');
});

test('sanitizeName: defangs traversal (no separators survive)', () => {
  const out = core.sanitizeName('../../etc/passwd');
  assert.ok(!out.includes('/'), 'no slashes may survive');
  assert.strictEqual(out, '.._.._etc_passwd');   // harmless literal dots
});

test('sanitizeName: collapses runs, trims separator edges, caps length', () => {
  assert.strictEqual(core.sanitizeName('  a---b___c  '), 'a---b_c');
  assert.strictEqual(core.sanitizeName('_-_-lead'), 'lead');
  assert.ok(core.sanitizeName('x'.repeat(99)).length <= 50);
});

test('sanitizeName: emoji-only falls back to unknown', () => {
  // Emoji survive sanitization now — only *empty* results fall back.
  assert.strictEqual(core.sanitizeName('😀😀'), '😀😀');
  assert.strictEqual(core.sanitizeName('///'), 'unknown');
  assert.strictEqual(core.sanitizeName(''), 'unknown');
  assert.strictEqual(core.sanitizeName(null), 'unknown');
});

// ── dates ───────────────────────────────────────────────────────────────
test('isValidDate: accepts real dates, rejects rollover and junk', () => {
  assert.strictEqual(core.isValidDate('2026-06-13'), true);
  assert.strictEqual(core.isValidDate('2026-02-30'), false);   // would roll to Mar 2
  assert.strictEqual(core.isValidDate('2026-13-01'), false);
  assert.strictEqual(core.isValidDate('2026-6-13'), false);    // strict format
  assert.strictEqual(core.isValidDate('today'), false);
  assert.strictEqual(core.isValidDate('2000-02-29'), true);    // century leap year
  assert.strictEqual(core.isValidDate('1900-02-29'), false);   // 1900 was NOT a leap year
});

test('parseRange covers the full local day and matches the startTs/endTs convention', () => {
  const { startTs, endTs } = core.parseRange('2026-06-13');
  assert.strictEqual(endTs - startTs, 86399);
  // Regression: menu call sites destructure {startTs,endTs}; a {start,end}
  // return shape once made every menu date-filter silently export ALL time.
  const range = core.parseRange('2026-08-23');
  assert.ok(range.startTs > 0 && range.endTs > range.startTs);
  assert.strictEqual('start' in range, false);
});

// ── sessionSuffix uniqueness ────────────────────────────────────────────
test('sessionSuffix: unique across rapid calls', () => {
  const set = new Set(Array.from({ length: 2000 }, () => core.sessionSuffix()));
  assert.strictEqual(set.size, 2000);
});

// ── import-export: classify ─────────────────────────────────────────────
test('classify: media buckets + STK sticker rule', () => {
  assert.strictEqual(ie.classify('IMG-001.jpg'), 'images');
  assert.strictEqual(ie.classify('VID-002.mp4'), 'videos');
  assert.strictEqual(ie.classify('PTT-003.opus'), 'audio');
  assert.strictEqual(ie.classify('DOC-004.pdf'), 'documents');
  assert.strictEqual(ie.classify('STK-005.webp'), 'stickers');
  assert.strictEqual(ie.classify('photo.webp'), 'images');      // non-STK webp
  assert.strictEqual(ie.classify('weird.xyz'), 'other');        // unknown bucket
});

// ── import-export: parseDate ────────────────────────────────────────────
test('parseDate: DMY vs MDY vs 12h clock', () => {
  const dmy = ie.parseDate('25/12/2023', '14:05', 'DMY');
  assert.strictEqual(dmy.getMonth(), 11);
  assert.strictEqual(dmy.getDate(), 25);

  const mdy = ie.parseDate('12/25/2023', '14:05', 'MDY');
  assert.strictEqual(mdy.getMonth(), 11);
  assert.strictEqual(mdy.getDate(), 25);

  const pm = ie.parseDate('25/12/2023', '2:05 PM', 'DMY');
  assert.strictEqual(pm.getHours(), 14);
  const noon = ie.parseDate('25/12/2023', '12:30 AM', 'DMY');
  assert.strictEqual(noon.getHours(), 0);
});

test('parseDate: malformed time falls back to midnight (no throw)', () => {
  const d = ie.parseDate('25/12/2023', 'not-a-time', 'DMY');
  assert.strictEqual(d.getHours(), 0);
});

test('parseDate: invalid components return null instead of silently rolling', () => {
  assert.strictEqual(ie.parseDate('99/12/2023', '10:00', 'DMY'), null);  // day 99 → was Mar-2024 roll
  assert.strictEqual(ie.parseDate('25/13/2023', '10:00', 'DMY'), null);  // month 13
  assert.strictEqual(ie.parseDate('25/12', '10:00', 'DMY'), null);       // missing year
  assert.ok(ie.parseDate('25/12/23', '10:00', 'DMY') instanceof Date);   // 2-digit year ok
});

// ── import-export: header regex ─────────────────────────────────────────
const LINE_RE = ie.LINE_RE;
function mk(datePart) { return LINE_RE.exec(`${datePart} - Alice: hello`); }

test('LINE_RE matches Android style with LTR mark and en-dash', () => {
  const m = LINE_RE.exec('\u200E25/12/2023, 14:05 – Bob: hi there');
  assert.ok(m, 'should match');
  assert.strictEqual(m[3], 'Bob');
});

test('LINE_RE matches iOS bracketed style', () => {
  const m = LINE_RE.exec('[25/12/2023, 14:05:03] Carol: yo');
  assert.ok(m);
  assert.strictEqual(m[4], 'yo');
});

test('detectDateFormat sniffs DMY and MDY from day>12 evidence', () => {
  const lines = [
    '13/01/2024, 10:00 - A: x',   // 13 can only be a day ⇒ DMY
    '01/14/2024, 10:00 - A: y',   // 14 in second slot ⇒ MDY
  ];
  assert.strictEqual(ie.detectDateFormat([lines[0]]), 'DMY');
  assert.strictEqual(ie.detectDateFormat([lines[1]]), 'MDY');
  assert.strictEqual(ie.detectDateFormat(['garbage']), null);
});

// ── config precedence ───────────────────────────────────────────────────
test('getBaseOutputDir: OUTPUT_DIR env overrides saved config', t => {
  const prev = process.env.OUTPUT_DIR;
  process.env.OUTPUT_DIR = '/tmp/env-wins';
  t.after(() => { if (prev === undefined) delete process.env.OUTPUT_DIR; else process.env.OUTPUT_DIR = prev; });
  // Even if a saved config exists, env must win.
  assert.match(core.getBaseOutputDir(), /^\/tmp\/env-wins/);
});

// ── account meta / stats / chat cache (isolated auth root) ─────────────
test('account meta, dirSize and chat cache roundtrip in isolated root', t => {
  const os = require('node:os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wms-test-'));
  process.env.WA_AUTH_ROOT = tmp;
  t.after(() => { delete process.env.WA_AUTH_ROOT; fs.rmSync(tmp, { recursive: true, force: true }); });

  core.ensureAccountsDir();
  assert.deepStrictEqual(core.listAccounts(), []);

  fs.mkdirSync(core.getAccountPath('demo'), { recursive: true });
  fs.writeFileSync(path.join(core.getAccountPath('demo'), 'x.txt'), 'abcdef');
  assert.strictEqual(core.dirSize(core.getAccountPath('demo')), 6);
  core.updateAccountMeta('demo', { lastUsed: 1750000000000 });
  assert.strictEqual(core.readAccountMeta('demo').lastUsed, 1750000000000);
  assert.ok(core.dirSize(core.getAccountPath('demo')) >= 6);   // now includes meta
  assert.match(core.humanSize(6), /^6 B$/);
  assert.match(core.humanSize(2048), /^2 KB$/);
  assert.strictEqual(core.relTime(null), null);
  assert.ok(/\d+[smhd] ago/.test(core.relTime(Date.now() - 5000)));

  core.saveChatCache('demo', [
    { id: '123@c.us', name: 'Alice', isGroup: false },
    { id: '9-9@g.us', name: null, isGroup: true },
  ]);
  const cache = core.loadChatCache('demo');
  assert.strictEqual(cache.chats.length, 2);
  assert.strictEqual(cache.chats[0].name, 'Alice');
  assert.ok(cache.savedAt > 0);
});

// ── streaming import-export end-to-end on a temp file ──────────────────
test('importExport streams BOM+CRLF export with attachments and dry-run', async t => {
  const os = require('node:os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wms-imp-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  fs.writeFileSync(path.join(tmp, 'IMG-1.jpg'), 'jpegdata');
  fs.writeFileSync(path.join(tmp, 'chat.txt'),
    '\uFEFF\u200E25/12/2023, 14:05 - Alice: hi\r\n<attached: IMG-1.jpg>\r\n' +
    '[26/12/2023, 09:00] Bob: two\r\nlines\r\n');

  const out = path.join(tmp, 'out');
  const r = await ie.importExport(path.join(tmp, 'chat.txt'), out,
    { dateFormat: 'auto', mediaDir: tmp });
  assert.strictEqual(r.total, 2);
  assert.strictEqual(r.saved, 1);
  assert.strictEqual(r.missing, 0);

  const transcript = fs.readFileSync(path.join(out, 'conversation.txt'), 'utf8');
  assert.match(transcript, /images\/\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}_0_0\.jpg\] - "hi"/);
  assert.match(transcript, /Bob: two\\nlines/);   // newline escaped

  const dry = await ie.importExport(path.join(tmp, 'chat.txt'), path.join(tmp, 'dry'),
    { dateFormat: 'DMY', mediaDir: tmp, dryRun: true });
  assert.strictEqual(dry.dryRun, true);
  assert.strictEqual(fs.existsSync(path.join(tmp, 'dry')), false);
});

test('importExport: filter excludes missing files from the missing count (dry-run)', async t => {
  const os = require('node:os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wms-flt-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  // Video present; IMAGE missing entirely — under a video-only filter the
  // absent image is irrelevant (it was never going to be downloaded), so
  // "missing" must be 0. Unfiltered, that same absence must be reported.
  fs.writeFileSync(path.join(tmp, 'chat.txt'),
    '25/12/2023, 14:05 - A: x\n<attached: IMG-9.jpg>\n<attached: VID-1.mp4>\n');
  fs.writeFileSync(path.join(tmp, 'VID-1.mp4'), 'v');

  const dry = await ie.importExport(path.join(tmp, 'chat.txt'), path.join(tmp, 'o'),
    { mediaDir: tmp, dryRun: true, mediaTypes: ['video'] });
  assert.strictEqual(dry.missing, 0, 'filtered-out types must not count as missing');

  const dryAll = await ie.importExport(path.join(tmp, 'chat.txt'), path.join(tmp, 'o'),
    { mediaDir: tmp, dryRun: true });
  assert.strictEqual(dryAll.missing, 1, 'unfiltered run does report the missing image');
});
