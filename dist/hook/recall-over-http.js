/**
 * Shared HTTP recall client for hook entrypoints (Claude Code script, pi extension).
 *
 * Keyword (FTS5) only — hybrid would round-trip through Ollama embedding
 * (~5s warm), too slow to block a user prompt.
 */
import { hookAuthHeaders } from "./hook-auth.js";
export const RECALL_LIMIT = 5;
export const RECALL_TIMEOUT_MS = 2000;
export async function recallOverHttp(prompt) {
    const portValue = process.env["NLM_PORT"] ?? "3940";
    const url = `http://localhost:${portValue}/api/recall` +
        `?q=${encodeURIComponent(prompt)}&mode=keyword&limit=${RECALL_LIMIT}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RECALL_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            headers: hookAuthHeaders({ "x-recall-source": "hook" }),
            signal: controller.signal,
        });
        if (!res.ok)
            return [];
        let body;
        try {
            body = (await res.json());
        }
        catch {
            return [];
        }
        return (body.results ?? []).map((r) => ({
            id: r.id,
            label: r.label,
            startedAt: r.startedAt,
            matchScore: r.matchScore,
        }));
    }
    finally {
        clearTimeout(timer);
    }
}
//# sourceMappingURL=recall-over-http.js.map