# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the scraper

```bash
# Interactive menu (recommended)
node menu.js

# CLI mode (node index.js --help for the full set)
node index.js                                          # list chats for current account
node index.js "Name"                                   # export all time
node index.js "Name" today | yesterday | 2026-06-13    # quick date filters
node index.js "Name" 2026-06-01 2026-06-30             # inclusive range
node index.js "Name" all --text-only                   # transcript only
node index.js "Name" all --media-types image,video     # filter attachment types
node index.js --all-chats today                        # batch: every chat
node index.js --include-broadcast "Name"               # include status channels
node index.js --timezone Europe/Berlin "Name"          # override date timezone

# Multi-account CLI
node index.js --account "accountName" "Name"           # export with a specific account
node index.js --list-accounts                          # list saved accounts
node index.js --disconnect "accountName"               # delete an account's session
node index.js --output-dir "/abs/path"                 # set download root (persists)
```

In the interactive menu (`node menu.js`): account add/switch/disconnect at
startup, chat **search**, media-scope picker (all / text-only / per-type),
optional message-count preview before export, `q` = back everywhere.
Accounts live in `.wwebjs_auth/accounts/<name>/` (`.wwebjs_auth/current`
tracks the active one). An exclusive per-account lock prevents two
concurrent processes on one session; connections time out after 5 min.

### Importing a native WhatsApp export

```bash
node import-export.js "/path/to/WhatsApp Chat with X.txt" [Folder] \
  [--date-format=DMY|MDY|auto] [--media-types=image,video] [--media-dir=path] \
  [--output-dir=path] [--text-only] [--ignore-missing] [--dry-run]
```

`auto` (default) sniffs DMY vs MDY from day>12 evidence. Handles BOM, iOS
bracketed lines without dash, multi-line bodies, and multiple attachments
per message. Unknown extensions go to `other/`.

## Architecture

Thin entry points over shared modules:

**`lib/core.js`** — config (`config.json`; precedence: `OUTPUT_DIR` env →
saved config → project dir), account CRUD + per-account `.lock`,
`sanitizeName`, path validation (`validateOutputDir`), session permission
hardening, date helpers, MIME/media-type maps, collision-safe
`sessionSuffix()`.

**`lib/scrape.js`** — WhatsApp-coupled pipeline: `connectClient` (QR flow,
5-min timeout), `killStaleBrowsers` (scoped to THIS project's auth dir),
`getChatsCompat`, `getDisplayName` (phone-number fallback for unsaved
contacts), `loadHistory` (live count + exponential backoff), `exportChat`
(options: `startTs/endTs/outDir/loadedCount/textOnly/mediaTypes`;
streams conversation.txt; counts saved vs skipped-existing separately;
local-time file stamps; newline-safe transcript lines via `oneline()`).

**`menu.js`** → `lib/menu.js` — interactive flow; idempotent inquirer patch
(`q` = back on List prompts only — Checkbox prompts are deliberately excluded
to avoid freezing mid-selection); confirm screen with live preview.

**`index.js`** — headless CLI; strict flag parsing (unknown flags are
errors, value-flags never swallow other flags); fast paths run before
whatsapp-web.js is required so help/version/account-admin never launch a
browser; ambiguous name matches can be picked interactively in a TTY.

**`import-export.js`** — standalone parser for native exports; exports pure
helpers (`classify`, `parseDate`, `detectDateFormat`, `LINE_RE`) used by
`test/helpers.test.js`.

### Exporting a chat

`exportChat()` in lib/scrape.js walks every loaded message in range (text and
media), downloading attachments of type image/video/audio/ptt/document/
sticker into type subfolders, and writes conversation.txt incrementally so a
crash keeps a usable partial transcript. Before any download each message's
`id._serialized` is backfilled from `id.$1` (July 2026 WhatsApp Web rename;
otherwise whatsapp-web.js 1.34.7 fails downloads with `r: r`).

### Output structure

```
<download-root>/<ChatName>/<date>_<session>/
  conversation.txt  ← "[timestamp] Sender: body" / "[…] Sender: [subdir/file] - caption"
  images/ videos/ audio/ documents/ stickers/ other/
```

Newlines inside bodies/captions are escaped to literal `\n` (one line per
message). Media filenames use local-time stamps matching the transcript.
Re-runs skip existing files.

### Auth persistence & safety

Sessions in `.wwebjs_auth/accounts/<name>/` (gitignored; chmod 700/600
applied on connect). Re-auth requires scanning a QR under Linked Devices.

### Date filtering

Local timezone throughout; `isValidDate` rejects rollover dates
(e.g. 2026-02-31).

## Key dependency

`whatsapp-web.js` v1.34.7 — unofficial WhatsApp Web API via Puppeteer.
Requires Chromium; WSL needs the `headless: true` + `--no-sandbox` config
(already set). Tests: `npm test` (pure helpers only — no browser).
