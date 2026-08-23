# Issue Tracker — WhatsApp Media Scraper

Status after the fix campaign + an independent adversarial audit (Aug 2026):
**no actionable issues open.** The audit's 21 findings — including two P1s in
the account-lock path that had broken new-account creation and stale-lock
recovery, and a resume sidecar that was never flushed mid-run — are all fixed
and regression-tested (30/30 tests green).

What follows is what intentionally remains, split into upstream limitations
(out of this repo's control), accepted design decisions, and the changelog.

---

## Upstream limitations (cannot be fixed here)

1. **Memory ceiling on very large chats** — whatsapp-web.js loads messages
   and base64 media into RAM; history fetching caps around 50k messages per
   chat. Chats far beyond that, or very large videos, can exhaust memory.
   Workaround: native phone exports via `import-export.js` (which streams
   its input line-by-line). Any real fix belongs in whatsapp-web.js itself.

2. **QR code visible in terminal scrollback** — inherent to terminal-based
   linking. Mitigated: screen is cleared right after successful auth,
   session dirs pre-created owner-only before Chromium launches, sessions
   chmod 700/600 on connect, connection attempts time out after 5 min.

## Accepted design decisions

3. **Output style split** — CLI prints `[ERR]/[INFO]/[OK]` (script-friendly);
   the interactive menu uses ✗/✓ decorations (human-friendly). Unifying them
   would make one audience worse.

4. **Resume scope** — re-running into the same folder with the *same* chat +
   date range resumes exactly where an interrupted export stopped
   (`.export-meta.json`, anchored by message id so shifted history windows
   can't duplicate/skip segments). Changing the range starts a fresh export.

---

## Resolved changelog

### External-audit round (Aug 2026)

- **P1 lock: fresh accounts unusable** — `acquireAccountLock` now creates the
  account dir before taking the lock.
- **P1 lock: stale takeover was dead code** — warned then EEXIST'd forever.
  Locks now record the owner pid: dead-owner locks reclaim instantly,
  age >6h as fallback; takeover unlinks before O_EXCL re-create; single
  atomic write removes the empty-file window.
- **Resume hardening** — sidecar is flushed during the run (every media save
  + every 25 msgs) so mid-run crashes leave resumable state; resume anchors
  on last message ID, immune to history prepends between runs.
- **Symlink refusal** — export/import refuse to write through planted
  symlinks at transcript/meta/media-dir/file level; live media writes use
  O_EXCL (also makes skip-existing race-free).
- **Node engines ≥18** honest floor (`readline/promises`, `node --test`).
- **CLI accepts `--flag=value`** for value flags, matching import-export;
  timezone no longer half-applied then rejected on the `=` form.
- **import-export**: dry-run missing-count excludes filtered-out types;
  attachment paths with `..`/absolute forms refused; invalid date components
  return null → `[invalid date]` marker instead of silent Date rollover.
- **Menu**: q-escape added to delete confirmation; per-minute dirSize cache
  stops GB-scale accounts stalling renders; status feed labeled distinctly;
  dead ternary removed.
- **Stale-browser killer** matches only processes whose *binary* is
  Chrome/Chromium/headless_shell (was: any args mentioning both strings).
- Session dirs pre-created 0700 before Chromium launches (umask window gone).
- Docs: CLAUDE.md checkbox-prompt claim fixed; README resume semantics,
  colon-sender caveat, Windows caveats, lock wording corrected.

### Original campaign (summary)

**Architecture** — shared `lib/core.js` (lazy auth paths overridable via
`WA_AUTH_ROOT`, config precedence env → file → project, account CRUD +
meta/stats/chat-cache, sanitizeName, validateOutputDir) and `lib/scrape.js`
(connectClient w/ 5-min timeout, scoped browser killer, getChatsCompat,
loadHistory w/ throughput display, exportChat). Entry points are thin.

**Reliability** — idempotent inquirer patching; try/finally destroy + lock
release; incremental transcript writes with awaited stream flush; truncated-
file cleanup; friendly mkdir failures; corrupt-config backup.

**CLI/menu UX** — strict flag parsing; batch mode with summaries that
continue past failures; chat search; media-scope picker; preview counts;
broadcast toggle; typed-name deletes; account stats rows; `--timezone`.

**Import-export** — streaming readline input; BOM strip; iOS dash-less lines;
multi-attachment messages; auto date-format sniffing; `--media-types` filter
(live + dry-run); unknown types → other/.

**Security** — output-dir validation everywhere; config 0600; traversal-safe
name sanitization (regression-tested).

**Quality** — 30 node:test cases incl. lock semantics, id-anchored crash/
resume, symlink refusal, filter accounting and a full streaming-import e2e.
