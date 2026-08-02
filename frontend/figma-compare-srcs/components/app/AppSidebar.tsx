import { useEffect, useId, useMemo, useRef, useState, type ComponentType, type SVGProps } from "react";
import { Link, useLocation } from "react-router";
import {
  AlertTriangle,
  Bell,
  Building2,
  ChevronDown,
  CreditCard,
  Download,
  FileText,
  Github,
  Globe,
  HelpCircle,
  Inbox,
  Layout,
  LayoutDashboard,
  LogOut,
  Package,
  Palette,
  Send,
  Settings,
  Shield,
  ShieldCheck,
  Upload,
  Users,
  Wallet,
  Webhook,
} from "lucide-react";
import {
  getAppNavigationModules,
  getProfileNavigationItems,
  isAppModuleActive,
  type AppNavigationBadgeKey,
  type AppNavigationIconKey,
  type AppNavigationModule,
} from "@/lib/appNavigation";
import { useSession } from "@/lib/useSession";
import { useCockpit } from "@/lib/useCockpit";
import { getPlanInfo, getWorkspacePlanBadge } from "@/lib/subscriptionDisplay";
import { getSourceCodeUrl } from "@/lib/sourceCode";

type BadgeValues = Partial<Record<AppNavigationBadgeKey, string>>;
type IconComponent = ComponentType<SVGProps<SVGSVGElement>>;
type SidebarGroup = {
  id: string;
  accent: string;
  items: AppNavigationModule[];
};
type SidebarMenuSection = {
  id: string;
  label: string;
  icon: AppNavigationIconKey;
  accent: string;
  items: AppNavigationModule[];
};

const ICONS: Partial<Record<AppNavigationIconKey, IconComponent>> = {
  dashboard: LayoutDashboard,
  invoices: FileText,
  einvoicing: Shield,
  quotes: Send,
  customers: Users,
  purchases: Inbox,
  cash: Wallet,
  items: Package,
  company: Building2,
  team: Users,
  settings: Settings,
  billing: CreditCard,
  branding: Palette,
  exports: Download,
  migration: Upload,
  portals: Layout,
  dunning: Bell,
  webhooks: Webhook,
  help: HelpCircle,
  admin: ShieldCheck,
  alerts: AlertTriangle,
  automation: Bell,
  integrations: Webhook,
  transmissions: Globe,
  payments: CreditCard,
  receivables: Wallet,
};

function deriveUserLabel(user: any) {
  if (!user) {
    return { initials: "PF", name: "Mon compte" };
  }

  const explicit = String(user?.name || user?.full_name || user?.display_name || "").trim();
  const composed = [user?.first_name, user?.last_name]
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join(" ");
  const email = String(user?.email || "").trim();
  const local = email.split("@")[0] || "compte";
  const fallback = local
    .split(/[._-]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
  const name = explicit || composed || fallback || "Mon compte";
  const initials =
    name
      .split(/\s+/g)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("")
      .slice(0, 2) || "PF";

  return { initials, name };
}

const ROLE_LABELS: Record<string, string> = {
  owner: "Propriétaire",
  admin: "Administrateur",
  accountant: "Comptable",
  sales: "Commercial",
  viewer: "Lecture seule",
  client: "Client",
};

function toBadgeValue(value: number | null | undefined) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
  if (numeric > 99) return "99+";
  return String(numeric);
}

function badgeFor(key: AppNavigationBadgeKey | undefined, badges: BadgeValues) {
  return key ? badges[key] : undefined;
}

function SidebarBadge({ value, tone = "info" }: { value?: string; tone?: "info" | "warning" | "neutral" }) {
  if (!value) return null;
  const palette = {
    info: { background: "rgba(37,99,235,0.95)", color: "#ffffff" },
    warning: { background: "rgba(239,68,68,0.92)", color: "#ffffff" },
    neutral: { background: "rgba(148,163,184,0.20)", color: "#cbd5e1" },
  }[tone];
  return (
    <span
      className="flex-shrink-0 rounded-full px-1.5 py-0.5"
      style={{
        background: palette.background,
        color: palette.color,
        fontSize: "var(--pf-app-text-overline)",
        fontWeight: 800,
        lineHeight: 1.1,
      }}
    >
      {value}
    </span>
  );
}

function buildSidebarGroups(items: AppNavigationModule[]): SidebarGroup[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const pick = (ids: string[]) => ids.map((id) => byId.get(id)).filter(Boolean) as AppNavigationModule[];
  return [
    { id: "essential", accent: "#3b82f6", items: pick(["dashboard"]) },
    {
      id: "activity",
      accent: "#10b981",
      items: pick(["quotes", "invoices", "purchases", "einvoicing"]),
    },
    {
      id: "contacts",
      accent: "#f97316",
      items: pick(["customers", "cash"]),
    },
  ].filter((group) => group.items.length > 0);
}

function isSidebarItemActive(pathname: string, item: AppNavigationModule) {
  if (item.id === "settings") return pathname === item.href;
  return isAppModuleActive(pathname, item);
}

function NavItem({
  item,
  pathname,
  badges,
  groupAccent,
  onNavigate,
}: {
  item: AppNavigationModule;
  pathname: string;
  badges: BadgeValues;
  groupAccent: string;
  onNavigate: () => void;
}) {
  const active = isSidebarItemActive(pathname, item);
  const Icon = ICONS[item.icon] || LayoutDashboard;
  const badge = badgeFor(item.badgeKey, badges);
  const itemAccent = active ? groupAccent : item.accent || groupAccent;
  const badgeTone = item.id === "purchases" ? "info" : item.id === "invoices" ? "neutral" : "info";

  return (
    <Link
      to={item.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={`group relative flex w-full items-center gap-2 rounded-r-xl px-2.5 py-2 text-left transition-all duration-100 ${
        active ? "text-white" : "text-[#9ca9bc] hover:bg-white/[0.07] hover:text-white"
      }`}
      style={{
        background: active ? "rgba(255,255,255,0.12)" : undefined,
        boxShadow: active ? "inset 0 0 0 1px rgba(255,255,255,0.08)" : undefined,
      }}
    >
      {active ? (
        <span
          className="absolute bottom-0 left-[-6px] top-0 w-[3px] rounded-r-full"
          style={{ background: groupAccent }}
        />
      ) : null}
      <Icon
        className="h-[16px] w-[16px] flex-shrink-0 transition-colors"
        style={{ color: active ? itemAccent : "#8b98aa", strokeWidth: active ? 2.2 : 1.7 }}
      />
      <span
        className="min-w-0 flex-1 truncate"
        style={{
          fontSize: "var(--pf-app-text-body)",
          fontWeight: active ? 600 : 500,
          color: active ? "#ffffff" : "#a8b3c4",
          lineHeight: 1.2,
        }}
      >
        {item.label}
      </span>
      <SidebarBadge value={badge} tone={badgeTone} />
    </Link>
  );
}

function SidebarSubItem({
  item,
  pathname,
  groupAccent,
  onNavigate,
}: {
  item: AppNavigationModule;
  pathname: string;
  groupAccent: string;
  onNavigate: () => void;
}) {
  const active = isSidebarItemActive(pathname, item);
  const Icon = ICONS[item.icon] || LayoutDashboard;
  return (
    <Link
      to={item.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={`group relative flex items-center gap-2 rounded-r-lg px-2 py-1.5 transition-colors ${
        active ? "text-white" : "text-[#77849a] hover:bg-white/[0.05] hover:text-[#dbeafe]"
      }`}
    >
      {active ? (
        <span
          className="absolute bottom-1 left-[-9px] top-1 w-[2px] rounded-full"
          style={{ background: groupAccent }}
        />
      ) : null}
      <Icon
        className="h-[13px] w-[13px] flex-shrink-0"
        style={{ color: active ? groupAccent : "#5f6d82", strokeWidth: active ? 2 : 1.6 }}
      />
      <span
        className="min-w-0 flex-1 truncate"
        style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: active ? 540 : 500, lineHeight: 1.25 }}
      >
        {item.label}
      </span>
    </Link>
  );
}

function SidebarMenuGroup({
  section,
  pathname,
  open,
  onToggle,
  onNavigate,
}: {
  section: SidebarMenuSection;
  pathname: string;
  open: boolean;
  onToggle: () => void;
  onNavigate: () => void;
}) {
  const Icon = ICONS[section.icon] || Settings;
  const active =
    (section.id === "settings" ? pathname === "/app/settings" : false) ||
    section.items.some((item) => isSidebarItemActive(pathname, item));

  return (
    <div className="border-t border-white/[0.06] pt-2">
      <button
        type="button"
        onClick={onToggle}
        className={`flex w-full items-center gap-2 rounded-r-xl px-2.5 py-2 text-left transition-colors ${
          active ? "bg-white/[0.08] text-white" : "text-[#8b98aa] hover:bg-white/[0.05] hover:text-[#dbeafe]"
        }`}
        aria-expanded={open}
        aria-controls={`sidebar-menu-${section.id}`}
      >
        <Icon
          className="h-[16px] w-[16px] flex-shrink-0"
          style={{ color: active ? section.accent : "#8b98aa", strokeWidth: active ? 2.2 : 1.7 }}
        />
        <span
          className="min-w-0 flex-1 truncate"
          style={{
            fontSize: "var(--pf-app-text-body)",
            fontWeight: active ? 600 : 500,
            lineHeight: 1.2,
            color: active ? "#ffffff" : "#a8b3c4",
          }}
        >
          {section.label}
        </span>
        <ChevronDown
          className={`h-3.5 w-3.5 flex-shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
          style={{ strokeWidth: 1.6 }}
        />
      </button>
      {open ? (
        <div id={`sidebar-menu-${section.id}`} className="relative ml-3.5 mt-1 space-y-0.5 pl-2.5">
          <span className="absolute bottom-1 left-0 top-1 w-px rounded-full bg-white/[0.06]" aria-hidden="true" />
          {section.items.map((item) => (
            <SidebarSubItem
              key={item.id}
              item={item}
              pathname={pathname}
              groupAccent={section.accent}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function AppSidebar() {
  const location = useLocation();
  const sourceCodeUrl = getSourceCodeUrl();
  const { user, plan, subscriptionStatus } = useSession();
  const { overview } = useCockpit();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [settingsMenuOpen, setSettingsMenuOpen] = useState(true);
  const mobileMenuId = useId();
  const mobileMenuTitleId = `${mobileMenuId}-title`;
  const mobileMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const mobileMenuPanelRef = useRef<HTMLDivElement | null>(null);
  const roleKey =
    String(user?.role || "compte")
      .trim()
      .toLowerCase() || "compte";
  const roleLabel = ROLE_LABELS[roleKey] || "Compte";
  const canManageAccount = ["owner", "admin"].includes(roleKey);
  const canUseAccountingSettings = canManageAccount || roleKey === "accountant";
  const userLabel = deriveUserLabel(user);
  const planName = plan ? getPlanInfo(plan)?.name || "Plan à confirmer" : "Plan à confirmer";
  const planBadge = getWorkspacePlanBadge(plan, subscriptionStatus);
  const badges = useMemo<BadgeValues>(
    () => ({
      invoicesTotal: toBadgeValue(overview?.badges?.invoices_total),
      inboxTotal: toBadgeValue(overview?.badges?.inbox_total),
    }),
    [overview],
  );
  const items = useMemo(() => getAppNavigationModules(user, plan), [plan, user]);
  const profileItems = useMemo(
    () => getProfileNavigationItems({ canSeeAdmin: Boolean(user?.is_admin), session: user }),
    [user],
  );
  const groupedItems = useMemo(() => buildSidebarGroups(items), [items]);
  const settingsMenuItems = useMemo(() => {
    const accountSettings = new Set(["company", "team", "billing"]);
    const accountingSettings = new Set(["accounting-export"]);
    const filteredProfileItems = profileItems.filter((item) => {
      if (accountSettings.has(item.id)) return canManageAccount;
      if (accountingSettings.has(item.id)) return canUseAccountingSettings;
      return true;
    });
    return filteredProfileItems;
  }, [canManageAccount, canUseAccountingSettings, profileItems]);
  const menuSections = useMemo<SidebarMenuSection[]>(
    () =>
      [
        {
          id: "settings",
          label: "Paramètres",
          icon: "settings" as AppNavigationIconKey,
          accent: "#94a3b8",
          items: settingsMenuItems,
        },
      ].filter((section) => section.items.length > 0),
    [settingsMenuItems],
  );
  const closeMenus = () => {
    setMobileOpen(false);
  };
  useEffect(() => {
    if (!mobileOpen) return;
    const previousActiveElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const mobileMenuButton = mobileMenuButtonRef.current;
    const focusableSelector =
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const focusTimer = window.setTimeout(() => {
      const firstFocusable = mobileMenuPanelRef.current?.querySelector<HTMLElement>(focusableSelector);
      firstFocusable?.focus();
    }, 0);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMobileOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        mobileMenuPanelRef.current?.querySelectorAll<HTMLElement>(focusableSelector) || [],
      ).filter((element) => !element.hasAttribute("disabled") && element.tabIndex !== -1);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", handleKeyDown);
      if (previousActiveElement?.isConnected) {
        previousActiveElement.focus();
      } else {
        mobileMenuButton?.focus();
      }
    };
  }, [mobileOpen]);

  const Inner = () => {
    return (
      <div className="flex h-full flex-col" style={{ background: "linear-gradient(180deg,#071427 0%,#0b1220 100%)" }}>
        <div className="flex flex-shrink-0 items-center gap-2.5 px-3.5 pb-3 pt-3.5">
          <div
            className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg shadow-lg"
            style={{ background: "linear-gradient(135deg,#1d4ed8,#6366f1)" }}
          >
            <Shield className="h-4 w-4 text-white" style={{ strokeWidth: 2.2 }} />
          </div>
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <p className="truncate text-white" style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 800 }}>
              PixFacture
            </p>
            {planBadge ? (
              <span
                aria-label={`Formule : ${planBadge.label}`}
                className={`flex-shrink-0 rounded-full border px-1.5 py-0.5 text-[0.5625rem] font-extrabold leading-none ${
                  planBadge.id === "trial"
                    ? "border-[#60a5fa]/45 bg-[#2563eb]/25 text-[#bfdbfe]"
                    : "border-white/15 bg-white/10 text-[#cbd5e1]"
                }`}
              >
                {planBadge.label}
              </span>
            ) : null}
          </div>
        </div>

        <nav
          className="flex-1 overflow-y-auto px-1.5 py-2.5"
          aria-label="Navigation principale"
          style={{ scrollbarWidth: "none" }}
        >
          {groupedItems.map((group, groupIndex) => {
            const groupActive = group.items.some((item) => isSidebarItemActive(location.pathname, item));
            return (
              <div
                key={group.id}
                data-testid={`sidebar-group-${group.id}`}
                className={`${groupIndex > 0 ? "mt-3 border-t border-white/10 pt-3" : ""} relative space-y-1 pl-1`}
              >
                <span
                  className="absolute bottom-1 left-0 top-1 w-px rounded-full"
                  style={{ background: groupActive ? group.accent : "rgba(148,163,184,0.20)" }}
                />
                {group.items.map((item) => (
                  <NavItem
                    key={item.id}
                    item={item}
                    pathname={location.pathname}
                    badges={badges}
                    groupAccent={group.accent}
                    onNavigate={closeMenus}
                  />
                ))}
              </div>
            );
          })}

          <div className="mt-3 space-y-2 pl-1">
            {menuSections.map((section) => (
              <SidebarMenuGroup
                key={section.id}
                section={section}
                pathname={location.pathname}
                open={settingsMenuOpen}
                onToggle={() => setSettingsMenuOpen((value) => !value)}
                onNavigate={closeMenus}
              />
            ))}
          </div>
        </nav>

        <div className="relative flex-shrink-0 border-t border-white/10 px-2.5 py-2.5">
          <a
            href={sourceCodeUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={closeMenus}
            className="mb-2 flex items-center gap-2 rounded-lg px-2 py-1.5 text-[#94a3b8] transition-colors hover:bg-white/[0.07] hover:text-white"
            style={{ fontSize: "var(--pf-app-text-caption)" }}
          >
            <Github className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Code source (AGPL)</span>
          </a>
          <div className="flex items-center gap-2.5">
            <Link
              to="/app/account"
              onClick={closeMenus}
              className="group flex min-w-0 flex-1 items-center gap-2.5 rounded-xl px-1.5 py-1 transition-colors hover:bg-white/[0.07]"
              aria-label="Ouvrir mon compte"
              title="Mon compte"
            >
              <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[#3b82f6] to-[#8b5cf6] shadow-sm transition-transform group-hover:scale-[1.03]">
                <span className="text-white" style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 800 }}>
                  {userLabel.initials}
                </span>
              </div>
              <div className="min-w-0 flex-1 text-left">
                <p className="truncate text-white" style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 800 }}>
                  {userLabel.name}
                </p>
                <p className="truncate text-[#94a3b8]" style={{ fontSize: "var(--pf-app-text-caption)" }}>
                  {roleLabel} · {planName}
                </p>
              </div>
            </Link>
            <Link
              to="/app/logout"
              onClick={closeMenus}
              className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl bg-white/10 text-white shadow-sm transition-colors hover:bg-white/15"
              aria-label="Déconnexion"
              title="Déconnexion"
            >
              <LogOut className="h-4 w-4" style={{ strokeWidth: 2 }} />
            </Link>
          </div>
        </div>
      </div>
    );
  };

  return (
    <>
      <button
        type="button"
        ref={mobileMenuButtonRef}
        onClick={() => setMobileOpen(true)}
        className="fixed left-3 top-2.5 z-50 flex h-9 w-9 flex-col items-center justify-center gap-1 rounded-xl shadow-sm lg:hidden"
        style={{ background: "#eff6ff", border: "1px solid #60a5fa" }}
        aria-label="Ouvrir le menu de navigation"
        aria-expanded={mobileOpen}
        aria-controls={mobileOpen ? mobileMenuId : undefined}
      >
        <span aria-hidden="true" className="block h-px w-4 bg-[#1d4ed8]" />
        <span aria-hidden="true" className="block h-px w-3 bg-[#2563eb]" />
        <span aria-hidden="true" className="block h-px w-4 bg-[#1d4ed8]" />
      </button>

      {mobileOpen ? (
        <div
          id={mobileMenuId}
          className="fixed inset-0 z-40 lg:hidden"
          role="dialog"
          aria-modal="true"
          aria-labelledby={mobileMenuTitleId}
          onClick={closeMenus}
        >
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
          <div
            ref={mobileMenuPanelRef}
            className="absolute bottom-0 left-0 top-0 w-[270px] max-w-[85vw] shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id={mobileMenuTitleId} className="sr-only">
              Menu de navigation
            </h2>
            <Inner />
          </div>
        </div>
      ) : null}

      <aside
        className="sticky top-0 z-20 hidden h-screen w-[208px] flex-shrink-0 lg:block"
        style={{
          background: "linear-gradient(180deg,#071427 0%,#0b1220 100%)",
          boxShadow: "1px 0 0 rgba(15,23,42,0.55)",
        }}
      >
        <Inner />
      </aside>
    </>
  );
}
