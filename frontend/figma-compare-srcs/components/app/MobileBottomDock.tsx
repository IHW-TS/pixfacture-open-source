import { Link, useLocation } from "react-router";
import { FileText, Inbox, LayoutDashboard, Plus, Search, Users, Wallet, type LucideIcon } from "lucide-react";
import {
  APP_CLIENT_NAVIGATION_ITEMS,
  APP_MOBILE_DOCK_ITEMS,
  canAccessNavigationItemForPlan,
  isAppPathActive,
  type AppNavigationIconKey,
  type AppMobileDockItem,
} from "@/lib/appNavigation";
import { canAccessAppPath, normalizeAppRole } from "@/lib/permissions";
import { useSession } from "@/lib/useSession";

const ICONS: Partial<Record<AppNavigationIconKey, LucideIcon>> = {
  dashboard: LayoutDashboard,
  invoices: FileText,
  purchases: Inbox,
  create: Plus,
  customers: Users,
  cash: Wallet,
};

export function MobileBottomDock({ onSearch }: { onSearch?: () => void }) {
  const location = useLocation();
  const { user, plan } = useSession();
  const hiddenPaths = ["/app/invoices/new", "/app/quotes/new"];
  if (hiddenPaths.some((path) => location.pathname.startsWith(path))) return null;
  const items: AppMobileDockItem[] =
    normalizeAppRole(user) === "client"
      ? APP_CLIENT_NAVIGATION_ITEMS.map((item) => ({ ...item, primary: false }))
      : APP_MOBILE_DOCK_ITEMS.filter(
          (item) => canAccessAppPath(user, item.href) && canAccessNavigationItemForPlan(item.id, plan),
        );

  return (
    <nav
      className="safe-area-bottom fixed bottom-0 left-0 right-0 z-40 border-t border-[#e2e8f0] lg:hidden"
      style={{ background: "rgba(255,255,255,0.97)", backdropFilter: "blur(12px)" }}
      aria-label="Navigation mobile"
    >
      {onSearch ? (
        <button
          type="button"
          onClick={onSearch}
          className="absolute -top-12 right-4 flex h-10 w-10 items-center justify-center rounded-2xl border border-[#bfdbfe] bg-white text-[#1d4ed8] shadow-[0_8px_22px_rgba(15,23,42,0.16)] transition hover:bg-[#eff6ff] focus:outline-none focus:ring-2 focus:ring-[#bfdbfe]"
          aria-label="Ouvrir la recherche globale"
        >
          <Search className="h-4 w-4" />
        </button>
      ) : null}
      <div className="flex items-center justify-around px-2 py-2">
        {items.map((item) => {
          const Icon = ICONS[item.icon] || LayoutDashboard;
          const active = isAppPathActive(location.pathname, item.href, item.match);
          if (item.primary) {
            return (
              <Link
                key={item.id}
                to={item.href}
                aria-current={active ? "page" : undefined}
                className="-mt-4 flex flex-col items-center gap-1"
              >
                <div
                  className="flex h-12 w-12 items-center justify-center rounded-2xl shadow-[0_4px_16px_rgba(29,78,216,0.35)]"
                  style={{ background: "linear-gradient(135deg,#1d4ed8,#4f46e5)" }}
                >
                  <Icon className="h-5 w-5 text-white" />
                </div>
                <span className="text-[#94a3b8]" style={{ fontSize: "var(--pf-app-text-overline)", fontWeight: 500 }}>
                  {item.label}
                </span>
              </Link>
            );
          }
          return (
            <Link
              key={item.id}
              to={item.href}
              aria-current={active ? "page" : undefined}
              className="flex flex-col items-center gap-1 px-2 py-1"
            >
              <Icon
                className={`h-5 w-5 transition-colors ${active ? "text-[#1d4ed8]" : "text-[#94a3b8]"}`}
                style={{ strokeWidth: active ? 2.2 : 1.8 }}
              />
              <span
                style={{
                  fontSize: "var(--pf-app-text-overline)",
                  fontWeight: active ? 650 : 450,
                  color: active ? "#1d4ed8" : "#94a3b8",
                }}
              >
                {item.label}
              </span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
