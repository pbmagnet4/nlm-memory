import { NavLink } from "react-router-dom";

const ITEMS = [
  { to: "/settings",            label: "Overview" },
  { to: "/settings/sources",    label: "Sources" },
  { to: "/settings/providers",  label: "Providers" },
  { to: "/settings/classifier", label: "Classifier" },
  { to: "/settings/labels",     label: "Topics" },
  { to: "/settings/data",       label: "Data" },
  { to: "/settings/views",      label: "Views" },
];

export function SettingsSubnav() {
  return (
    <div className="subnav">
      {ITEMS.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.to === "/settings"}
          className={({ isActive }) => `subnav-link${isActive ? " active" : ""}`}
        >
          {item.label}
        </NavLink>
      ))}
    </div>
  );
}
