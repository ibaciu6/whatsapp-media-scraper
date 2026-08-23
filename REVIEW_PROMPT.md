# AGENT REVIEW PROMPT — whatsapp-media-scraper

> Point any AI coding agent at this file as its task instruction.
> The agent should read this file first, then follow it exactly.

---

# TASK: Exhaustive multi-perspective review of "whatsapp-media-scraper"

You are a senior review board compressed into one agent. Your job is to audit
this repository more thoroughly than its authors can — they have reviewed it
many times and are now blind to their own assumptions. Assume nothing works.
Verify everything you claim. Do NOT modify any code: this is analysis only.

---

## 1. PROJECT CONTEXT

WhatsApp Media Scraper exports WhatsApp conversations (groups + 1:1 chats)
as `conversation.txt` + media subfolders, from two sources:

- **Live scraping** via whatsapp-web.js v1.34.7 + Puppeteer (headless Chromium,
  WSL-targeted flags). Two entry points:
    - `index.js`   — headless CLI (strict flag parsing, batch mode, resume)
    - `menu.js`    → `lib/menu.js` — interactive inquirer-v8 wizard
- **Native phone exports** via `import-export.js` (streaming readline parser
  of Android/iOS `.txt` bundles).

Shared logic lives in:
- `lib/core.js`   — config (lazy auth paths, `WA_AUTH_ROOT` override), account
                    CRUD, exclusive per-account `.lock`, meta/stats/chat-cache,
                    sanitizeName, validateOutputDir, date helpers, MIME maps
- `lib/scrape.js` — connectClient (5-min timeout, QR screen-clear, session
                    perm hardening), killStaleBrowsers (scoped to this
                    project's auth dir), getChatsCompat (page-side monkey-patch),
                    loadHistory (backoff + throughput display), exportChat
                    (ETA status line, incremental transcript, resume sidecar
                    `.export-meta.json`, media-type filters)

Supporting: `test/helpers.test.js` (node:test, 16 cases — pure helpers +
one streaming integration test), `README.md`, `CLAUDE.md`, `ISSUES.md`
(read this last one FIRST — it documents what is already fixed and which
limitations are accepted; do not re-report those unless you find a REAL
failure path the entry dismisses).

## 2. GROUND RULES

1. Read every file completely before forming opinions. Cite evidence as
   `file:line` for every finding.
2. Run what you can, don't speculate:
     - `npm test`
     - `node --check <each js file>`
     - `node index.js --help | --version | --list-accounts | --show-output-dir`
     - `node index.js --frobnicate`            (must be rejected)
     - `node index.js --account`               (missing value → rejected)
     - `node index.js --timezone Bad/Zone`     (rejected)
     - `TZ=Asia/Tokyo node index.js --show-output-dir` etc.
     - Build a synthetic export .txt (BOM + U+200E + CRLF + multi-line body +
       2 attachments in one message + missing media file) and drive
       `import-export.js` through: default, `--dry-run`, `--media-types image`,
       `--text-only`, `--date-format=MDY`, `--ignore-missing`. Verify
       transcript contents byte-for-byte against expectations.
     - Simulate resume: run an export path twice against the same outDir using
       a fake `.export-meta.json` (matching / mismatching chat key & params)
       and confirm append vs fresh-overwrite behavior.
3. WA_AUTH_ROOT env var redirects ALL auth state — use it to keep tests off
   the real `.wwebjs_auth/`.
4. You cannot connect to real WhatsApp. For live-path code, do desk-checks
   against whatsapp-web.js 1.34.x sources in `node_modules/` when behavior
   matters (e.g., does `chat.fetchMessages({limit})` really return
   newest-first? does `client.destroy()` settle after auth_failure?).

## 3. PERSPECTIVES YOU MUST ADOPT (one pass each)

**A. Developer / maintainability**
- Hidden coupling between lib modules and both entry points; drift risks.
- Error-handling consistency: swallowed exceptions (`catch {}`) that hide
  real failures vs intentional best-effort cleanup.
- Test coverage gaps: what pure logic is still untested? Propose concrete
  new test cases (input → expected).
- Naming/comment accuracy: comments that lie about code behavior.

**B. QA / adversarial edge cases**
- Empty, emoji-only, 300-char, RTL-only, newline-containing chat names
  through sanitizeName AND through getDisplayName fallbacks.
- Date boundaries: DST-transition days, `23:59:59.999` messages,
  `isValidDate('2024-02-29')` leap handling, inverted ranges, `all`.
- Arg-parser torture: `--media-types image,,video`, `--media-types=`,
  `-h` mixed with positionals, positional that looks like a flag value,
  duplicate conflicting flags, `--output-dir -`, unicode args.
- Resume sidecar attacks: corrupted JSON meta, meta from ANOTHER chat,
  lastIndex beyond message count, completed:true with changed range.
- Lock semantics: stale-lock takeover race between two processes checking
  simultaneously (O_EXCL window), lock left after SIGKILL mid-export.
- Streaming parser: line longer than available memory? `\r`-only files?
  attachment filename containing `>` or newlines? 10k attachments/message?
- Timezone flag applied AFTER first Date construction anywhere?

**C. End-user experience**
- Walk every flow as a first-time non-technical user (menu start-to-finish;
  CLI help discoverability). Note any dead-end, ambiguous prompt, jargon,
  missing confirmation, or destructive action reachable too easily.
- Batch mode: what does the user see after 200 chats / 2 failures at #37?
- Are error messages actionable (next step stated)?

**D. Security auditor**
- Path traversal: every user-supplied path (--output-dir, settingsFlow,
  session label, folder label, account name, media-dir) — construct actual
  escape payloads and trace where bytes land.
- Symlink attacks: pre-planted symlink at `<outDir>/images` pointing outside;
  `.export-meta.json` as symlink; account dir itself a symlink.
- Auth material permissions end-to-end (umask races before chmod runs);
  tokens leaked into logs/error messages/console output anywhere.
- Command injection surface in killStaleBrowsers `ps` parsing (args containing
  crafted strings); `execSync` shell=True implications.
- QR exposure residual risk given the post-auth screen clear.

**E. Performance engineer**
- exportChat holds full message array + base64 buffers; quantify realistic
  ceilings, propose chunked fetch strategy compatible with the library.
- Status-line redraw cost on slow terminals; sleep(0) yields adequacy.
- dirSize() on menu render for accounts with GB-scale sessions — blocking?

**F. Portability / DevOps**
- Linux-only assumptions: `ps -eo pid=`, `/tmp` defaults, chmod no-ops on
  Windows, ANSI clears on cmd.exe. Which break loudly vs silently?
- Node version floor honesty (engines says >=16): any API requiring >16?
- npm scripts, CI-worthiness of the test suite, missing lint config.

**G. Docs reviewer**
- Every documented command/flag/output path vs actual behavior — flag any
  doc lie. Check README troubleshooting claims are implementable as written.

## 4. KNOWN-ACCEPTED ITEMS — DO NOT RE-REPORT AS NEW
(Challenge only with a concrete failure scenario.)
- whatsapp-web.js in-RAM message/media model & ~50k fetch cap
- QR visible in terminal scrollback (screen cleared post-auth)
- CLI `[ERR]` vs menu ✗/✓ output-style split
- Changed date-range ⇒ deliberate fresh export, not merge

## 5. SEVERITY SCALE
P0 data loss / security breach · P1 broken primary flow · P2 wrong output /
bad UX under realistic use · P3 polish. Tag each finding with the dominant
perspective letter(s).

## 6. DELIVERABLE FORMAT

Produce exactly these sections:

1. **Verification log** — commands you actually ran + pass/fail observed.
2. **Findings table** — ID (F-001…), file:line, severity, perspective,
   one-line title, then per finding: evidence (quote ≤3 lines), concrete
   repro/failure path, suggested fix sketch, confidence (high/med/low).
3. **Module verdicts** — for core.js / scrape.js / menu.js / index.js /
   import-export.js / tests / docs: SHIP | SHIP-WITH-FIXES | HOLD, plus 2–3
   sentence rationale each.
4. **New test proposals** — numbered, directly translatable into node:test
   cases (inputs + exact assertions).
5. **Release-readiness**: single score 0–100 + top-3 blockers if any.

Anti-noise policy: no style nitpicks, no "consider adding TypeScript", no
hypotheticals without a demonstrated code path. If you find fewer than 10
real findings, report fewer than 10 — do not pad.
