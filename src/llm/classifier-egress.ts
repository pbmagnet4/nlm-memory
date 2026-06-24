/**
 * Data-egress disclosure for the classifier provider.
 *
 * NLM is local-first: embeddings and (by default) classification run on a local
 * Ollama, so nothing leaves the machine. A cloud classifier is opt-in and sends
 * full session content to a third-party API — that crosses the machine trust
 * boundary and must be disclosed wherever the choice is made or active.
 *
 * Returns null for local providers (nothing to disclose), or a one-line notice
 * naming the endpoint that receives session content.
 */

const CLOUD_CLASSIFIER_ENDPOINTS: Readonly<Record<string, string>> = {
  deepseek: "api.deepseek.com",
};

/** A host is local (no egress to disclose) when it's loopback or on a private
 *  LAN / link-local range. Anything else is a public endpoint that receives
 *  session content. */
function isLocalHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".local")) return true;
  if (h === "::1" || h.startsWith("127.")) return true;
  if (h.startsWith("10.") || h.startsWith("192.168.")) return true;
  // 172.16.0.0 – 172.31.255.255
  const m = /^172\.(\d{1,3})\./.exec(h);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  return false;
}

function notice(endpoint: string): string {
  return (
    `session content is sent to ${endpoint} for classification (cloud egress). ` +
    `Set NLM_CLASSIFIER=ollama for local-only classification.`
  );
}

/**
 * Disclose data egress for the active classifier. For preset cloud providers
 * the endpoint is fixed; for the configurable `openai` provider it depends on
 * baseUrl — a LAN/loopback endpoint stays on-network (no disclosure), a public
 * one crosses the trust boundary and is disclosed.
 */
export function classifierEgressNotice(provider: string, baseUrl?: string): string | null {
  const p = provider.toLowerCase();
  if (p === "openai") {
    if (!baseUrl) return null;
    let host: string;
    try {
      host = new URL(baseUrl).hostname;
    } catch {
      return null;
    }
    return isLocalHost(host) ? null : notice(host);
  }
  const endpoint = CLOUD_CLASSIFIER_ENDPOINTS[p];
  return endpoint ? notice(endpoint) : null;
}
