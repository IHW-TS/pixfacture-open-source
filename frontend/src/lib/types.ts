export type ApiError = Error & {
  code?: string;
  status?: number;
  hint?: string;
  help_url?: string;
  remediation_url?: string;
  error_id?: string;
  errors?: unknown[];
  fields?: string[];
  required?: unknown[];
};

export type TenantPortalSettings = {
  theme?: "blue" | "indigo" | "emerald" | "orange" | "rose" | "slate" | "violet";
  card_payments?: boolean;
  show_credit_notes?: boolean;
  quote_convert_mode?: "auto_issue" | "create_draft" | "disabled";
  support_email?: string | null;
  footer_note?: string | null;
};

export type TenantFeatureFlags = {
  [key: string]: boolean | TenantPortalSettings | undefined;
  portal?: TenantPortalSettings;
};

export type TenantSettings = {
  preset: string;
  features: TenantFeatureFlags;
  onboarding_completed: boolean;
};

export type ProductCapabilities = {
  reform_preparation?: string | null;
  plan?: string | null;
  billing_enabled: boolean;
  einvoicing_available_by_plan?: boolean;
  chorus_available_by_plan?: boolean;
  seqino_available_by_plan?: boolean;
  token_topup_available_by_plan?: boolean;
  purchases_available_by_plan?: boolean;
  payments_available_by_plan?: boolean;
  einvoicing_operational?: boolean;
  chorus_operational?: boolean;
  seqino_operational?: boolean;
  einvoicing_enabled: boolean;
  chorus_enabled: boolean;
  seqino_enabled: boolean;
  token_topup_enabled: boolean;
  purchases_enabled: boolean;
  payments_enabled: boolean;
  upgrade_plan?: string | null;
};

export type SessionUser = {
  id: string;
  email: string;
  role?: string | null;
  tenant_id?: string | null;
  tenant_name?: string | null;
  company_name?: string | null;
  is_admin?: boolean;
  is_platform_admin?: boolean;
  is_support?: boolean;
  mfa_enabled?: boolean;
  plan?: string | null;
  subscription_status?: string | null;
  trial_end?: string | null;
  tenant_settings?: TenantSettings;
  capabilities?: Partial<ProductCapabilities>;
};
