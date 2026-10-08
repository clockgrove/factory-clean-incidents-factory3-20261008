# Incident atlas

A read-only local explorer for 2,400 fictional support incidents. Search IDs, titles and descriptions with case-insensitive literal matching; combine service, severity and status selections with inclusive UTC opened-date boundaries. Summaries and daily counts cover the entire matching result. Details expose all eleven fields as plain text.

## Start and stop

Use Node.js 24. From the checkout, run:

```sh
npm run pretest
npm run start
```

Open **http://127.0.0.1:3000**. The server binds only to loopback. Stop it with Ctrl+C. The prerequisite generates the canonical `.runtime/incidents.json` and installs pinned tooling when needed. The application reads this file without modifying it. `npm run seed` also generates the same canonical data.

Results start with no filters, newest opened date first and 25 rows. Choose 25 or 50 rows and either sort direction. Equal sort keys use incident ID ascending. Critical is the highest severity. Search, filter and sort changes reset pagination. Back to results preserves the page and selections. Active filters are shown above the results; Clear filters restores defaults.

Named views use this browser's local storage and remember search, filters, sort and page size; opening a view starts at page one. Save the same name to replace it, or select a view to open/delete it. CSV exports all matching incidents in current sort order, with every field and quoted CSV escaping. Tags are represented as a JSON textual array; null resolved timestamps are empty fields. Daily chart counts also have an expandable text alternative. Loading and request errors preserve selections; Retry applies to the current intent. Filter choices load independently of results and have their own status and Retry filter choices button. Their completion cannot navigate away from details or replace result status. Saved views can reopen while choices are still loading.

## Verify

The qualification environment provides the browser alias and sandbox-enabled Chromium. Run these commands in order:

```sh
npm run pretest
qualification-browser-smoke
npm test
```

`npm test` retains the unchanged pretest prerequisite and generic `node --test` discovery. Tests independently calculate expectations from the real canonical dataset and make actual HTTP requests. A real sandboxed browser exercises filtering, ordering, page sizes, summaries, full details, saved views across reload, downloads, keyboard focus, a narrow viewport, loading/empty states, genuine broken-connection failures, retry and overlapping requests, including bootstrap options success/failure during navigation and newer result loading. Delayed requests still run the real backend; no application responses are mocked. Every owned browser and server closes in finally blocks. The prerequisite's canonical byte/hash audit and post-journey byte comparisons verify that data remains unchanged.

The installed environment uses pinned Playwright 1.64.0 and Chromium 156.0.8078.4. Tests resolve `qualification-chromium` with `command -v`, set `PLAYWRIGHT_BROWSERS_PATH` to `../browsers` relative to its alias directory before importing Playwright, and launch with `{channel:'chromium', headless:true, chromiumSandbox:true}`. The explicit child environment uses `../host-libs/usr/lib/x86_64-linux-gnu` for `LD_LIBRARY_PATH`, `../host-libs/usr/share/alsa/alsa.conf` for `ALSA_CONFIG_PATH`, and relative `.runtime/browser-tmp` for TMPDIR/TMP/TEMP, preserving checkout cwd. Sandbox controls are never relaxed. An unavailable alias/browser is a verification environment failure, not a passing acceptance result.

Ignored `.runtime/` holds prerequisite receipts, actual browser screenshots, the downloaded CSV and browser verification evidence. Runtime files and node_modules are not source deliverables. Keep `data/generate.mjs`, `data/FIELDS.md`, canonical data, lockfile and the existing seed/pretest/test scripts unchanged. No accounts, editing, external services or deployment are involved.
