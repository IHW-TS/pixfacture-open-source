"use client";

import Link from "next/link";

export default function AppTopbar({ onSearch, showNew = true }: { onSearch: () => void; showNew?: boolean }) {
  return (
    <div className="app-shell-topbar">
      <button type="button" className="app-shell-search-trigger" onClick={onSearch} aria-label="Rechercher">
        Rechercher… <span className="muted">Ctrl+K</span>
      </button>
      <div className="app-shell-topbar__actions">
        {showNew && (
          <Link className="btn primary btn--sm" href="/app/new">
            + Nouveau
          </Link>
        )}
      </div>
    </div>
  );
}
