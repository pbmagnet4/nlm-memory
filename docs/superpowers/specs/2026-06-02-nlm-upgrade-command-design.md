# nlm upgrade command — design spec

**Date:** 2026-06-02
**Status:** Approved

## Problem

The existing upgrade UX requires an end user to know and run:

```
npm i -g nlm-memory@latest && nlm restart
```

The `UpdateBanner` component (already live in the SideNav) surfaces this command and a copy button, but the raw npm command is long, has no single-verb entry point, and breaks silently for dev-build users (who aren't running the npm global). There is also no cache invalidation after upgrading, so the banner can persist for up to 24h after a successful upgrade.

## What Already Exists

These are in place and not being changed:

- `src/core/update-check/check.ts` — `getUpdateStatus`, 24h-cached registry poll, `behind` flag
- `/api/update-status` — HTTP endpoint consumed by the UI
- `src/ui/components/UpdateBanner.tsx` — SideNav footer component, shows version diff, copy button, freshness nudge, dismiss-per-version
- `nlm restart` — CLI subcommand, handles launchctl/systemctl/pkill by OS
- Startup console banner when `behind === true`

## Scope of This Change

Three pieces, nothing else:

1. `nlm upgrade` CLI subcommand
2. Update `INSTALL_CMD` in `UpdateBanner.tsx`
3. Cache bust in `nlm upgrade` after successful install

## Design

### 1. `nlm upgrade` CLI subcommand (`src/cli/nlm.ts`)

Added alongside existing commands. Behavior:

**Dev-build detection:** `__filename` does not contain `node_modules` → running from source.
- Print: `nlm upgrade: you're running a dev build — run \`npm run build\` to pick up changes.`
- Exit 0 (not an error, just not applicable).

**npm global path:** `__filename` contains `node_modules` → standard end-user install.
1. Print: `nlm: upgrading nlm-memory…`
2. Shell `npm install -g nlm-memory@latest` via `execFileSync` (inherits stdio so progress is visible).
3. On non-zero exit: print npm's stderr, exit 1.
4. Delete `~/.nlm/update-check.json` (cache bust) — non-fatal if file is absent.
5. Call the same restart logic used by `nlm restart` (imported from `restart-helpers.ts`).
6. Print: `nlm: upgraded and restarted.`

**Error handling:** npm install failure exits 1 with npm's own output visible. Restart failure follows the same behavior as `nlm restart` (already handles missing launchctl, systemd not available, etc.). Cache deletion failure is silently ignored.

### 2. `UpdateBanner.tsx` — `INSTALL_CMD` update

```diff
- const INSTALL_CMD = "npm i -g nlm-memory@latest && nlm restart";
+ const INSTALL_CMD = "nlm upgrade";
```

No other changes to the component.

### 3. Cache bust

In `nlm upgrade`, after a successful `npm install -g`:

```ts
import { unlink } from "node:fs/promises";
const cachePath = process.env["NLM_UPDATE_CHECK_CACHE"] ?? join(homedir(), ".nlm", "update-check.json");
await unlink(cachePath).catch(() => {});
```

This mirrors the path logic already in `check.ts`. The `UpdateBanner`'s next 30s poll (post-copy interval) will re-hit `/api/update-status`, which re-fetches from npm and finds `behind: false`, clearing the banner.

## Files Changed

| File | Change |
|------|--------|
| `src/cli/nlm.ts` | Add `upgrade` subcommand (~40 lines) |
| `src/ui/components/UpdateBanner.tsx` | Change `INSTALL_CMD` string (1 line) |

`check.ts`, `launchctl-helpers.ts`, `restart-helpers.ts` — read but not modified.

## Out of Scope

- Linux systemd path: `planRestart` already handles it; `nlm upgrade` calls the same helper, so Linux users get correct behavior automatically.
- Windows: not supported by NLM today; no change.
- Auto-update on daemon start: explicitly not doing this — upgrades are always user-initiated.
- In-UI "Update" button: out of scope; the copy-command pattern is sufficient and avoids daemon re-exec complexity.

## Success Criteria

1. End user on npm global sees update banner, runs `nlm upgrade`, daemon restarts on new version, banner clears within 30s.
2. Dev-build user runs `nlm upgrade`, gets a clear message explaining why it's a no-op.
3. `nlm upgrade` with no update available: npm installs the same version, restarts cleanly, cache resets — no error.
