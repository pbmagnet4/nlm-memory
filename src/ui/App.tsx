import { NavLink, Route, Routes, Navigate } from "react-router-dom";
import { LivePage } from "./pages/Live.js";
import { StubPage } from "./pages/Stub.js";

const NAV = [
  { to: "/live", label: "live" },
  { to: "/pulse", label: "pulse" },
  { to: "/river", label: "river" },
  { to: "/thread", label: "thread" },
  { to: "/search", label: "search" },
  { to: "/settings", label: "settings" },
];

export function App() {
  return (
    <>
      <nav>
        <span className="brand">nle</span>
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} className={({ isActive }) => (isActive ? "active" : "")}>
            {n.label}
          </NavLink>
        ))}
      </nav>
      <main>
        <Routes>
          <Route path="/" element={<Navigate to="/live" replace />} />
          <Route path="/live" element={<LivePage />} />
          <Route path="/pulse" element={<StubPage page="pulse" />} />
          <Route path="/river" element={<StubPage page="river" />} />
          <Route path="/thread" element={<StubPage page="thread" />} />
          <Route path="/search" element={<StubPage page="search" />} />
          <Route path="/settings" element={<StubPage page="settings" />} />
          <Route path="/settings/labels" element={<StubPage page="settings/labels" />} />
          <Route path="/settings/classifier" element={<StubPage page="settings/classifier" />} />
          <Route path="/settings/data" element={<StubPage page="settings/data" />} />
          <Route path="/settings/views" element={<StubPage page="settings/views" />} />
          <Route path="*" element={<StubPage page="not found" />} />
        </Routes>
      </main>
    </>
  );
}
