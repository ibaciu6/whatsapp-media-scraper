# whatsapp-media-scraper

Export a full WhatsApp conversation — groups and personal (1:1) chats — as a
chronological transcript plus every media attachment (images, videos, audio/voice
notes, documents, stickers), filtered by date, date range, or all time. Session
persists so you only scan the QR code once.

## Requirements

- Node.js 18+
- Chromium (installed automatically by Puppeteer via `npm install`)
- A WhatsApp account with access to the target chat

## Setup

```bash
npm install
```

On first run a QR code appears in the terminal. Scan it with WhatsApp on your phone:  
**Settings → Linked Devices → Link a Device**

The session is saved to `.wwebjs_auth/` — subsequent runs reconnect automatically without re-scanning.

---

## Usage

### Interactive menu (recommended)

```bash
./scrape.sh
# or
node menu.js
```

Opens straight into the live scrape flow (banner + step-by-step status lines
while the browser launches and the session connects):

1. **Group or personal chat** — pick which kind of chat to browse
2. **Chat selection** — lists matching chats
3. **Timeframe** — today, yesterday, a specific date, a date range, or all time
4. **Output folder** — name for the export folder (auto-suggested from the date)
5. **Confirmation** — shows a summary before starting

Navigation: press `q` to go back one step (on lists it works as a hotkey; on
date/folder inputs type `q` and press Enter), and the export summary's
`q = no` skips the scrape. The app never exits on its own — after a scrape it
pauses, then returns you to the same chat list for another round. The only way
out is `⛔  Exit` in the main menu (or Ctrl+C, which aborts cleanly).

The client stays connected so you can scrape multiple chats or dates without re-authenticating.

### CLI

```bash
node index.js                                    # list your groups + personal chats
node index.js "Name"                             # full export: media + conversation.txt
node index.js "Name" "2026-06-13"                # limited to a specific date
node index.js "Name" "2026-06-13" "FolderName"   # date + custom output folder
```

Name matching is case-insensitive and partial, and matches groups or personal chats — `"bubu"` matches `"Parinti - Buburuze"`.

---

## Importing a native WhatsApp export (full history, no sync limits)

`index.js`/`menu.js` are capped by whatever WhatsApp Web has synced locally to
this linked device, and media is only downloadable while it still lives on
WhatsApp's CDN (a retention window of weeks, not years). For complete history —
including media WhatsApp's servers have long since expired — export the chat
from your phone instead:

1. Open the chat on your phone → ⋮ (or contact/group name) → **Export chat** → **Include media**
2. Transfer the resulting `.zip` to this machine and unzip it
3. Run:

```bash
node import-export.js "/path/to/WhatsApp Chat with X.txt" [OutputFolder] [--date-format=DMY|MDY]
```

This reads the phone's own export bundle (media files are expected alongside
the `.txt`, as WhatsApp lays them out), parses the Android/iOS transcript
format, and reorganizes it into the same output layout as the other entry
points. `--date-format` defaults to `DMY` (most locales); pass `MDY` if the
export came from a US-locale phone.

---

## Output

```
<OutputFolder>/
  conversation.txt  ← full transcript: [timestamp] Sender: body / [attachment path]
  images/           ← JPEG/PNG named <ISO-timestamp>_<index>.jpg
  videos/           ← MP4/MOV named <ISO-timestamp>_<index>.mp4
  audio/            ← voice notes + audio files
  documents/        ← PDFs and other document attachments
  stickers/         ← stickers
```

`conversation.txt` includes every message in range — text and media — in
chronological order, with sender name, timestamp, and an inline reference to
the saved attachment (if any). Files are named by message timestamp so order
is preserved. Already-downloaded files are skipped on re-run — downloads are
safe to resume.

Output root defaults to the project directory. Override with `OUTPUT_DIR`:

```bash
OUTPUT_DIR=/mnt/d/Downloads node menu.js
```

---

## How history loading works

WhatsApp Web lazy-loads message history and does not expose the full message
store. The scraper calls `fetchMessages()` with an ever-increasing limit,
which forces WhatsApp Web to load earlier batches, until the oldest loaded
message reaches the target date, retrying through transient stalls before
giving up. This is the only reliable method — `window.Store` is not
accessible from whatsapp-web.js.

This still only reaches whatever history the phone has synced to this linked
device — it is not a substitute for a native chat export if you need the
complete history (see above).

---

## Notes

- `.wwebjs_auth/` stores your session token — it is gitignored, never commit it
- Timestamps use the local system timezone
- WhatsApp caps history loading at ~50 000 messages per fetch cycle
- Media on WhatsApp's CDN expires after a retention window (weeks, not years) — expired attachments will fail to download via live scraping; use a native export to recover them
- Running on WSL requires the `--no-sandbox` Puppeteer flag (already set)
- A WhatsApp Web frontend update (July 2026) renamed the internal message id field `_serialized` → `$1`, which broke media downloads in whatsapp-web.js 1.34.x with an opaque `r: r` error. The scraper backfills `_serialized` from `$1` on every loaded message, so downloads keep working against both old and new builds.
