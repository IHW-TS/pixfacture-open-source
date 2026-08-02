import { createHashRouter, Navigate } from "react-router";
import { createElement, lazy, Suspense, type ComponentType } from "react";

// Lazy helper: wraps a named export in React.lazy + Suspense
function L<P extends Record<string, unknown> = Record<string, never>>(
  factory: () => Promise<Record<string, ComponentType<any>>>,
  name: string,
): ComponentType<P> {
  const LazyComp = lazy(() => factory().then((m) => ({ default: m[name] as ComponentType<any> })));
  return function LazyRoute(props: P) {
    return createElement(Suspense, { fallback: createElement("div") }, createElement(LazyComp, props));
  } as ComponentType<P>;
}

// ── Landing page (also lazy-loaded to keep initial bundle small) ──
const LandingPage = L(() => import("./pages/LandingPage"), "LandingPage");

// ── Marketing pages ──
const SecurityPage = L(() => import("./pages/SecurityPage"), "SecurityPage");
const DpaPage = L(() => import("./pages/DpaPage"), "DpaPage");
const TermsPage = L(() => import("./pages/TermsPage"), "TermsPage");
const PrivacyPage = L(() => import("./pages/PrivacyPage"), "PrivacyPage");
const CookiesPage = L(() => import("./pages/CookiesPage"), "CookiesPage");
const MentionsPage = L(() => import("./pages/MentionsPage"), "MentionsPage");
const ConfiancePage = L(() => import("./pages/ConfiancePage"), "ConfiancePage");
const FaqPage = L(() => import("./pages/FaqPage"), "FaqPage");
const NotFoundPage = L(() => import("./pages/NotFoundPage"), "NotFoundPage");
const FeaturesPage = L(() => import("./pages/FeaturesPage"), "FeaturesPage");
const PricingPage = L(() => import("./pages/PricingPage"), "PricingPage");

// ── Extra marketing & legal ──
const mep = () => import("./pages/MarketingExtraPages");
const ContactPage = L(mep, "ContactPage");
const ConformiteMarketingPage = L(mep, "ConformiteMarketingPage");
const Conformite2026Page = L(mep, "Conformite2026Page");
const CompatibiliteEinvoicingPage = L(mep, "CompatibiliteEinvoicingPage");
const PlateformesPage = L(mep, "PlateformesPage");
const TrustPage = L(mep, "TrustPage");
const BillingSuccessPage = L(mep, "BillingSuccessPage");
const BillingCancelPage = L(mep, "BillingCancelPage");
const EinvoicingScopePage = L(mep, "EinvoicingScopePage");
const SlaPage = L(mep, "SlaPage");

// ── Portal pages ──
const pp = () => import("./pages/PortalPages");
const ClientPortalPage = L(pp, "ClientPortalPage");
const PortalInvoiceDetailPage = L(pp, "PortalInvoiceDetailPage");
const PortalQuoteDetailPage = L(pp, "PortalQuoteDetailPage");
const InvitePortalPage = L(pp, "InvitePortalPage");
const QuotePortalPage = L(pp, "QuotePortalPage");

// ── Auth pages ──
const LoginPage = L(() => import("./pages/auth/LoginPage"), "LoginPage");
const RegisterPage = L(() => import("./pages/auth/RegisterPage"), "RegisterPage");
const PasswordResetPage = L(() => import("./pages/auth/PasswordResetPage"), "PasswordResetPage");
const PasswordResetConfirmPage = L(() => import("./pages/auth/PasswordResetPage"), "PasswordResetConfirmPage");
const InvitePage = L(() => import("./pages/auth/InvitePage"), "InvitePage");
const VerifyEmailPage = L(() => import("./pages/auth/VerifyEmailPage"), "VerifyEmailPage");

// ── App layout ──
const AppLayout = L(() => import("./components/app/AppLayout"), "AppLayout");

// ── Post-login pages ──
const DashboardPage = L(() => import("./pages/app/DashboardPage"), "DashboardPage");

const ip = () => import("./pages/app/InvoicesPage");
const InvoicesListPage = L(ip, "InvoicesListPage");
const InvoiceDetailPage = L(ip, "InvoiceDetailPage");
const InvoiceNewPage = L(ip, "InvoiceNewPage");

const cp = () => import("./pages/app/CustomersPage");
const CustomersListPage = L(cp, "CustomersListPage");
const CustomerDetailPage = L(cp, "CustomerDetailPage");
const CustomerNewPage = L(cp, "CustomerNewPage");

const qp = () => import("./pages/app/QuotesPage");
const QuotesListPage = L(qp, "QuotesListPage");
const QuoteDetailPage = L(qp, "QuoteDetailPage");
const QuoteNewPage = L(qp, "QuoteNewPage");

const CompanyPage = L(() => import("./pages/app/CompanyPage"), "CompanyPage");
const BillingPage = L(() => import("./pages/app/BillingPage"), "BillingPage");

const sp = () => import("./pages/app/SettingsPages");
const SettingsBrandingPage = L(sp, "SettingsBrandingPage");
const SettingsSecurityPage = L(sp, "SettingsSecurityPage");
const SettingsExportPage = L(sp, "SettingsExportPage");
const SettingsPortalsPage = L(sp, "SettingsPortalsPage");
const SettingsSandboxPage = L(sp, "SettingsSandboxPage");
const SettingsAttachmentsPage = L(sp, "SettingsAttachmentsPage");
const SettingsGenericPage = L<{ title: string; breadcrumb: string; desc: string }>(sp, "SettingsGenericPage");

const ep = () => import("./pages/app/EinvoicingPages");
const uep = () => import("./pages/app/UnifiedEinvoicingPage");
const UnifiedEinvoicingPage = L(uep, "UnifiedEinvoicingPage");
const EReportingPage = L(ep, "EReportingPage");
const InboxPage = L(ep, "InboxPage");
const DirectoryPage = L(ep, "DirectoryPage");
const ConformiteAppPage = L(ep, "ConformiteAppPage");
const IntegrationsPage = L(ep, "IntegrationsPage");

const ap = () => import("./pages/app/AdminPages");
const AdminDashboardPage = L(ap, "AdminDashboardPage");
const AdminTenantsPage = L(ap, "AdminTenantsPage");
const AdminTenantDetailPage = L(ap, "AdminTenantDetailPage");
const AdminReadinessPage = L(ap, "AdminReadinessPage");
const AdminDeploymentPage = L(ap, "AdminDeploymentPage");
const AdminLegalPackPage = L(ap, "AdminLegalPackPage");
const AdminUsageSeqinoPage = L(ap, "AdminUsageSeqinoPage");
const AdminDiagnosticPage = L(ap, "AdminDiagnosticPage");

const mp = () => import("./pages/app/MiscPages");
const itemsPage = () => import("../src/figma/app/pages/app/MiscPages");
const AuditPage = L(mp, "AuditPage");
const AccountPage = L(mp, "AccountPage");
const TeamPage = L(mp, "TeamPage");
const ItemsPage = L(itemsPage, "ItemsPage");
const GetStartedPage = L(mp, "GetStartedPage");
const OnboardingPage = L(mp, "OnboardingPage");
const NewDocumentPage = L(mp, "NewDocumentPage");
const SessionDebugPage = L(mp, "SessionDebugPage");
const PortalPage = L(mp, "PortalPage");
const SetupPage = L(mp, "SetupPage");
const PaywallPage = L(mp, "PaywallPage");

// ── Advanced / Wave-32 pages ──
const adv = () => import("./pages/app/AdvancedPages");
const PurchasesPage = InboxPage;
const PurchaseDetailPage = InboxPage;
const CashPage = L(adv, "CashPage");
const PortfolioPage = L(adv, "PortfolioPage");
const RecurringPage = L(adv, "RecurringPage");
const TasksPage = L(adv, "TasksPage");
const NotificationsPage = L(adv, "NotificationsPage");
const AutomationsPage = L(adv, "AutomationsPage");
const CampaignsPage = L(adv, "CampaignsPage");
const OutboxPage = L(adv, "OutboxPage");
const SchedulerPage = L(adv, "SchedulerPage");

// Helpers
function SGEl(title: string, breadcrumb: string, desc: string) {
  return createElement(SettingsGenericPage, { title, breadcrumb, desc });
}

function Redir(to: string) {
  return createElement(Navigate, { to, replace: true });
}

export const router = createHashRouter([
  // ── Marketing / Public ──
  { path: "/", Component: LandingPage },
  { path: "/features", Component: FeaturesPage },
  { path: "/pricing", Component: PricingPage },
  { path: "/faq", Component: FaqPage },
  { path: "/security", Component: SecurityPage },
  { path: "/confiance", Component: ConfiancePage },
  { path: "/contact", Component: ContactPage },
  { path: "/conformite", Component: ConformiteMarketingPage },
  { path: "/conformite-2026", Component: Conformite2026Page },
  { path: "/compatibilite-einvoicing", Component: CompatibiliteEinvoicingPage },
  { path: "/plateformes", Component: PlateformesPage },
  { path: "/trust", Component: TrustPage },
  { path: "/login", element: Redir("/app/login") },
  { path: "/register", element: Redir("/app/register") },
  { path: "/billing/success", Component: BillingSuccessPage },
  { path: "/billing/cancel", Component: BillingCancelPage },

  // ── Legal ──
  { path: "/legal/dpa", Component: DpaPage },
  { path: "/legal/terms", Component: TermsPage },
  { path: "/legal/privacy", Component: PrivacyPage },
  { path: "/legal/cookies", Component: CookiesPage },
  { path: "/legal/mentions", Component: MentionsPage },
  { path: "/legal/cgv", Component: TermsPage },
  { path: "/legal/cgu", Component: TermsPage },
  { path: "/legal/confidentialite", Component: PrivacyPage },
  { path: "/legal/mentions-legales", Component: MentionsPage },
  { path: "/legal/einvoicing-scope", Component: EinvoicingScopePage },
  { path: "/legal/sla", Component: SlaPage },
  { path: "/legal/security", Component: SecurityPage },

  // ── Portal ──
  { path: "/c/:token", Component: ClientPortalPage },
  { path: "/c/:token/invoices/:invoiceId", Component: PortalInvoiceDetailPage },
  { path: "/c/:token/quotes/:quoteId", Component: PortalQuoteDetailPage },
  { path: "/i/:token", Component: InvitePortalPage },
  { path: "/q/:token", Component: QuotePortalPage },

  // ── Auth ──
  { path: "/app/login", Component: LoginPage },
  { path: "/app/register", Component: RegisterPage },
  { path: "/app/password-reset", Component: PasswordResetPage },
  { path: "/app/password-reset/confirm", Component: PasswordResetConfirmPage },
  { path: "/app/invite", Component: InvitePage },
  { path: "/app/invites/accept", Component: InvitePage },
  { path: "/app/verify-email", Component: VerifyEmailPage },

  // ── App (post-login with sidebar) ──
  {
    path: "/app",
    Component: AppLayout,
    children: [
      { index: true, Component: DashboardPage },
      { path: "dashboard", Component: DashboardPage },
      // Core vente
      { path: "invoices", Component: InvoicesListPage },
      { path: "invoices/new", Component: InvoiceNewPage },
      { path: "invoices/:id", Component: InvoiceDetailPage },
      { path: "customers", Component: CustomersListPage },
      { path: "customers/new", Component: CustomerNewPage },
      { path: "customers/:id", Component: CustomerDetailPage },
      { path: "quotes", Component: QuotesListPage },
      { path: "quotes/new", Component: QuoteNewPage },
      { path: "quotes/:id", Component: QuoteDetailPage },
      { path: "company", Component: CompanyPage },
      { path: "billing", Component: BillingPage },
      { path: "billing/paywall", Component: PaywallPage },
      { path: "new", Component: NewDocumentPage },
      { path: "onboarding", Component: OnboardingPage },
      { path: "get-started", Component: GetStartedPage },
      // Vente / exploitation
      { path: "payments", Component: CashPage },
      { path: "purchases", Component: PurchasesPage },
      { path: "purchases/:id", Component: PurchaseDetailPage },
      { path: "cash", Component: CashPage },
      // Pilotage avancé
      { path: "portfolio", Component: PortfolioPage },
      { path: "recurring", Component: RecurringPage },
      { path: "receivables", element: createElement(Navigate, { to: "/app/invoices?status=overdue", replace: true }) },
      { path: "tasks", Component: TasksPage },
      { path: "notifications", Component: NotificationsPage },
      { path: "automations", Component: AutomationsPage },
      { path: "campaigns", Component: CampaignsPage },
      { path: "outbox", Component: OutboxPage },
      { path: "scheduler", Component: SchedulerPage },
      // Catalogue retiré de la navigation produit publique.
      { path: "items", element: createElement(Navigate, { to: "/app/dashboard", replace: true }) },
      { path: "team", Component: TeamPage },
      { path: "account", Component: AccountPage },
      { path: "audit", Component: AuditPage },
      { path: "session-debug", Component: SessionDebugPage },
      { path: "portal", Component: PortalPage },
      { path: "pdp", element: createElement(Navigate, { to: "/app/einvoicing", replace: true }) },
      { path: "setup", Component: SetupPage },
      { path: "setup/einvoicing", element: createElement(Navigate, { to: "/app/einvoicing", replace: true }) },
      { path: "diagnostic", Component: AdminDiagnosticPage },
      // E-facturation / réforme
      { path: "conformite", Component: ConformiteAppPage },
      { path: "b2b-einvoicing", element: createElement(Navigate, { to: "/app/einvoicing", replace: true }) },
      { path: "e-reporting", Component: EReportingPage },
      { path: "inbox", Component: PurchasesPage }, // alias → purchases
      { path: "inbox/:id", Component: PurchaseDetailPage }, // alias → purchases/:id
      { path: "einvoicing", Component: UnifiedEinvoicingPage },
      { path: "directory", Component: DirectoryPage },
      { path: "transmissions", element: createElement(Navigate, { to: "/app/einvoicing", replace: true }) },
      { path: "integrations", Component: IntegrationsPage },
      { path: "client-invoices", Component: PortalPage },
      // Settings
      { path: "settings", element: createElement(Navigate, { to: "/app/company", replace: true }) },
      { path: "settings/company", Component: CompanyPage },
      { path: "settings/billing", Component: BillingPage },
      { path: "settings/branding", Component: SettingsBrandingPage },
      { path: "settings/security", Component: SettingsSecurityPage },
      { path: "settings/export", Component: SettingsExportPage },
      { path: "settings/migration", element: createElement(Navigate, { to: "/app/customers", replace: true }) },
      { path: "settings/platforms", Component: SettingsPlatformsPage },
      { path: "settings/webhooks", element: createElement(Navigate, { to: "/app/company", replace: true }) },
      { path: "settings/portals", Component: SettingsPortalsPage },
      { path: "settings/sandbox", Component: SettingsSandboxPage },
      {
        path: "settings/dunning",
        element: createElement(Navigate, { to: "/app/invoices?status=overdue", replace: true }),
      },
      { path: "settings/attachments", Component: SettingsAttachmentsPage },
      // Admin
      { path: "admin", Component: AdminDashboardPage },
      { path: "admin/tenants", Component: AdminTenantsPage },
      { path: "admin/tenants/:id", Component: AdminTenantDetailPage },
      { path: "admin/readiness", Component: AdminReadinessPage },
      { path: "admin/deployment", Component: AdminDeploymentPage },
      { path: "admin/legal-pack", Component: AdminLegalPackPage },
      { path: "admin/usage-pdp", Component: AdminUsageSeqinoPage },
      { path: "admin/usage-seqino", element: createElement(Navigate, { to: "/app/admin/usage-pdp", replace: true }) },
      { path: "admin/diagnostic", Component: AdminDiagnosticPage },
      { path: "admin/integrations", Component: IntegrationsPage }, // alias
    ],
  },

  // ── Admin root redirects ──
  { path: "/admin", element: Redir("/app/admin") },
  { path: "/admin/readiness", element: Redir("/app/admin/readiness") },
  { path: "/admin/tenants", element: Redir("/app/admin/tenants") },
  { path: "/admin/tenants/:id", element: Redir("/app/admin/tenants") },
  { path: "/admin/usage-pdp", element: Redir("/app/admin/usage-pdp") },
  { path: "/admin/usage-seqino", element: Redir("/app/admin/usage-pdp") },

  // Catch-all 404
  { path: "*", Component: NotFoundPage },
]);
