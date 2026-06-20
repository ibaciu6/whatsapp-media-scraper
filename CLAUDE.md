# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the scraper

```bash
# Interactive menu (recommended)
node menu.js

# CLI mode
node index.js                                          # list groups
node index.js "Group Name"                             # all media
node index.js "Group Name" "2026-06-13"                # single date
node index.js "Group Name" "2026-06-13" "FolderName"   # date + output folder
```

## Architecture

Two entry points, one shared WhatsApp client pattern:

**`index.js`** — headless CLI scraper. Accepts args, connects, downloads, exits.

**`menu.js`** — interactive wrapper around the same logic using `inquirer` v8 (CommonJS). Keeps the client alive across multiple scrape sessions so the user doesn't need to re-authenticate.

### WhatsApp history loading

WhatsApp Web lazy-loads message history. `fetchMessages({ limit })` is called with an ever-increasing limit to force `WAWebChatLoadMessages.loadEarlierMsgs` calls until the oldest message reaches the target date. This is the only reliable way to load history — `window.Store` is not accessible.

### Output structure

```
<OutputFolder>/
  images/   ← JPEG/PNG named <ISO-timestamp>_<index>.jpg
  videos/   ← MP4 named <ISO-timestamp>_<index>.mp4
```

Output root defaults to `__dirname`. Override with `OUTPUT_DIR` env var.

### Auth persistence

`LocalAuth` stores the WhatsApp Web session in `.wwebjs_auth/` — never commit this directory. Re-authentication requires scanning a QR code with the WhatsApp mobile app under Linked Devices.

### Date filtering

Timestamps use local timezone (Europe/Bucharest). Date strings are parsed as `YYYY-MM-DDT00:00:00` (no UTC suffix) so they resolve in the system's local timezone.

## Key dependency

`whatsapp-web.js` v1.34.7 — unofficial WhatsApp Web API via Puppeteer. Requires Chromium. The `headless: true` puppeteer config with `--no-sandbox` flags is required for WSL.
