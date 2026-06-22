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

export function classifierEgressNotice(provider: string): string | null {
  const endpoint = CLOUD_CLASSIFIER_ENDPOINTS[provider.toLowerCase()];
  if (!endpoint) return null;
  return (
    `session content is sent to ${endpoint} for classification (cloud egress). ` +
    `Set NLM_CLASSIFIER=ollama for local-only classification.`
  );
}
