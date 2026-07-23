// Parses a WhatsApp native chat export (Settings/Chat > Export chat > Include
// media) into this project's standard output layout: conversation.txt +
// images/videos/audio/documents/stickers subfolders.
//
// Unlike index.js/menu.js (limited to whatever WhatsApp Web has synced
// locally, and media still live on WhatsApp's CDN), this reads straight from
// a bundle exported by the phone itself, which holds the phone's full local
// history and media with no server retention window to worry about.
//
// CLI usage: node import-export.js <path-to-chat-export.txt> [OutputFolder] [--date-format=DMY|MDY]
const fs = require('fs');
const path = require('path');

function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }

const EXT_SUBDIR = {
  '.jpg': 'images', '.jpeg': 'images', '.png': 'images', '.gif': 'images',
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
  return EXT_SUBDIR[ext] || 'documents';
}

// Android: "12/25/23, 14:05 - Sender: Message" (dash may be a Unicode en-dash on some exports)
// iOS:     "[25/12/2023, 14:05:03] Sender: Message"
const LINE_RE = /^‎?\[?(\d{1,4}[./-]\d{1,2}[./-]\d{1,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AaPp][Mm])?)\]?\s*[-–]\s*([^:]+?):\s(.*)$/;
const ATTACH_RE = /<attached:\s*([^>]+)>/i;

function parseDate(dateStr, timeStr, fmt) {
  const parts = dateStr.split(/[./-]/).map(Number);
  let day, month, year;
  if (fmt === 'MDY') { [month, day, year] = parts; } else { [day, month, year] = parts; }
  if (year < 100) year += 2000;

  let [, h, m, s, ampm] = timeStr.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s?([AaPp][Mm])?/) || [];
  h = Number(h); m = Number(m); s = Number(s || 0);
  if (ampm) {
    const isPM = /p/i.test(ampm);
    if (isPM && h !== 12) h += 12;
    if (!isPM && h === 12) h = 0;
  }
  return new Date(year, month - 1, day, h, m, s);
}

// txtPath: path to the exported chat .txt (media files expected alongside it)
// outDir: destination folder for conversation.txt + media subfolders
// dateFormat: 'DMY' (default) or 'MDY', depending on the exporting phone's locale
function importExport(txtPath, outDir, dateFormat = 'DMY') {
  const mediaDir = path.dirname(txtPath);
  const raw = fs.readFileSync(txtPath, 'utf8').replace(/\r\n/g, '\n').split('\n');

  const messages = [];
  let current = null;

  for (const line of raw) {
    const match = line.match(LINE_RE);
    if (match) {
      if (current) messages.push(current);
      const [, dateStr, timeStr, sender, body] = match;
      current = { date: parseDate(dateStr, timeStr, dateFormat), sender: sender.trim(), body };
    } else if (current && line.trim()) {
      current.body += '\n' + line;
    }
  }
  if (current) messages.push(current);

  console.log(`[INFO] Parsed ${messages.length} message(s) from export.`);
  ensureDir(outDir);

  const transcriptLines = [];
  let saved = 0, missing = 0;

  messages.forEach((msg, i) => {
    const ts = msg.date.toLocaleString();
    const attach = msg.body.match(ATTACH_RE);

    if (attach) {
      const srcName = attach[1].trim();
      const srcPath = path.join(mediaDir, srcName);
      if (!fs.existsSync(srcPath)) {
        console.log(`  [${i + 1}/${messages.length}] missing file: ${srcName}`);
        transcriptLines.push(`[${ts}] ${msg.sender}: [attachment missing from export: ${srcName}]`);
        missing++;
        return;
      }
      const subdir = classify(srcName);
      const dir = path.join(outDir, subdir);
      ensureDir(dir);
      const fileTs = msg.date.toISOString().replace(/[:.]/g, '-');
      const ext = path.extname(srcName);
      const destName = `${fileTs}_${i}${ext}`;
      fs.copyFileSync(srcPath, path.join(dir, destName));
      console.log(`  [${i + 1}/${messages.length}] ${destName}`);
      saved++;
      const caption = msg.body.replace(ATTACH_RE, '').trim();
      transcriptLines.push(`[${ts}] ${msg.sender}: [${subdir}/${destName}]${caption ? ' - "' + caption + '"' : ''}`);
    } else {
      transcriptLines.push(`[${ts}] ${msg.sender}: ${msg.body}`);
    }
  });

  fs.writeFileSync(path.join(outDir, 'conversation.txt'), transcriptLines.join('\n') + '\n');
  console.log(`\n[DONE] ${saved} file(s) saved, ${missing} missing, conversation.txt (${messages.length} messages) saved to ${outDir}`);

  return { total: messages.length, saved, missing };
}

module.exports = { importExport };

if (require.main === module) {
  const txtArg    = process.argv[2];
  const folderArg = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : null;
  const dateFmtArg = (process.argv.find(a => a.startsWith('--date-format=')) || '').split('=')[1] || 'DMY';

  if (!txtArg) {
    console.log('Usage: node import-export.js <path-to-chat-export.txt> [OutputFolder] [--date-format=DMY|MDY]');
    process.exit(1);
  }

  const txtPath = path.resolve(txtArg);
  if (!fs.existsSync(txtPath)) {
    console.error(`[ERR] File not found: ${txtPath}`);
    process.exit(1);
  }

  const outDir = path.join(__dirname, folderArg || path.basename(txtPath, '.txt').replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40));
  importExport(txtPath, outDir, dateFmtArg);
}
