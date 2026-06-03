import { Link } from "react-router-dom";
import { SettingsSubnav } from "./SettingsSubnav.js";
import { useDataset } from "../../lib/dataset.js";

interface Card {
  to: string;
  title: string;
  body: (info: { sessions: number; entities: number; classifierProvider: string | null }) => string;
}

const CARDS: Card[] = [
  {
    to: "/settings/sources",
    title: "Sources",
    body: () => "Transcript origins the daemon scans. Add Claude Code, Hermes, pi.dev, custom JSONL directories, or webhook ingest.",
  },
  {
    to: "/settings/providers",
    title: "Providers",
    body: () => "LLM endpoints (DeepSeek, Ollama, OpenAI, Anthropic, OpenRouter, custom). Manage keys and test connections.",
  },
  {
    to: "/settings/labels",
    title: "Topics",
    body: ({ entities }) => `${entities} topics catalogued. Promote candidates and edit types.`,
  },
  {
    to: "/settings/classifier",
    title: "Classifier",
    body: ({ classifierProvider }) =>
      classifierProvider ? `Active provider: ${classifierProvider}.` : "Classifier provider unknown.",
  },
  {
    to: "/settings/data",
    title: "Data",
    body: ({ sessions }) => `${sessions} sessions in the canonical store. Inspect path and backup posture.`,
  },
  {
    to: "/settings/views",
    title: "Views",
    body: () => "Default landing page, density, sort, density tier.",
  },
];

export function SettingsIndexPage() {
  const { data } = useDataset();
  const info = {
    sessions: data?.meta.sessions_total ?? 0,
    entities: data?.meta.entities_total ?? 0,
    classifierProvider: null,
  };
  return (
    <div className="page-pad">
      <SettingsSubnav />
      <div className="settings-grid">
        {CARDS.map((c) => (
          <Link key={c.to} to={c.to} className="card card-lift settings-card">
            <h3 className="settings-card-title">{c.title}</h3>
            <p className="settings-card-body">{c.body(info)}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
