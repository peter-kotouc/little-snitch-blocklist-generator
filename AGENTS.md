# AGENTS.md — Guide for AI Agents & Contributors

> **Maintenance contract — read this first:**
> This file describes the architecture, invariants, and cross-file couplings of
> this repository. It is only useful while it is true. Therefore:
>
> 1. **Keep it current.** Any change that affects something documented here
>    (a command, a file path, an invariant, a coupling) MUST update this file
>    in the same commit/PR. Treat a stale AGENTS.md as a bug.
> 2. **Walk the ripple map.** Before finishing any change, find your touched
>    file in the [Ripple map](#ripple-map--if-you-change-x-also-update-y)
>    below and update every coupled location it lists.
> 3. **Extend the ripple map.** If your change introduces a NEW coupling
>    (two places that must now change together), add a row for it here.

## What this project is

A two-stage pipeline that serves custom-merged DNS blocklists to
[Little Snitch](https://obdev.at/products/littlesnitch/index.html) clients:

1. **Fetch stage** (`scripts/fetch-blocklists.sh`, run daily by GitHub
   Actions): downloads upstream domain lists defined in
   `blocklist_sources.json`, validates/normalizes/sorts them, and commits the
   results to `blocklists/*_preprocessed_sorted.txt`.
2. **Serve stage** (`functions/api/blocklists.js`, a Cloudflare Pages
   Function): at request time, fetches the requested pre-sorted files,
   performs a streaming k-way merge with deduplication, and streams a Little
   Snitch-compatible JSON ruleset.

The repo root is deployed as-is to Cloudflare Pages. **Anything in the root
that is not deleted by `build:cloudflare` is publicly served as a static
file** — see the deployment notes below.

## Commands

```bash
npm test                          # Full test suite (node:test, Node >= 20)
node --test tests/worker.test.js  # Single test file
npm run fetch                     # Run the fetch pipeline locally (writes blocklists/)
npm run dev                       # Serve the Worker locally via wrangler
```

There is no build step, no linter config, and **zero npm dependencies** —
tests use `node:test` only. Keep it that way unless the maintainer explicitly
agrees to add a dependency.

## Hard invariants — do not break these

1. **Sort-order contract (most important).** Every
   `blocklists/*_preprocessed_sorted.txt` must be sorted in **plain byte
   order**. The bash pipeline enforces this with `LC_ALL=C sort -u`; the
   Worker's k-way merge relies on it because it compares domains with
   JavaScript's `<` operator (`functions/api/blocklists.js`). Locale-collated
   sorting silently breaks deduplication and output ordering.
2. **File naming contract.** Generated files are named
   `{name}_preprocessed_sorted.txt`. The pattern is hardcoded in the fetch
   script, the Worker's URL construction, and the tests.
3. **Header contract.** Generated files start with exactly 4 metadata lines
   (`# Blocklist:`, `# Source:`, `# License:`, `# Processed:`). The Worker
   drops any line starting with `#`, and the fetch script's skip-if-unchanged
   check ignores only the `# Processed:` line when diffing.
4. **Name charset contract.** Blocklist names must match `^[a-zA-Z0-9_-]+$`.
   Enforced **twice**: in `scripts/fetch-blocklists.sh` (path-traversal guard
   on config entries) and in `functions/api/blocklists.js` (guard on the
   `?lists=` query parameter). Change one → change both.
5. **Domain charset contract.** The fetch script's validation regex only
   admits lines of `[[:alnum:]._-]` characters (plus comments/whitespace).
   The Worker additionally JSON-escapes each domain via `JSON.stringify` as
   defense in depth. Loosening the bash regex requires re-checking the
   Worker's output encoding and the Little Snitch format constraints.
6. **Failure isolation in the fetch script.** One bad blocklist entry must
   never abort the pipeline: every failure path ends in `continue`, previously
   good files are never clobbered (downloads go to temp files), and temp files
   are cleaned up. The script runs under `set -euo pipefail` — any new
   pipeline stage must be written so an expected failure (empty grep, curl
   error) cannot trip errexit.
7. **No-op runs produce no diffs.** The fetch script keeps the existing file
   when only the `# Processed:` timestamp would change. Don't reintroduce
   per-run churn (it bloats git history — each daily commit stores new blobs
   for multi-MB files).

## Ripple map — "if you change X, also update Y"

| If you change…                                                | …also update                                                                                                                                                                                                            |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Add/remove a blocklist**                                     | `blocklist_sources.json`; **Included Blocklists** table in `README.md`; presets in `recommendations.json`; on removal, delete `blocklists/{name}_preprocessed_sorted.txt`                                                |
| Name validation regex (`^[a-zA-Z0-9_-]+$`)                     | `scripts/fetch-blocklists.sh` AND `functions/api/blocklists.js` (both guards), plus the traversal tests in `tests/fetch.test.js` and `tests/worker.test.js`                                                              |
| Generated filename suffix (`_preprocessed_sorted.txt`)         | `scripts/fetch-blocklists.sh`, Worker URL construction in `functions/api/blocklists.js`, both test files, `README.md` (table + project structure)                                                                        |
| Metadata header format / `#` comment convention                | Worker's comment-stripping (`!line.startsWith("#")`), skip-if-unchanged diff (`grep -v '^# Processed:'`) in the fetch script, header-format regexes in `tests/fetch.test.js`                                             |
| API query params, limits (20-list cap), or response shape      | `functions/api/blocklists.js`, `tests/worker.test.js`, **Usage** section + example response in `README.md`                                                                                                              |
| Fetch script behavior or pipeline stages                       | The header doc-block inside `scripts/fetch-blocklists.sh`, `tests/fetch.test.js`, and the POSTCONDITIONS comments in `.github/workflows/fetch-blocklists.yml`                                                            |
| Test file locations or names                                   | `test` glob in `package.json`, `paths` filters in BOTH `.github/workflows/ci.yml` and `.github/workflows/fetch-blocklists.yml`                                                                                           |
| Add a new source-code directory                                | `paths` filters in both workflow files (or changes there won't trigger CI), and the `build:cloudflare` `rm -rf` list in `package.json` if it must not be publicly served                                                 |
| Add a new file in the repo root                                | `build:cloudflare` in `package.json` (root files not deleted there are **served publicly** by Cloudflare Pages), and the **Project Structure** tree in `README.md`                                                       |
| Fork-specific config (`GITHUB_USERNAME`, `AUTHOR_NAME`, `REPOSITORY_URL`) | The **Deploying your own instance** steps in `README.md` reference these by name and location                                                                                                                |
| Issue titles used by the CI bot                                | Both `create_issue_if_not_exists` and `close_issue_if_exists` call sites in `scripts/fetch-blocklists.sh` — create/close titles must match exactly or resolved issues stay open forever                                  |
| Anything documented in this file                               | **This file (`AGENTS.md`)** — same commit                                                                                                                                                                                |

## CI / deployment notes

- `.github/workflows/fetch-blocklists.yml`: daily cron (04:00 UTC) + pushes to
  `main`. Runs tests (except on cron), runs the fetch script with `CI=true`
  (enables the GitHub-Issue bot), commits changed files in `blocklists/`.
- `.github/workflows/ci.yml`: tests only, for PRs and non-`main` branches.
- Cloudflare Pages runs `npm run build:cloudflare`: tests first, then deletes
  everything that should not be publicly served. The `functions/` directory
  becomes the Pages Functions API; everything else left in the tree is served
  as static files (including `blocklists/` and `blocklist_sources.json`,
  which the Worker fetches from its own origin at request time).
- The fetch tests spin up a local HTTP server on **port 3000** and are
  skipped when `CF_PAGES=1` (the Pages build image lacks bash tooling).

## Conventions

- **Commits:** [Conventional Commits](https://www.conventionalcommits.org/)
  (`feat:`, `fix:`, `docs:`, `chore:` …).
- **Branches:** `feat/…`, `fix/…`, `docs/…` (see `CONTRIBUTING.md`).
- **Bash:** strict mode (`set -euo pipefail`) is non-negotiable; write new
  code to be errexit-safe. Prefer POSIX-portable constructs (the script must
  run on macOS/BSD and GNU userlands — e.g. `tr` + temp file instead of
  `sed -i`).
- **JS:** ES modules, JSDoc on exported functions, no dependencies.
- **Tests:** `node:test` + `node:assert`. Fetch tests exercise the real bash
  script against a local mock HTTP server; Worker tests import `onRequest`
  directly and mock `global.fetch`. New behavior in either stage needs a test
  in the corresponding file.

## Checklist before you finish any change

1. `npm test` passes (all tests, no skips beyond the documented `CF_PAGES` skip).
2. Every coupled file from the ripple map is updated.
3. Doc-comments still tell the truth (script header block, Worker JSDoc,
   workflow comments, `README.md`).
4. This file still tells the truth.
