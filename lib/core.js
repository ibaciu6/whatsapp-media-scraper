// Shared core utilities for all entry points (index.js / menu.js / import-export.js).
// Single source of truth for config, accounts, sanitization and small helpers.
const fs = require('fs');
const path = require('path');

// Auth paths resolve LAZILY so WA_AUTH_ROOT (test isolation) can be set any
// time before the first call — a require-time const would freeze the value.
function authRoot() {
  return process.env.WA_AUTH_ROOT || path.join(__dirname, '..', '.wwebjs_auth');
}
function accountsDir() { return path.join(authRoot(), 'accounts'); }
function configFile() { return path.join(authRoot(), 'config.json'); }
function currentFile() { return path.join(authRoot(), 'current'); }

// ── Config ──────────────────────────────────────────────────────────────
function ensureAccountsDir() {
  if (!fs.existsSync(accountsDir())) fs.mkdirSync(accountsDir(), { recursive: true });
}

function loadConfig() {
  const cf = configFile();
  if (fs.existsSync(cf)) {
    try {
      return JSON.parse(fs.readFileSync(cf, 'utf8'));
    } catch (e) {
      // Corrupt config: keep a backup so the user can inspect what was lost.
      try {
        fs.copyFileSync(cf, cf + '.corrupt-' + Date.now());
        console.error('[WARN] config.json was corrupt — backed up and starting fresh.');
      } catch {}
    }
  }
  return {};
}

function saveConfig(config) {
  ensureAccountsDir();
  fs.writeFileSync(configFile(), JSON.stringify(config, null, 2));
  try { fs.chmodSync(configFile(), 0o600); } catch {}
}

// Precedence: OUTPUT_DIR env var overrides saved config (12-factor style),
// then saved config, then the project directory.
function getBaseOutputDir() {
  return process.env.OUTPUT_DIR || loadConfig().baseOutputDir || path.join(__dirname, '..');
}

function setBaseOutputDir(dir) {
  const config = loadConfig();
  config.baseOutputDir = dir;
  saveConfig(config);
}

// Validate an output root: must be absolute, no traversal tricks, creatable/writable.
function validateOutputDir(dir) {
  if (typeof dir !== 'string' || !dir.trim()) return 'Path cannot be empty';
  const resolved = path.resolve(dir.trim());
  if (!path.isAbsolute(resolved)) return 'Path must be absolute';
  try {
    fs.mkdirSync(resolved, { recursive: true });
    fs.accessSync(resolved, fs.constants.W_OK);
  } catch (e) {
    return 'Cannot create/write path: ' + e.message;
  }
  return null;
}

// ── Accounts ────────────────────────────────────────────────────────────
function listAccounts() {
  ensureAccountsDir();
  return fs.readdirSync(accountsDir(), { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort();
}

function getAccountPath(name) {
  return path.join(accountsDir(), name);
}

function accountExists(name) {
  return fs.existsSync(getAccountPath(name));
}

function deleteAccount(name) {
  const accountPath = getAccountPath(name);
  if (fs.existsSync(accountPath)) {
    fs.rmSync(accountPath, { recursive: true, force: true });
    return true;
  }
  return false;
}



function getCurrentAccount() {
  if (fs.existsSync(currentFile())) {
    try {
      return fs.readFileSync(currentFile(), 'utf8').trim() || null;
    } catch {}
  }
  return null;
}

function setCurrentAccount(name) {
  ensureAccountsDir();
  fs.writeFileSync(currentFile(), name);
}

function clearCurrentAccount() {
  if (fs.existsSync(currentFile())) fs.unlinkSync(currentFile());
}

// Per-account exclusive lock so two processes can't drive one session at
// once (concurrent Chromium instances corrupt the shared IndexedDB).
function acquireAccountLock(name) {
  ensureAccountsDir();
  const dir = getAccountPath(name);
  // The account directory may not exist yet (brand-new account) — the lock
  // lives inside it, so create it first or openSync('wx') fails with ENOENT.
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  const lockFile = path.join(dir, '.lock');
  try {
    if (fs.existsSync(lockFile)) {
      const age = Date.now() - fs.statSync(lockFile).mtimeMs;
      // The lock records its owner's pid: if that process is gone the lock
      // is reclaimable immediately (crash/SIGKILL), no 6h wait needed.
      let ownerAlive = null;   // unknown when pid unparsable
      try {
        const pid = parseInt(fs.readFileSync(lockFile, 'utf8'), 10);
        if (pid) {
          ownerAlive = (() => {
            try { process.kill(pid, 0); return true; }
            catch (e) { return e.code === 'EPERM'; }   // exists, other user
          })();
        }
      } catch {}
      const stale = age >= 6 * 60 * 60 * 1000 || ownerAlive === false;
      if (!stale) return null;
      console.error('[WARN] Stale account lock found (' +
        (ownerAlive === false ? 'owner process is gone' : 'older than 6h') +
        ') — taking over.');
      try { fs.unlinkSync(lockFile); } catch {}
    }
    // Single atomic create-with-content: no window where an empty lock file
    // blocks others, and O_EXCL resolves take-over races between processes.
    fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx' });
    return lockFile;
  } catch {
    return null;
  }
}

function releaseAccountLock(lockFile) {
  if (!lockFile) return;
  try { fs.unlinkSync(lockFile); } catch {}
}

// ── Account metadata (stats shown in the account menu) ─────────────────
function accountMetaPath(name) { return path.join(getAccountPath(name), '.meta.json'); }

function readAccountMeta(name) {
  try { return JSON.parse(fs.readFileSync(accountMetaPath(name), 'utf8')); }
  catch { return {}; }
}

// Merge-patch the meta file (lastUsed, label, …).
function updateAccountMeta(name, patch) {
  ensureAccountsDir();
  const meta = Object.assign(readAccountMeta(name), patch);
  fs.writeFileSync(accountMetaPath(name), JSON.stringify(meta, null, 2));
  try { fs.chmodSync(accountMetaPath(name), 0o600); } catch {}
  return meta;
}

function dirSize(dir) {
  let total = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      total += e.isDirectory() ? dirSize(p) : (e.isFile() ? (fs.statSync(p).size || 0) : 0);
    }
  } catch {}
  return total;
}

function humanSize(bytes) {
  if (!bytes || bytes < 1024) return `${bytes || 0} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

// "3m ago" / "2h ago" / "5d ago" style relative time.
function relTime(ts) {
  if (!ts) return null;
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// ── Chat cache (fast-fail CLI name checks without connecting) ──────────
function chatCachePath(name) { return path.join(getAccountPath(name), '.chatcache.json'); }

function saveChatCache(accountName, chats) {
  try {
    ensureAccountsDir();
    const slim = chats.map(c => ({
      id: (c.id && (c.id._serialized || c.id.$1)) || '',
      name: c.name || null,
      isGroup: !!c.isGroup,
    }));
    fs.writeFileSync(chatCachePath(accountName),
      JSON.stringify({ savedAt: Date.now(), chats: slim }, null, 2));
    try { fs.chmodSync(chatCachePath(accountName), 0o600); } catch {}
  } catch {}
}

function loadChatCache(accountName) {
  try {
    const data = JSON.parse(fs.readFileSync(chatCachePath(accountName), 'utf8'));
    return Array.isArray(data.chats) ? data : null;
  } catch { return null; }
}

// ── Names & filesystem helpers ──────────────────────────────────────────
function sanitizeName(name) {
  if (!name) return 'unknown';
  const safe = name
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')   // filesystem-unsafe chars only
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '')            // clean separator edges too
    .slice(0, 50);
  return safe || 'unknown';
}

function ensureDir(p) {
  try {
    fs.mkdirSync(p, { recursive: true });
    return true;
  } catch (e) {
    console.error(`[ERR] Could not create output directory "${p}": ${e.message}`);
    console.error('      Check disk space and folder permissions, then retry.');
    return false;
  }
}

// True when p exists as a symlink. Used to refuse writing through planted
// symlinks (e.g. a pre-made <outDir>/images pointing somewhere else).
function isSymlink(p) {
  try { return fs.lstatSync(p).isSymbolicLink(); }
  catch { return false; }   // missing → fine
}

// Session material contains live auth tokens — restrict to owner only.
function hardenSessionPerms(dir) {
  try {
    fs.chmodSync(dir, 0o700);
  } catch {}
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) hardenSessionPerms(full);
      else try { fs.chmodSync(full, 0o600); } catch {}
    }
  } catch {}
}

// ── Dates (local timezone throughout) ───────────────────────────────────
function fmtLocal(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function todayLocal() { return fmtLocal(new Date()); }
function yesterdayLocal() {
  const d = new Date(); d.setDate(d.getDate() - 1);
  return fmtLocal(d);
}
// Returns { startTs, endTs } in epoch seconds — key names match the
// startTs/endTs convention used by every export call site (a previous
// {start,end} shape was silently destructured into undefined timestamps,
// making "Today" exports process the entire chat).
function parseRange(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const e = new Date(dateStr + 'T23:59:59');
  return { startTs: Math.floor(d.getTime() / 1000), endTs: Math.floor(e.getTime() / 1000) };
}
function isValidDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00');
  return !isNaN(d) && fmtLocal(d) === s;   // rejects e.g. 2026-02-31 rollover
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Retry an async fn with linear backoff. opts: { attempts=3, delayMs=1000,
// isRetryable(e), onRetry(e, attempt, waitMs) }. Rethrows the last error
// when it isn't retryable or attempts are exhausted.
async function retry(fn, opts = {}) {
  const { attempts = 3, delayMs = 1000,
          isRetryable = () => true, onRetry = null } = opts;
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt >= attempts || !isRetryable(e)) throw e;
      const wait = delayMs * attempt;
      if (onRetry) onRetry(e, attempt, wait);
      await sleep(wait);
    }
  }
  throw lastErr;
}

// Unique session suffix: timestamp base36 + per-process sequence + random
// base36. The sequence counter makes rapid in-process calls collision-free
// (pure randomness needed ~2000 draws before a birthday hit), while the
// timestamp + random tail keep cross-process collisions negligible.
let __suffixSeq = 0;
function sessionSuffix(len = 6) {
  const ts = Date.now().toString(36).slice(-len);
  const seq = (__suffixSeq++).toString(36);
  const rand = Math.floor(Math.random() * 36 ** 4).toString(36).padStart(4, '0');
  return `${ts}${seq}${rand}`;
}

// ── Media classification ────────────────────────────────────────────────
const MIME_TO_EXT = {
  'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png',
  'image/gif': '.gif', 'image/webp': '.webp', 'video/mp4': '.mp4',
  'video/3gpp': '.3gp', 'video/quicktime': '.mov',
  'video/x-matroska': '.mkv', 'video/webm': '.webm',
  'audio/ogg': '.ogg', 'audio/opus': '.opus', 'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a', 'audio/aac': '.aac', 'audio/amr': '.amr',
  'application/pdf': '.pdf',
};
function extFromMime(m) {
  if (!m) return '.bin';
  const b = m.split(';')[0].trim().toLowerCase();
  return MIME_TO_EXT[b] || '.' + (b.split('/')[1] || 'bin');
}

const MEDIA_SUBDIR = {
  image: 'images', video: 'videos',
  audio: 'audio', ptt: 'audio',
  document: 'documents', sticker: 'stickers',
};

// Lazy path exports: getters so WA_AUTH_ROOT set AFTER require still works
// (tests rely on this for isolation).
module.exports = {
  get AUTH_ROOT() { return authRoot(); },
  get ACCOUNTS_DIR() { return accountsDir(); },
  get CONFIG_FILE() { return configFile(); },
  authRoot, accountsDir, configFile, currentFile,
  ensureAccountsDir,
  loadConfig, saveConfig, getBaseOutputDir, setBaseOutputDir, validateOutputDir,
  listAccounts, getAccountPath, accountExists, deleteAccount,
  getCurrentAccount, setCurrentAccount, clearCurrentAccount,
  acquireAccountLock, releaseAccountLock, hardenSessionPerms,
  readAccountMeta, updateAccountMeta, dirSize, humanSize, relTime,
  saveChatCache, loadChatCache,
  sanitizeName, ensureDir, isSymlink, sleep, retry, sessionSuffix,
  todayLocal, yesterdayLocal, parseRange, isValidDate,
  MIME_TO_EXT, extFromMime, MEDIA_SUBDIR,
};
