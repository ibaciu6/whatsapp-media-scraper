#!/usr/bin/env node
// Parses a WhatsApp native chat export (Settings/Chat > Export chat > Include
// media) into this project's standard output layout: conversation.txt +
// images/videos/audio/documents/stickers subfolders.
//
// Unlike index.js/menu.js (limited to whatever WhatsApp Web has synced
// locally, and media still live on WhatsApp's CDN), this reads straight from
// a bundle exported by the phone itself, which holds the phone's full local
// history and media with no server retention window to worry about.
//
// CLI usage:
//   node import-export.js <chat-export.txt> [Folder] [options]
// Options:
//   --date-format=DMY|MDY|auto   auto (default) sniffs the first dates
//   --media-dir=<path>           where media files live (default: beside .txt)
//   --output-dir=<path>          download root override (default: config)
//   --text-only                  transcript only — don't copy media files
//   --ignore-missing             don't log each missing media file
//   --dry-run                    parse + report only, write nothing
//   -h, --help                   this help
//   -v, --version                version
const fs = require('fs');
const path = require('path');
const core = require('./lib/core');
const PKG = require('./package.json');

// ── Classification ──────────────────────────────────────────────────────
const EXT_SUBDIR = {
  '.jpg': 'images', '.jpeg': 'images', '.png': 'images', '.gif': 'images',
  '.webp': 'images',
  '.mp4': 'videos', '.3gp': 'videos', '.mov': 'videos', '.mkv': 'videos', '.webm': 'videos',
  '.opus': 'audio', '.mp3': 'audio', '.m4a': 'audio', '.aac': 'audio', '.amr': 'audio', '.wav': 'audio',
  '.pdf': 'documents', '.doc': 'documents', '.docx': 'documents', '.xls': 'documents',
  '.xlsx': 'documents', '.ppt': 'documents', '.pptx': 'documents', '.csv': 'documents',
};

function classify(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.webp') {
    // WhatsApp names sticker exports with an STK prefix; plain .webp photos don't have it.
    return /^STK-/i.test(path.basename(filename)) ? 'stickers' : 'images';
  }
  // Unknown types get their own bucket instead of polluting documents/.
  return EXT_SUBDIR[ext] || 'other';
}

// ── Parsing ─────────────────────────────────────────────────────────────
// Android: "12/25/23, 14:05 - Sender: Message" (dash may be a Unicode en-dash)
// iOS:     "[25/12/2023, 14:05:03] Sender: Message"
// The leading U+200E (LTR mark) that WhatsApp prepends on some exports is
// matched via an explicit escape — an invisible literal here once survived a
// re-encoding pass and silently broke parsing for everyone else.
const LTR_MARK = '\u200E';
const LINE_RE = new RegExp(
  '^' + LTR_MARK + '?\\[?(\\d{1,4}[./-]\\d{1,2}[./-]\\d{1,4}),?\\s+' +
  '(\\d{1,2}:\\d{2}(?::\\d{2})?(?:\\s?[AaPp][Mm])?)\\]?\\s*' +
  '(?:[-–—]\\s*)?' +          // dash optional — iOS exports omit it entirely
  '([^:]+?):\\s(.*)$');
const ATTACH_RE = /<attached:\s*([^>]+)>/gi;   // global: messages may carry several

function parseDate(dateStr, timeStr, fmt) {
  const parts = dateStr.split(/[./-]/).map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) return null;
  let day, month, year;
  if (fmt === 'MDY') { [month, day, year] = parts; } else { [day, month, year] = parts; }
  if (year < 100) year += 2000;
  // Validate components — without this, "99/12/2023" silently rolls into
  // March 2024 via Date's overflow arithmetic and poisons every timestamp.
  if (!(month >= 1 && month <= 12 && day >= 1 && day <= 31 && year >= 2000 && year <= 2099)) return null;

  const t = timeStr.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s?([AaPp][Mm])?/);
  if (!t) return new Date(year, month - 1, day);   // midnight fallback
  let h = Number(t[1]); const m = Number(t[2]); const s = Number(t[3] || 0);
  if (t[4]) {
    const pm = /p/i.test(t[4]);
    if (pm && h !== 12) h += 12;
    if (!pm && h === 12) h = 0;
  }
  return new Date(year, month - 1, day, h, m, s);
}

// Sniff DMY vs MDY from the first message dates: whichever component first
// exceeds 12 must be the day. Returns 'DMY' when nothing is conclusive.
function detectDateFormat(lines) {
  let checked = 0;
  for (const line of lines) {
    const m = line.match(LINE_RE);
    if (!m) continue;
    const [a, b] = m[1].split(/[./-]/).map(Number);
    if (a > 12) return 'DMY';
    if (b > 12) return 'MDY';
    if (++checked >= 50) break;
  }
  return null;   // inconclusive
}

// Stream-parse the export without loading the whole file into memory
// (exports can be hundreds of MB). Returns raw message records plus up to 50
// header lines sampled for date-order detection.
async function scanMessages(txtPath) {
  const readline = require('readline');
  const rl = readline.createInterface({
    input: fs.createReadStream(txtPath, 'utf8'),
    crlfDelay: Infinity,   // handle \r\n across chunk boundaries (and lone \r)
  });

  const messages = [];
  const samples = [];
  let current = null, n = 0;
  for await (const lineRaw of rl) {
    // Strip the UTF-8 BOM some editors/exporters add to byte 0 — it would
    // otherwise break the very first header match.
    const line = n++ === 0 ? lineRaw.replace(/^\uFEFF/, '') : lineRaw;
    const match = line.match(LINE_RE);
    if (match) {
      if (current) messages.push(current);
      const [, dateStr, timeStr, sender, body] = match;
      current = { dateStr, timeStr, sender: sender.trim(), body };
      if (samples.length < 50) samples.push(line);
    } else if (current && line.trim()) {
      current.body += '\n' + line;
    }
  }
  if (current) messages.push(current);
  return { messages, samples };
}

// Local-time file stamp — matches transcript timestamps (UTC stamps once made
// media filenames disagree with conversation.txt by hours).
function localFileStamp(date) {
  const p = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}` +
         `-${p(date.getHours())}-${p(date.getMinutes())}-${p(date.getSeconds())}`;
}
const oneline = s => String(s == null ? '' : s).replace(/\r?\n/g, '\\n');

// ── Import ──────────────────────────────────────────────────────────────
// opts: { dateFormat='auto', mediaDir?, outputDir?, textOnly, ignoreMissing,
//         dryRun, mediaTypes? }   mediaTypes = MEDIA_SUBDIR keys to keep
// Async: resolves once the transcript stream is fully flushed (returning
// before that used to let the process exit mid-write and truncate the file).
async function importExport(txtPath, outDir, opts = {}) {
  const {
    dateFormat = 'auto', mediaDir = path.dirname(txtPath),
    textOnly = false, ignoreMissing = false, dryRun = false, mediaTypes = null,
  } = opts;
  // Invert type→dir so a filter of e.g. [image] keeps only images/.
  const allowedDirs = mediaTypes
    ? new Set(mediaTypes.map(t => core.MEDIA_SUBDIR[t]).filter(Boolean))
    : null;

  const { messages, samples } = await scanMessages(txtPath);

  let fmt = dateFormat === 'auto' ? detectDateFormat(samples) : dateFormat.toUpperCase();
  if (dateFormat === 'auto') {
    if (fmt) console.log(`[INFO] Auto-detected date format: ${fmt}`);
    else { fmt = 'DMY'; console.log('[INFO] Date order ambiguous — assuming DMY. Pass --date-format=MDY if dates look wrong.'); }
  }
  for (const msg of messages) msg.date = parseDate(msg.dateStr, msg.timeStr, fmt);
  const badDates = messages.filter(m => !m.date).length;
  if (badDates) console.log(`[WARN] ${badDates} message(s) had unparseable dates and are marked "[invalid date]".`);

  console.log(`[INFO] Parsed ${messages.length} message(s) from export.`);
  if (mediaTypes) console.log(`[INFO] Media filter: ${mediaTypes.join(', ')}`);
  else if (textOnly) console.log('[INFO] Text-only mode — attachments will not be copied.');

  // Attachment paths come from the (untrusted) export file — refuse names that
  // could escape the media directory via traversal or absolute paths.
  const usableSrc = name => name && !name.includes('..') && !path.isAbsolute(name);

  // Pre-scan attachments so dry-run can report without touching disk writes.
  // Files excluded by text-only/filter don't count toward "missing": their
  // absence is irrelevant to what this run would actually download.
  const subdirOf = name => classify(name);
  let attachCount = 0, missingCount = 0, wouldCopy = 0, unsafeCount = 0;
  for (const msg of messages) {
    for (const m of msg.body.matchAll(ATTACH_RE)) {
      attachCount++;
      const srcName = m[1].trim();
      if (!usableSrc(srcName)) { unsafeCount++; continue; }
      if (textOnly || (allowedDirs && !allowedDirs.has(subdirOf(srcName)))) continue;
      if (!fs.existsSync(path.join(mediaDir, srcName))) { missingCount++; continue; }
      wouldCopy++;
    }
  }

  if (dryRun) {
    console.log('\n=== Dry run — nothing written ===');
    console.log(`Messages:         ${messages.length}`);
    console.log(`Attachments:      ${attachCount}`);
    console.log(`Would download:   ${wouldCopy}` +
      (mediaTypes ? ` (filter: ${mediaTypes.join(',')})` : '') +
      (textOnly ? ' (text-only)' : ''));
    console.log(`Media missing:    ${missingCount}`);
    if (unsafeCount) console.log(`Unsafe paths:     ${unsafeCount}`);
    console.log(`Would write to:   ${outDir}`);
    return { total: messages.length, saved: 0, missing: missingCount, dryRun: true };
  }

  const nothingParsed = !messages.length && fs.statSync(txtPath).size > 0;
  if (nothingParsed) {
    console.error('[ERR] No WhatsApp-style messages found in this file.');
    console.error('      Is it really a chat export (.txt)? Try --date-format=DMY or MDY.');
    process.exitCode = 1;
    return { total: 0, saved: 0, missing: 0 };
  }

  core.ensureDir(outDir);
  if (core.isSymlink(outDir) || core.isSymlink(path.join(outDir, 'conversation.txt'))) {
    console.error('[ERR] Output path contains a symlink where export files belong — refusing to write.');
    process.exitCode = 1;
    return { total: 0, saved: 0, missing: 0 };
  }
  const transcript = fs.createWriteStream(path.join(outDir, 'conversation.txt'), { flags: 'w' });
  const writeLine = l => transcript.write(l + '\n');

  let saved = 0, skippedExisting = 0, copiedBytes = 0, lastProgress = 0;

  messages.forEach((msg, i) => {
    if (i - lastProgress >= 500) {
      lastProgress = i;
      console.log(`  … ${i}/${messages.length} messages`);
    }
    const ts = msg.date ? msg.date.toLocaleString() : 'invalid date';
    const who = oneline(msg.sender);
    const attaches = [...msg.body.matchAll(ATTACH_RE)];
    const caption = oneline(msg.body.replace(ATTACH_RE, '').trim());

    if (!attaches.length) {
      writeLine(`[${ts}] ${who}: ${oneline(msg.body)}`);
      return;
    }

    const stampFor = k => msg.date ? `${localFileStamp(msg.date)}_${i}_${k}` : `undated_${i}_${k}`;
    const refs = [];
    attaches.forEach((m, k) => {
      const srcName = m[1].trim();
      if (!usableSrc(srcName)) {
        refs.push(`[${srcName} — refused (unsafe path)]`);
        return;
      }
      const srcPath = path.join(mediaDir, srcName);
      if (!fs.existsSync(srcPath)) {
        if (!ignoreMissing) console.log(`  [${i + 1}] missing: ${srcName}`);
        refs.push(`[${srcName} — missing from export]`);
        return;
      }
      if (textOnly) {
        refs.push(`[${srcName} — not downloaded (text-only mode)]`);
        return;
      }
      const subdir = classify(srcName);
      if (allowedDirs && !allowedDirs.has(subdir)) {
        refs.push(`[${srcName} — excluded by filter]`);
        return;
      }
      const dir = path.join(outDir, subdir);
      if (core.isSymlink(dir)) {
        console.error(`  [${i + 1}] refusing symlink at ${dir}`);
        refs.push(`[${srcName} — copy failed]`);
        return;
      }
      core.ensureDir(dir);
      const ext = path.extname(srcName);
      const destName = `${stampFor(k)}${ext}`;
      const destPath = path.join(dir, destName);
      if (fs.existsSync(destPath)) {
        skippedExisting++;
      } else {
        try {
          fs.copyFileSync(srcPath, destPath);
          saved++;
          copiedBytes += fs.statSync(destPath).size;
        } catch (e) {
          try { fs.unlinkSync(destPath); } catch {}
          if (!ignoreMissing) console.log(`  [${i + 1}] copy failed: ${srcName} (${e.message})`);
          refs.push(`[${srcName} — copy failed]`);
          return;
        }
      }
      refs.push(`[${subdir}/${destName}]`);
    });

    const refText = refs.join(' ') +
      (attaches.length > 1 ? ` (${attaches.length} attachments)` : '') +
      (caption ? ` - "${caption}"` : '');
    writeLine(`[${ts}] ${who}: ${refText}`);
  });

  await new Promise((resolve, reject) => {
    transcript.end(resolve);
    transcript.on('error', reject);
  });

  const mb = (copiedBytes / (1024 * 1024)).toFixed(1);
  console.log(`\n[DONE] ${saved} file(s) copied (${mb} MB)` +
    (skippedExisting ? `, ${skippedExisting} already existed` : '') +
    `, ${attachCount ? `${missingCount} missing` : 'no attachments'} · ` +
    `conversation.txt (${messages.length} messages) → ${outDir}`);

  return { total: messages.length, saved, missing: missingCount };
}

module.exports = { importExport, classify, parseDate, detectDateFormat, LINE_RE };

// ── CLI ─────────────────────────────────────────────────────────────────
if (require.main === module) {
  (async () => {
  const argv = process.argv.slice(2);
  const opts = { dateFormat: 'auto', mediaDir: null, outputDir: null, folder: null,
                 textOnly: false, ignoreMissing: false, dryRun: false, mediaTypes: null };
  let txtArg = null;

  const fail = m => { console.error(`[ERR] ${m}\n      Run "node import-export.js --help".`); process.exit(1); };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      console.log(`import-export.js v${PKG.version}

Usage: node import-export.js <chat-export.txt> [Folder] [options]

Options:
  --date-format=DMY|MDY|auto   date order ('auto' sniffs it; default)
  --media-types <list>         comma list: image,video,audio,ptt,document,sticker
  --media-dir <path>           where exported media lives (default: beside the .txt)
  --output-dir <path>          download root override (default: configured location)
  --text-only                  build transcript only; do not copy media
  --ignore-missing             suppress per-file "missing" logs
  --dry-run                    report what would happen; write nothing
  -v, --version                print version`);
      process.exit(0);
    }
    if (a === '-v' || a === '--version') { console.log(PKG.version); process.exit(0); }
    if (a === '--text-only') { opts.textOnly = true; continue; }
    if (a === '--ignore-missing') { opts.ignoreMissing = true; continue; }
    if (a === '--dry-run') { opts.dryRun = true; continue; }
    if (a === '--media-types') {
      const next = argv[i + 1];
      if (!next || next.startsWith('-')) fail('"--media-types" needs a value');
      const valid = new Set(Object.keys(core.MEDIA_SUBDIR));
      opts.mediaTypes = next.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
      const bad = opts.mediaTypes.filter(t => !valid.has(t));
      if (bad.length) fail(`Unknown media type(s): ${bad.join(', ')}. Valid: ${[...valid].join(', ')}`);
      i++; continue;
    }
    if (a.startsWith('--date-format=')) {
      const v = a.split('=')[1].toUpperCase();
      if (!['DMY', 'MDY', 'AUTO'].includes(v)) fail('Invalid date-format (use DMY|MDY|auto)');
      opts.dateFormat = v; continue;
    }
    if (a.startsWith('--media-dir=')) { opts.mediaDir = a.split('=').slice(1).join('='); continue; }
    if (a.startsWith('--output-dir=')) { opts.outputDir = a.split('=').slice(1).join('='); continue; }
    if (a === '--media-dir' || a === '--output-dir') {
      const next = argv[i + 1];
      if (!next || next.startsWith('-')) fail(`${a} needs a value`);
      if (a === '--media-dir') opts.mediaDir = next; else opts.outputDir = next;
      i++; continue;
    }
    if (a.startsWith('--')) fail(`Unknown option "${a}"`);
    if (!txtArg) txtArg = a;
    else if (!opts.folder) opts.folder = a;
  }

  if (!txtArg) {
    console.log(`import-export.js v${PKG.version} — run with --help for usage.`);
    process.exit(1);
  }

  const txtPath = path.resolve(txtArg);
  if (!fs.existsSync(txtPath)) { console.error(`[ERR] File not found: ${txtPath}`); process.exit(1); }

  if (opts.mediaDir && !fs.existsSync(path.resolve(opts.mediaDir)))
    fail(`--media-dir does not exist: ${opts.mediaDir}`);

  let baseOut = core.getBaseOutputDir();
  if (opts.outputDir) {
    const err = core.validateOutputDir(opts.outputDir);
    if (err) fail(`Bad --output-dir: ${err}`);
    baseOut = path.resolve(opts.outputDir);
  }

  const outDir = path.join(baseOut, core.sanitizeName(opts.folder || path.basename(txtPath).replace(/\.txt$/i, '')),
                            core.sessionSuffix());
  try {
    await importExport(txtPath, outDir, opts);
  } catch (e) {
    console.error(`[ERR] ${e.message}`);
    process.exit(1);
  }
  })().catch(e => { console.error(`[ERR] ${e && e.message ? e.message : e}`); process.exit(1); });
}
