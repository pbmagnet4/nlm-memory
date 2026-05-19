export function StubPage({ page }: { page: string }) {
  return (
    <div className="placeholder">
      <p>/{page} is not yet ported from the Python Astro UI.</p>
      <p>Tracked in NocoDB #95 (Vite + React SPA port).</p>
    </div>
  );
}
