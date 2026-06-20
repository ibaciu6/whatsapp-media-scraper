# whatsapp-media-scraper

Download all images and videos from a WhatsApp group — by date, date range, or all time. Session persists so you only scan the QR code once.

## Requirements

- Node.js 18+
- Chromium (installed automatically by Puppeteer via `npm install`)
- A WhatsApp account with access to the target group

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

Walks you through:

1. **Group selection** — lists all your WhatsApp groups
2. **Timeframe** — today, yesterday, a specific date, a date range, or all time
3. **Output folder** — name for the download folder (auto-suggested from the date)
4. **Confirmation** — shows a summary before starting

The client stays connected between sessions so you can scrape multiple groups or dates without re-authenticating.

### CLI

```bash
node index.js                                         # list your groups
node index.js "Group Name"                            # all media from group
node index.js "Group Name" "2026-06-13"               # media on a specific date
node index.js "Group Name" "2026-06-13" "FolderName"  # date + custom output folder
```

Group name matching is case-insensitive and partial — `"bubu"` matches `"Parinti - Buburuze"`.

---

## Output

```
<OutputFolder>/
  images/   ← JPEG/PNG named <ISO-timestamp>_<index>.jpg
  videos/   ← MP4/MOV  named <ISO-timestamp>_<index>.mp4
```

Files are named by message timestamp so the order is preserved. Already-downloaded files are skipped on re-run — downloads are safe to resume.

Output root defaults to the project directory. Override with `OUTPUT_DIR`:

```bash
OUTPUT_DIR=/mnt/d/Downloads node menu.js
```

---

## How history loading works

WhatsApp Web lazy-loads message history and does not expose the full message store. The scraper calls `fetchMessages()` with an ever-increasing limit, which forces WhatsApp Web to load earlier batches, until the oldest loaded message reaches the target date. This is the only reliable method — `window.Store` is not accessible from whatsapp-web.js.

---

## Notes

- `.wwebjs_auth/` stores your session token — it is gitignored, never commit it
- Timestamps use the local system timezone
- WhatsApp caps history loading at ~50 000 messages per fetch cycle
- Running on WSL requires the `--no-sandbox` Puppeteer flag (already set)
