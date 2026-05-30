/**
 * SupersedePalette — modal search-and-pick UI for marking a predecessor
 * session as superseded by a successor. Opened from SessionDrawer's
 * overflow menu. Hits /api/recall for autocomplete, then POSTs to
 * /api/session/:predecessor/supersede.
 *
 * Keyboard: Esc closes, Enter confirms when a candidate is highlighted,
 * Arrow keys move the highlight. Mouse interactions mirror the keyboard.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

interface Candidate {
  id: string;
  label: string;
  startedAt: string | null;
  runtime: string;
}

interface RecallResult {
  results: ReadonlyArray<{
    id: string;
    label: string;
    startedAt?: string;
    runtime?: string;
  }>;
}

interface SupersedePaletteProps {
  predecessorId: string;
  predecessorLabel: string;
  onClose: () => void;
  onMarked: (successorId: string) => void;
}

const SEARCH_DEBOUNCE_MS = 200;

export function SupersedePalette({
  predecessorId,
  predecessorLabel,
  onClose,
  onMarked,
}: SupersedePaletteProps) {
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [highlight, setHighlight] = useState(0);
  const [picked, setPicked] = useState<Candidate | null>(null);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const reasonRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const listboxId = useMemo(() => `supersede-listbox-${Math.random().toString(36).slice(2, 9)}`, []);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  // Focus trap + Esc handling. We attach to the dialog itself rather than the
  // window so Esc stops at this layer — SessionDrawer's own Esc handler can't
  // see the event, and the drawer behind us stays open when the palette closes.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const focusables = collectFocusables(dialog);
      if (focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    dialog.addEventListener("keydown", handler);
    return () => dialog.removeEventListener("keydown", handler);
  }, [onClose]);

  useEffect(() => {
    if (picked) return;
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      setCandidates([]);
      return;
    }
    const t = setTimeout(async () => {
      try {
        const r = await fetch(
          `/api/recall?q=${encodeURIComponent(trimmed)}&mode=hybrid&limit=8`,
        );
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = (await r.json()) as RecallResult;
        const next = data.results
          .filter((row) => row.id !== predecessorId)
          .map((row) => ({
            id: row.id,
            label: row.label || "(unlabelled)",
            startedAt: row.startedAt ?? null,
            runtime: row.runtime ?? "",
          }));
        setCandidates(next);
        setHighlight(0);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setCandidates([]);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query, picked, predecessorId]);

  useEffect(() => {
    if (picked) reasonRef.current?.focus();
  }, [picked]);

  function handleListKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (candidates.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, candidates.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const c = candidates[highlight];
      if (c) setPicked(c);
    }
  }

  const pickCandidate = useCallback((c: Candidate) => setPicked(c), []);

  function handleRowKey(e: React.KeyboardEvent<HTMLLIElement>, c: Candidate) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pickCandidate(c);
    }
  }

  async function submit() {
    if (!picked || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const r = await fetch(
        `/api/session/${encodeURIComponent(predecessorId)}/supersede`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-supersedence-source": "ui",
          },
          body: JSON.stringify({
            successor_id: picked.id,
            ...(reason.trim().length > 0 ? { reason: reason.trim() } : {}),
          }),
        },
      );
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${r.status}`);
      }
      onMarked(picked.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  }

  const headline = useMemo(
    () =>
      predecessorLabel.length > 60
        ? `${predecessorLabel.slice(0, 60)}…`
        : predecessorLabel,
    [predecessorLabel],
  );

  return (
    <>
      <div className="palette-backdrop" onClick={onClose} />
      <div
        ref={dialogRef}
        className="supersede-palette"
        role="dialog"
        aria-modal="true"
        aria-labelledby="supersede-palette-title"
      >
        <header className="palette-head">
          <span id="supersede-palette-title" className="palette-title">Mark superseded</span>
          <button
            type="button"
            className="drawer-close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </header>
        <div className="palette-body">
          <div className="palette-context">
            <span className="palette-context-label">retiring</span>
            <span className="palette-context-value mono small">{headline}</span>
            <span className="palette-context-id mono small">{predecessorId}</span>
          </div>

          {!picked && (
            <>
              <label className="palette-field-label" htmlFor="palette-search">
                Successor — the session that replaces it
              </label>
              <input
                id="palette-search"
                ref={searchRef}
                className="palette-input mono"
                type="text"
                role="combobox"
                aria-expanded={candidates.length > 0}
                aria-controls={listboxId}
                aria-activedescendant={
                  candidates.length > 0 ? `${listboxId}-${highlight}` : undefined
                }
                aria-autocomplete="list"
                placeholder="search by label, decision, or entity"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleListKey}
                autoComplete="off"
                spellCheck={false}
              />
              <ul
                id={listboxId}
                className="palette-list"
                role="listbox"
                aria-label="Successor candidates"
              >
                {candidates.length === 0 && query.trim().length > 0 && !error && (
                  <li className="palette-empty muted small" role="presentation">no matches</li>
                )}
                {candidates.map((c, i) => (
                  <li
                    key={c.id}
                    id={`${listboxId}-${i}`}
                    role="option"
                    tabIndex={0}
                    aria-selected={i === highlight}
                    className={`palette-row${i === highlight ? " palette-row--hot" : ""}`}
                    onMouseEnter={() => setHighlight(i)}
                    onClick={() => pickCandidate(c)}
                    onKeyDown={(e) => handleRowKey(e, c)}
                  >
                    <span className="palette-row-date mono small">
                      {c.startedAt ? c.startedAt.slice(0, 10) : "    -    "}
                    </span>
                    <span className="palette-row-runtime mono small muted">
                      {c.runtime || "—"}
                    </span>
                    <span className="palette-row-label">{c.label}</span>
                    <span className="palette-row-id mono small muted">{c.id}</span>
                  </li>
                ))}
              </ul>
            </>
          )}

          {picked && (
            <>
              <div className="palette-pick">
                <span className="palette-context-label">successor</span>
                <span className="palette-context-value mono small">{picked.label}</span>
                <span className="palette-context-id mono small">{picked.id}</span>
                <button
                  type="button"
                  className="palette-undo"
                  onClick={() => setPicked(null)}
                  disabled={submitting}
                >
                  change
                </button>
              </div>
              <label className="palette-field-label" htmlFor="palette-reason">
                Reason (optional)
              </label>
              <input
                id="palette-reason"
                ref={reasonRef}
                className="palette-input mono"
                type="text"
                placeholder="why this supersedence — logged for audit"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submit();
                }}
                disabled={submitting}
                autoComplete="off"
              />
            </>
          )}

          {error && <div className="palette-error">{error}</div>}
        </div>
        <footer className="palette-foot">
          <span className="palette-hint muted small">
            {picked ? "Enter to confirm · Esc to cancel" : "↑↓ to move · Enter to pick · Esc to cancel"}
          </span>
          <button
            type="button"
            className="palette-confirm"
            disabled={!picked || submitting}
            onClick={submit}
          >
            {submitting ? "marking…" : "mark superseded"}
          </button>
        </footer>
      </div>
    </>
  );
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

function collectFocusables(root: HTMLElement): HTMLElement[] {
  const nodes = Array.from(
    root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  );
  return nodes.filter((n) => !n.hasAttribute("disabled") && n.offsetParent !== null);
}
