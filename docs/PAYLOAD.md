# NLM Self-Contained Payload

The payload is a `.tar.gz` archive that bundles the NLM runtime together with an official
Node.js binary. Desktop applications can unpack and launch it without requiring Node to be
installed on the user's machine.

## Build

```
./scripts/build-payload.sh
```

The script requires Node 22+ on the build machine (only for the build step itself). It
downloads the target Node release from `nodejs.org/dist` and caches it under
`.payload-cache/` (override with `NLM_PAYLOAD_CACHE`).

Two artifacts are written to the repository root:

| File | Description |
|---|---|
| `nlm-payload-<version>-darwin-<arch>.tar.gz` | Self-contained runtime tarball |
| `latest.json` | Version manifest consumed by the desktop onboarding companion |

These are build artifacts; do not commit them.

## Tarball structure

All paths are relative to the archive root:

```
run.sh                    — launcher script (see below)
node/bin/node             — official Node.js runtime (darwin-arm64 or darwin-x64)
app/dist/                 — compiled TypeScript output
app/dist/cli/nlm.js       — CLI entrypoint
app/migrations/           — SQL migration files (required at startup)
app/node_modules/         — production dependencies only (no devDependencies)
app/package.json          — package manifest
```

## run.sh

The launcher sets the directory anchor and delegates to the bundled Node binary:

```bash
exec "$DIR/node/bin/node" "$DIR/app/dist/cli/nlm.js" start "$@"
```

Environment variables are inherited from the calling process. The daemon respects:

| Variable | Default | Purpose |
|---|---|---|
| `NLM_PORT` | `3940` | HTTP listen port |
| `NLM_DB_PATH` | `~/.nlm/canonical.sqlite` | SQLite database path |

## latest.json schema

```json
{
  "version": "0.20.0",
  "darwin-arm64": {
    "url": "https://github.com/pbmagnet4/nlm-memory/releases/download/v0.20.0/nlm-payload-0.20.0-darwin-arm64.tar.gz",
    "sha256": "<hex sha256 of the tarball>"
  }
}
```

Desktop applications that bundle NLM check this manifest on launch to determine whether
an update is available. The `sha256` field is verified before unpacking any downloaded
tarball. The `url` field follows the GitHub Releases asset URL pattern for this
repository.

## Health check

After extraction and launch, confirm the daemon is up:

```bash
curl http://localhost:<NLM_PORT>/api/health
```

A healthy response includes `"status": "ok"` and a `"version"` field that matches the
version in `latest.json`.
