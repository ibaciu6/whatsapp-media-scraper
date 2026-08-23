# whatsapp-media-scraper

Export a full WhatsApp conversation — groups and personal (1:1) chats — as a
chronological transcript plus every media attachment (images, videos,
audio/voice notes, documents, stickers), filtered by date, date range, or all
time. Multiple accounts are supported with instant switching; each session
persists so you only scan the QR code once per account.

## Requirements

- Node.js 18+ (see `engines` in package.json)
- Chromium (installed automatically by Puppeteer via `npm install`)
- A WhatsApp account with access to the target chat

## Setup

```bash
npm install
```

On first run a QR code appears in the terminal. Scan it with WhatsApp on your
phone: **Settings → Linked Devices → Link a Device**.

Sessions are stored per account under `.wwebjs_auth/accounts/<name>/`; the
active one is tracked in `.wwebjs_auth/current`. Connection attempts time out
after 5 minutes instead of hanging forever, and while connected an exclusive
lock prevents two processes from corrupting the same session.

---

## Usage

### Interactive menu (recommended)

```bash
./scrape.sh        # or: node menu.js
```

Flow: pick/add/switch/disconnect an account → choose group or personal chat →
(optionally **Search by name** — handy beyond a couple dozen chats) → pick the
chat → timeframe → media scope → confirm.

- **Media scope**: everything / transcript-only / pick specific types
  (images, video, audio, ptt, documents, stickers).
- **Preview message count** before committing to a big export.
- `q` goes back on lists; on text prompts type `q` + Enter.
- Disconnecting an account requires typing its name — no accidental deletes.
- Download location is configurable from ⚙ Settings (absolute path,
  validated writable).

### CLI

```bash
node index.js                                      # list chats (current account)
node index.js --list-accounts                      # saved accounts
node index.js --account work "Team"                # export using another account
node index.js "Name"                               # all time
node index.js "Name" today | yesterday             # quick day filters
node index.js "Name" 2026-06-13                    # single date
node index.js "Name" 2026-06-01 2026-06-30         # inclusive range
node index.js "Name" all "Backup2026"              # custom folder label
node index.js "Name" all --text-only               # transcript without media
node index.js "Name" all --media-types image,video # only these attachment types
node index.js --all-chats today --text-only        # batch: every chat, transcript
node index.js --include-broadcast "Name"           # include status/broadcast too
TZ=America/New_York node index.js "Name" 2026-06-13   # timezone via env
node index.js --timezone Europe/Berlin "Name"      # …or via flag
node index.js --output-dir /mnt/d/Downloads        # set download root (persists)
node index.js --show-output-dir                    # print current root
node index.js --disconnect old-account             # delete a session
node -v && node index.js --help
```

Batch mode (`--all-chats`) prints a per-chat summary; one failing chat never
stops the run. Interrupted exports RESUME: re-run the same command into the
same folder and the transcript continues where it stopped.

Name matching is case-insensitive; exact match wins, otherwise a unique
partial match is used — ambiguous partials list the candidates and (in a TTY)
prompt you to pick one. Known chat names are cached per account, so a typo
is rejected instantly without launching Chromium. Fast paths (`--help`,
`--version`, `--list-accounts`, `--disconnect`, `--show-output-dir`) also
never launch Chromium.

Unknown options are rejected with a hint instead of being silently treated as
a chat name.

---

## Importing a native WhatsApp export (full history, no sync limits)

Live scraping only reaches what the phone has synced to this linked device,
and CDN media expires after weeks. For complete history export the chat from
your phone (**Export chat → Include media**), unzip, then:

```bash
node import-export.js "/path/to/WhatsApp Chat with X.txt" [Folder] [options]

Options:
  --date-format=DMY|MDY|auto   auto (default) sniffs order from the dates
  --media-types <list>         comma list: image,video,audio,ptt,document,sticker
  --media-dir <path>           where media files live (default: beside .txt)
  --output-dir <path>          download-root override
  --text-only                  transcript without copying media
  --ignore-missing             hide per-file missing-media logs
  --dry-run                    report counts, write nothing
```

Handles UTF-8 BOM, Android *and* iOS line styles (dash optional), multi-line
messages, and several attachments inside one message. Unknown file types land
in an `other/` bucket rather than masquerading as documents.

Notes: on Android-style exports a sender name containing `:` may truncate at
the first colon (the plain-text format itself is ambiguous there; iOS exports
parse fine). Attachment filenames from the export file can never escape the
media folder (`..` / absolute paths are refused).

---

## Output

```
<download-root>/<ChatName>/<date>_<session>/
  conversation.txt  ← "[timestamp] Sender: body" or "[…] Sender: [subdir/file] - caption"
  images/ videos/ audio/ documents/ stickers/ other/
```

Media filenames carry a local-time stamp matching the transcript lines.
Newlines inside message bodies are escaped as literal `\n` so the transcript
stays one-line-per-message and machine-parseable. Live exports APPEND on
resume (see below); `import-export.js` rewrites its transcript wholesale on
each run.

Download root precedence: `OUTPUT_DIR` env var → saved config (menu Settings /
`--output-dir`) → project directory.

---

## Development

```bash
npm test        # unit tests for pure helpers (node:test, no browser needed)
```

Shared logic lives in `lib/core.js` (config/accounts/sanitize/fs helpers,
account locking) and `lib/scrape.js` (connect, chat list, history loading,
export pipeline); `menu.js`/`index.js` are thin entry points over them.

---

## Troubleshooting / FAQ

**QR scanned but nothing happens / "Timed out waiting for WhatsApp Web"**
The 5-minute window elapsed. Re-run and scan promptly; if it persists,
disconnect + re-add the account (menu) or `node index.js --disconnect <name>`.

**"Account X is in use by another process"**
A previous run still holds the `.lock` (or a live Chromium has the session).
Close it; locks are reclaimed automatically as soon as the owning process no
longer exists (or after 6 h at the latest).

**Session won't restore ("stale or corrupt session data")**
Delete the account's folder under `.wwebjs_auth/accounts/<name>/` (or use
Disconnect in the menu) and scan a fresh QR. Corrupt `config.json` is backed
up automatically as `.wwebjs_auth/config.json.corrupt-*`.

**Media downloads fail with `r: r` or expired-attachment errors**
WhatsApp CDN links expire after weeks — old media can only be recovered via
a native phone export (see import-export above). The July 2026 id-rename
(`_serialized` → `$1`) is already handled transparently.

**Export interrupted halfway**
Just re-run the same command into the same output folder: progress is flushed
to a `.export-meta.json` sidecar during the run, so the transcript continues
where it stopped and already-downloaded media is reused.

**Dates look wrong by hours**
Everything uses your system timezone. Override per run with
`--timezone <IANA zone>` or export `TZ=...`.

**Terminal left in a weird state after Ctrl+C**
`reset` restores it; the menu also cleans up raw-mode on normal exits.

**Known limitation:** very large chats (~50k+ messages) and huge videos can
exhaust memory — whatsapp-web.js loads messages/media into RAM. Use native
exports for those chats.

---

## Notes

- `.wwebjs_auth/` stores live session tokens — gitignored, never commit;
  permissions are tightened to owner-only on connect.
- Timestamps use the local system timezone throughout.
- History loading caps at ~50 000 messages per cycle and retries stalls with
  exponential backoff before giving up.
- Expired CDN attachments fail to download — use a native export to recover.
- WSL needs the `--no-sandbox` Puppeteer flag (already set).
- Windows works but with caveats: the stale-Chromium cleaner and the
  owner-only session permissions are Linux/macOS features (no-ops there).
- The July 2026 WhatsApp Web id rename (`_serialized` → `$1`) broke media
  downloads in whatsapp-web.js 1.34.x; the scraper backfills `_serialized`
  from `$1`, so both old and new builds keep working.
