# Digest and UI reference

## Daily digest

Once-a-day summary of yesterday's activity:

```sh
nlm digest                  # print to stdout
nlm digest --telegram       # post to Telegram (TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID)
```

Reports 24h real-traffic (probes filtered), 7d hit_rate + useful_hit_rate, honest cited-precision, top 5 queries, a tier-B outcome coverage line (held / overturned / built-upon / unobserved over the last 30 days), a `Jobs:` line for the daemon-supervised `reprocess` run (active progress, appending `, N restarts` when the run has OOM-churned at least once, a completed/exhausted/stopped outcome, or "no active job"), and a **`WARN hook silent`** alert when Claude Code ran yesterday but no live hook fires were logged. That alert is the canary for post-install drift — node upgrades, `settings.json` hand-edits, and `dist/` moves silently break the hook while Claude Code keeps working. Setup-time smoke tests can't catch this; only the daily correlation can.

Wire to cron for a morning push:

```cron
0 7 * * *  nlm digest --telegram >> ~/.nlm/logs/digest.log 2>&1
```

When the daemon is unreachable, `--telegram` still fires — posts a "daemon unreachable" alert instead of failing silently.

---

## What's inside the UI

Open `http://localhost:3940/ui` after the daemon starts.

| Page | What it shows |
|---|---|
| **Live** | Sessions being written in real time, recent reads, recent decisions |
| **Pulse** | System health — coherence, runtimes, stale entities, recent sessions |
| **River** | Full session timeline with density controls + superseded-lane visualization |
| **Thread** | Per-entity conversation history with runtime filters and ←/→ navigation |
| **Search** | Keyword, semantic, or hybrid recall with match snippets and field-origin tags |
| **Recall** | Adoption telemetry — useful_hit_rate, source breakdown, query log |
| **Settings** | Sources, providers, classifier, data backup/restore |
