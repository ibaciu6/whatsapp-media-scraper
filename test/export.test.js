// Tests for lib/core locking and the scrape.exportChat pipeline (no browser:
// exportChat only needs chat.fetchMessages/id + downloadMedia fakes).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const core = require('../lib/core');
const scrape = require('../lib/scrape');

function withAuthRoot(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wms-lock-'));
  process.env.WA_AUTH_ROOT = tmp;
  t.after(() => { delete process.env.WA_AUTH_ROOT; fs.rmSync(tmp, { recursive: true, force: true }); });
  return tmp;
}

// ── Account locking (regressions: fresh-account ENOENT + dead stale takeover)
test('lock: acquiring on a brand-new account creates dir and succeeds', t => {
  withAuthRoot(t);
  const l = core.acquireAccountLock('brand-new');
  assert.ok(l, 'lock must be acquired');
  assert.ok(fs.existsSync(core.getAccountPath('brand-new')), 'account dir created');
  core.releaseAccountLock(l);
});

test('lock: mutual exclusion + release/reacquire', t => {
  withAuthRoot(t);
  const l1 = core.acquireAccountLock('acc');
  assert.ok(l1);
  assert.strictEqual(core.acquireAccountLock('acc'), null, 'second must block');
  core.releaseAccountLock(l1);
  assert.ok(core.acquireAccountLock('acc'), 'reacquire after release');
});

test('lock: fresh lock blocks, >6h lock is stolen', t => {
  const root = withAuthRoot(t);
  fs.mkdirSync(core.getAccountPath('stale'), { recursive: true });
  const lf = path.join(core.getAccountPath('stale'), '.lock');
  fs.writeFileSync(lf, '999999');
  fs.utimesSync(lf, Date.now() / 1000 - 7 * 3600, Date.now() / 1000 - 7 * 3600);
  assert.ok(core.acquireAccountLock('stale'), 'stale lock taken over');
  core.releaseAccountLock(core.getAccountPath('stale') + '/.lock');

  fs.writeFileSync(lf, String(process.pid));   // alive owner, fresh age
  assert.strictEqual(core.acquireAccountLock('stale'), null, 'live fresh lock blocks');
  fs.unlinkSync(lf);
});

test('lock: dead-owner pid reclaims instantly; live pid blocks', t => {
  withAuthRoot(t);
  const dir = core.getAccountPath('pid');
  fs.mkdirSync(dir, { recursive: true });
  const lf = path.join(dir, '.lock');
  fs.writeFileSync(lf, '999999');              // almost certainly nonexistent pid
  assert.ok(core.acquireAccountLock('pid'), 'dead-owner lock reclaimed without 6h wait');
  core.releaseAccountLock(lf);
  fs.writeFileSync(lf, String(process.pid));   // this test process is alive
  assert.strictEqual(core.acquireAccountLock('pid'), null, 'alive-owner lock blocks');
});

test('lock: no empty-file window — lock contains pid immediately', t => {
  withAuthRoot(t);
  const lf = core.acquireAccountLock('content');
  assert.strictEqual(fs.readFileSync(lf, 'utf8'), String(process.pid));
  core.releaseAccountLock(lf);
});

// ── exportChat pipeline ─────────────────────────────────────────────────
function mkChat(n, opts = {}) {
  const msgs = Array.from({ length: n }, (_, i) => ({
    timestamp: 1700000000 + i * 60,
    body: `body ${i}`,
    hasMedia: !!opts.mediaAt?.includes(i),
    fromMe: true,
    type: opts.mediaAt?.includes(i) ? 'image' : 'chat',
    id: { _serialized: `msg${i}@c.us` },
    ...(opts.mediaAt?.includes(i) ? {
      downloadMedia: async () => {
        if (opts.failDownloadAt === i) throw new Error('boom');
        return { data: Buffer.from(`M${i}`).toString('base64'), mimetype: 'image/jpeg', filename: `p${i}.jpg` };
      },
    } : {}),
  }));
  return {
    id: { _serialized: 'chat@c.us' },
    fetchMessages: async ({ limit }) => msgs.slice(0, Math.min(limit, n)),
    __msgs: msgs,
  };
}

const readLines = d => fs.readFileSync(path.join(d, 'conversation.txt'), 'utf8').trim().split('\n');
const readMeta = d => JSON.parse(fs.readFileSync(path.join(d, '.export-meta.json'), 'utf8'));

test('exportChat: fresh run → transcript + completed meta', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wms-x-'));
  const out = path.join(tmp, 's');
  const r = await scrape.exportChat(mkChat(5), { outDir: out });
  assert.strictEqual(r.resumed, false);
  assert.strictEqual(readLines(out).length, 5);
  const meta = readMeta(out);
  assert.strictEqual(meta.completed, true);
  assert.strictEqual(meta.lastId, 'msg4@c.us');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('exportChat: re-run after completion short-circuits', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wms-x-'));
  const out = path.join(tmp, 's');
  await scrape.exportChat(mkChat(3), { outDir: out });
  const r = await scrape.exportChat(mkChat(3), { outDir: out });
  assert.strictEqual(r.resumed, 'complete');
  assert.strictEqual(readLines(out).length, 3, 'transcript untouched');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('exportChat: crash-mid-run resume appends by message-id anchor', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wms-x-'));
  const out = path.join(tmp, 's');
  // Simulate a crash after 2 messages (as the periodic flush would leave it).
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'conversation.txt'),
    '[a] Me: body 0\n[b] Me: body 1\n');
  fs.writeFileSync(path.join(out, '.export-meta.json'), JSON.stringify({
    chat: 'chat@c.us', startTs: null, endTs: null,
    lastIndex: 1, lastId: 'msg1@c.us', completed: false,
  }));
  const r = await scrape.exportChat(mkChat(5), { outDir: out });
  assert.strictEqual(r.resumed, 'resumed');
  const lines = readLines(out);
  assert.strictEqual(lines.length, 5, 'appended, not truncated');
  assert.match(lines[0], /body 0/);
  assert.match(lines[4], /body 4/);
  assert.strictEqual(readMeta(out).completed, true);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('exportChat: index anchoring survives history PREPEND between runs', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wms-x-'));
  const out = path.join(tmp, 's');
  // First session crashed after processing msg2 of a 6-msg window.
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'conversation.txt'), 'x\nx\nx\n');
  fs.writeFileSync(path.join(out, '.export-meta.json'), JSON.stringify({
    chat: 'chat@c.us', startTs: null, endTs: null,
    lastIndex: 2, lastId: 'msg2@c.us', completed: false,
  }));
  // Meanwhile THREE older messages were synced — a bare-index resume would
  // now skip/duplicate; the id anchor must realign.
  const chat = mkChat(9);
  const shifted = chat.__msgs.map((m, i) => ({ ...m }));   // same ids
  chat.fetchMessages = async ({ limit }) => shifted.slice(0, Math.min(limit, 9))
    .map((m, i) => ({ ...m, timestamp: m.timestamp, body: `body ${i - 0}` }));
  // Renumber bodies so positions moved but ids kept: prepend 3 older ids.
  const prepended = ['old0', 'old1', 'old2'].map((pfx, i) => ({
    timestamp: 1700000000 - (3 - i) * 60,
    body: `${pfx} ${i}`, hasMedia: false, fromMe: true, type: 'chat',
    id: { _serialized: `${pfx}@c.us` },
  })).concat(shifted);
  chat.fetchMessages = async ({ limit }) => prepended.slice(0, Math.min(limit, prepended.length));

  const r = await scrape.exportChat(chat, { outDir: out });
  assert.strictEqual(r.resumed, 'resumed');
  const lines = readLines(out);
  assert.strictEqual(lines.length, 9, '3 head + remaining 6 appended exactly once');
  assert.doesNotMatch(lines[3], /body 2/, 'no duplication at the seam');
  assert.match(lines[3], /body 3/);
  assert.match(lines[8], /body 8/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('exportChat: unfindable lastId falls back to stored offset, then completes', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wms-x-'));
  const out = path.join(tmp, 's');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'conversation.txt'), 'h0\nh1\n');
  fs.writeFileSync(path.join(out, '.export-meta.json'), JSON.stringify({
    chat: 'chat@c.us', startTs: null, endTs: null,
    lastIndex: 1, lastId: 'GONE@c.us', completed: false,
  }));
  const r = await scrape.exportChat(mkChat(4), { outDir: out });
  assert.strictEqual(r.resumed, 'resumed');
  const lines = readLines(out);
  assert.strictEqual(lines.length, 2 + 2, 'offset fallback skipped msgs 0-1');
  assert.match(lines[2], /body 2/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('exportChat: media write refuses symlinked subdir, keeps going', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wms-x-'));
  const victim = path.join(tmp, 'victim'); fs.mkdirSync(victim);
  const out = path.join(tmp, 's'); fs.mkdirSync(out);
  fs.symlinkSync(victim, path.join(out, 'images'));
  await scrape.exportChat(mkChat(1, { mediaAt: [0] }), { outDir: out });
  assert.strictEqual(fs.readdirSync(victim).length, 0, 'nothing written through symlink');
  const lines = readLines(out);
  assert.match(lines[0], /download failed/, 'failure recorded in transcript');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('exportChat: existing media file counted as existed (O_EXCL path)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wms-x-'));
  const out = path.join(tmp, 's');
  await scrape.exportChat(mkChat(1, { mediaAt: [0] }), { outDir: out });
  const r = await scrape.exportChat(
    { id: { _serialized: 'chat@c.us' }, fetchMessages: async () => [] },   // n/a
    { outDir: out });
  assert.strictEqual(r.resumed, 'complete');
  // Direct second pass over a fresh dir pre-seeded with the media file:
  const out2 = path.join(tmp, 's2');
  fs.mkdirSync(path.join(out2, 'images'), { recursive: true });
  const stamp = new Date(1700000000 * 1000);
  const p = n => String(n).padStart(2, '0');
  const name = `${stamp.getFullYear()}-${p(stamp.getMonth() + 1)}-${p(stamp.getDate())}` +
    `-${p(stamp.getHours())}-${p(stamp.getMinutes())}-${p(stamp.getSeconds())}_0.jpg`;
  fs.writeFileSync(path.join(out2, 'images', name), 'old');
  const r2 = await scrape.exportChat(mkChat(1, { mediaAt: [0] }), { outDir: out2 });
  assert.strictEqual(r2.skippedExisting, 1, 'existing file reused');
  assert.strictEqual(fs.readFileSync(path.join(out2, 'images', name), 'utf8'), 'old', 'not overwritten');
  fs.rmSync(tmp, { recursive: true, force: true });
});
