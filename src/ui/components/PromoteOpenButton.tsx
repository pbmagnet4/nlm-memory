import { useState } from "react";
import { postAction } from "../lib/actions.js";

interface PromoteOpenButtonProps {
  openId: string;
  defaultText: string;
  onPromoted: () => void | Promise<void>;
}

/**
 * Inline "flip → decision" control for an open question.
 * Click → expands a small editor pre-filled with the original text;
 * the user accepts as-is or rewords, then submits. POSTs a
 * `promote_open` action which the dataset overlay projects as a
 * decision on the next read.
 */
export function PromoteOpenButton({ openId, defaultText, onPromoted }: PromoteOpenButtonProps) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [value, setValue] = useState(defaultText);

  const submit = async () => {
    const resolution = value.trim();
    if (!resolution) return;
    setBusy(true);
    try {
      await postAction({
        kind: "promote_open",
        subject_type: "open_question",
        subject_id: openId,
        payload: { resolution, original_text: defaultText },
      });
      await onPromoted();
      setEditing(false);
    } catch {
      setBusy(false);
    }
  };

  if (!editing) {
    return (
      <button type="button" className="chip promote-chip" onClick={() => { setValue(defaultText); setEditing(true); }}>
        → decision
      </button>
    );
  }

  return (
    <div className="promote-editor" onClick={(e) => e.stopPropagation()}>
      <input
        className="form-input form-input-inline promote-input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); void submit(); }
          if (e.key === "Escape") { e.preventDefault(); setEditing(false); }
        }}
        disabled={busy}
        autoFocus
      />
      <button type="button" className="chip" onClick={() => void submit()} disabled={busy || !value.trim()}>save</button>
      <button type="button" className="chip" onClick={() => setEditing(false)} disabled={busy}>cancel</button>
    </div>
  );
}
