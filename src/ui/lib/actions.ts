/**
 * Action client. POSTs to /api/action; callers refetch the dataset to see
 * the overlay re-applied. Returns the new action id so callers can stash
 * it for undo.
 */

export interface ActionPayload {
  kind: string;
  subject_type: string;
  subject_id: string;
  payload?: Record<string, unknown>;
  actor?: string;
  runtime?: string;
}

export async function postAction(input: ActionPayload): Promise<string> {
  const res = await fetch("/api/action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...input, runtime: input.runtime ?? "web-ui" }),
  });
  if (!res.ok) throw new Error(`POST /api/action → ${res.status}`);
  const data = (await res.json()) as { id: string };
  return data.id;
}

export async function undoAction(actionId: string): Promise<void> {
  const res = await fetch(`/api/action/${encodeURIComponent(actionId)}/undo`, { method: "POST" });
  if (!res.ok) throw new Error(`undo → ${res.status}`);
}
