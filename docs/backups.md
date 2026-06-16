# Backups & restore

The worst case is a bad migration silently corrupting `~/.nlm/canonical.sqlite`.
Rolling daily snapshots make that recoverable.

## Commands

```
nlm backup [--retention <days>]   # write ~/.nlm/backups/canonical-YYYY-MM-DD.sqlite, prune old (default 7d)
nlm restore --list                # list available backup dates
nlm restore --from <YYYY-MM-DD>   # stage that snapshot for restore
nlm restart                       # apply the staged restore
```

`nlm backup` uses `VACUUM INTO` — a live-consistent, defragmented, single-file
snapshot safe to take while the daemon is ingesting. Snapshots older than the
retention window are pruned; today's is never pruned.

`nlm restore` is non-destructive: it validates the snapshot (integrity check +
required tables), copies it to a pending slot, and the next `nlm restart`
promotes it while moving the current DB aside to `canonical.sqlite.pre-restore-<ts>`
(archived, not deleted). The dated backup itself is preserved (copied, not moved).

## Scheduling the daily backup

`nlm backup` is the command to schedule. It is not auto-installed (a launchd/cron
agent is host-specific); add one of the following.

**macOS (launchd)** — `~/Library/LaunchAgents/io.whtnxt.nlm-backup.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>io.whtnxt.nlm-backup</string>
  <key>ProgramArguments</key><array><string>nlm</string><string>backup</string></array>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>0</integer></dict>
</dict></plist>
```

`launchctl load ~/Library/LaunchAgents/io.whtnxt.nlm-backup.plist`

**Linux (cron)**:

```
0 3 * * * nlm backup >> ~/.nlm/logs/backup.log 2>&1
```

Postgres backend: use `pg_dump`; `nlm backup` covers the SQLite backend only.
