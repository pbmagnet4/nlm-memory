export type ValueSource = "setting" | "env" | "default";

/** Where an effective setting comes from, with a Reset (clear the stored setting) when it is a saved one. */
export function SourceBadge({ source, onReset, disabled }: { source: ValueSource; onReset?: () => void; disabled?: boolean }) {
  return (
    <>
      <span className="source-badge" data-source={source}>{source}</span>
      {source === "setting" && onReset && (
        <button type="button" className="btn small" onClick={onReset} disabled={disabled}>Reset</button>
      )}
    </>
  );
}
