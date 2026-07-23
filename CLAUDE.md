# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the scraper

```bash
# Interactive menu (recommended)
node menu.js

# CLI mode
node index.js                                          # list groups + personal chats
node index.js "Name"                                   # export all media + full conversation transcript
node index.js "Name" "2026-06-13"                      # single date
node index.js "Name" "2026-06-13" "FolderName"         # date + output folder
```

Both entry points work against groups and personal (1:1) chats — the name argument/selection is matched against either.

### Importing a native WhatsApp export (full history + media, no sync limits)

`index.js`/`menu.js` are capped by whatever WhatsApp Web has synced locally to this
linked device, and media is only downloadable while it still lives on WhatsApp's
CDN (a retention window of weeks, not years). For older/complete history —
including media WhatsApp's servers have long since expired — export the chat
from the phone instead: open the chat → ⋮ → **Export chat** → **Include media**,
then unzip and run:

```bash
node import-export.js "/path/to/WhatsApp Chat with X.txt" [OutputFolder] [--date-format=DMY|MDY]
```

This reads the phone's own export bundle (assumes media files sit alongside the
`.txt` in the same folder, as WhatsApp's export zip does), parses the Android/iOS
transcript format, and reorganizes it into the same `conversation.txt` +
type-subfolder layout as the other two entry points. `--date-format` defaults
to `DMY`; pass `MDY` if the export came from a US-locale phone.

## Architecture

Three entry points:

**`index.js`** — headless CLI scraper. Accepts args, connects, downloads, exits.

**`menu.js`** — interactive wrapper using `inquirer` v8 (CommonJS). Opens on a main menu with two modes:
- **Scrape a live chat** — connects to WhatsApp Web, prompts for chat type (group vs. personal), then chat/timeframe/output folder, and keeps the client alive across multiple scrape sessions within that mode so the user doesn't need to re-authenticate.
- **Import a native chat export** — no WhatsApp Web connection at all; prompts for the exported `.txt` path, date format, and output folder, then delegates to `import-export.js`.

**`import-export.js`** — parses a native WhatsApp chat export (see below) into the same output layout. Exports `importExport(txtPath, outDir, dateFormat)` for reuse from `menu.js`, and also runs standalone via CLI.

### Exporting a chat

`exportChat()` (duplicated in both entry points) is the shared core: it walks every loaded message in the date range — not just media — and:
- downloads attachments of type `image`, `video`, `audio`, `ptt` (voice notes), `document`, and `sticker` into type-specific subfolders
- writes every message (text and media) to `conversation.txt` in chronological order, with sender name, timestamp, and body/attachment reference

This is what makes a full personal-chat export possible, not just its media.

### WhatsApp history loading

WhatsApp Web lazy-loads message history. `fetchMessages({ limit })` is called with an ever-increasing limit to force `WAWebChatLoadMessages.loadEarlierMsgs` calls until the oldest message reaches the target date. This is the only reliable way to load history — `window.Store` is not accessible.

### Output structure

```
<OutputFolder>/
  conversation.txt  ← full transcript: [timestamp] Sender: body / [attachment path]
  images/           ← JPEG/PNG named <ISO-timestamp>_<index>.jpg
  videos/           ← MP4 named <ISO-timestamp>_<index>.mp4
  audio/            ← voice notes + audio files
  documents/        ← PDFs and other document attachments
  stickers/         ← stickers
```

Output root defaults to `__dirname`. Override with `OUTPUT_DIR` env var.

### Auth persistence

`LocalAuth` stores the WhatsApp Web session in `.wwebjs_auth/` — never commit this directory. Re-authentication requires scanning a QR code with the WhatsApp mobile app under Linked Devices.

### Date filtering

Timestamps use local timezone (Europe/Bucharest). Date strings are parsed as `YYYY-MM-DDT00:00:00` (no UTC suffix) so they resolve in the system's local timezone.

## Key dependency

`whatsapp-web.js` v1.34.7 — unofficial WhatsApp Web API via Puppeteer. Requires Chromium. The `headless: true` puppeteer config with `--no-sandbox` flags is required for WSL.
