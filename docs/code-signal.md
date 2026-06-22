# Code-signal producer (`nlm code-signal`)

Turns a coding commit into a deterministically-labeled, retrievable code exemplar.
After your test gate runs, you emit a signal carrying the changed code and the
test exit code; the daemon captures it as a code exemplar (when
`NLM_CODE_EXEMPLARS_ENABLED=1`) that `recall_code` can later surface.

## What it sends

`nlm code-signal` selects the single most representative hunk from a commit's
diff (largest by added-line count), extracts its added lines as the code chunk,
detects the language from the file extension, and maps the test exit code to an
outcome (`0` → `pass`, non-zero → `fail`). It ships the code in `detail.code`
(PATH (b)) and records the sha under `detail.commit` for provenance — it never
sets `detail.git_sha`, so the daemon never tries to re-read the repo filesystem.
This keeps the producer portable across client installs and logical repo names.

The `repo` field is always a **logical** name: the `--repo` override, or the
basename of `--repo-path`. It is never an absolute filesystem path.

## Usage

```
nlm code-signal --repo-path <dir> --sha <sha> --test-exit <n> \
  [--task <s>] [--model <s>] [--repo <logical>] [--dry-run]
```

It POSTs to `http://localhost:${NLM_PORT:-3940}/api/signal` over loopback (no
auth on loopback). It is **best-effort**: a daemon-down or non-202 response warns
and exits 0, so it never blocks a commit. Use `--dry-run` to print the payload
without sending.

## Git post-commit hook

Drop this in `.git/hooks/post-commit` (make it executable). The `--repo` flag
keeps the recorded repo name stable regardless of where the clone lives:

```bash
#!/usr/bin/env bash
# Capture the just-made commit as a code signal. Best-effort; never fails.
npm test --silent
nlm code-signal --repo-path . --sha HEAD --test-exit $? --repo myrepo || true
```

## Coding-agent launcher

A coding-agent launcher calls it right after its test gate, so the exemplar
inherits the gate's pass/fail verdict:

```bash
# ... agent edits files, then commits ...
git commit -m "implement <spec>"
npm test
nlm code-signal --repo-path . --sha HEAD --test-exit $? --task "<spec>" --model "<model>"
```

The `--task` text becomes the exemplar's task context (what `recall_code`
matches against); omit it to fall back to the changed funcname/file.
