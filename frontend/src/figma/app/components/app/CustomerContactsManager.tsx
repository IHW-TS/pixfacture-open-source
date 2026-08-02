"use client";

import { useEffect, useMemo, useState } from "react";
import { api, extractUserFacingApiMessage, formatApiError, rawApi } from "@/lib/api";
import {
  Card,
  DangerButton,
  InputField,
  PrimaryButton,
  SecondaryButton,
  SectionTitle,
  SelectField,
  StatusPill,
} from "./AppPageHeader";
import { EmptyCard, NoticeBanner } from "./Feedback";
import { Mail, ReceiptText, RefreshCw, Send, Star, Trash2, UserRoundPlus } from "lucide-react";

type CustomerContact = {
  id: string;
  name?: string | null;
  email: string;
  role: "billing" | "cc" | "other";
  send_invoices: boolean;
  send_quotes: boolean;
  is_primary: boolean;
  created_at?: string | null;
  updated_at?: string | null;
};

type CustomerContactRole = CustomerContact["role"];
type ContactPillTone = "ok" | "warn" | "danger" | "muted" | "info" | "purple";

type Props = {
  customerId: string;
  customerEmail?: string | null;
  canWrite?: boolean;
  onChange?: () => void;
};

function roleLabel(role: CustomerContact["role"] | string | null | undefined) {
  if (role === "billing") return "Facturation";
  if (role === "cc") return "Copie";
  return "Autre";
}

function roleTone(role: CustomerContact["role"] | string | null | undefined): ContactPillTone {
  if (role === "billing") return "info";
  if (role === "cc") return "purple";
  return "muted";
}

function FlagButton({ active, disabled, onClick, icon: Icon, label }: any) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-semibold transition-all ${
        active
          ? "border border-[#bfdbfe] bg-[#eff6ff] text-[#1d4ed8]"
          : "border border-[#e2e8f0] bg-white text-[#64748b] hover:bg-[#f8fafc]"
      } disabled:cursor-not-allowed disabled:opacity-50`}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}

export function CustomerContactsManager({ customerId, customerEmail, canWrite = false, onChange }: Props) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [contacts, setContacts] = useState<CustomerContact[]>([]);
  const [newContact, setNewContact] = useState<{
    name: string;
    email: string;
    role: CustomerContactRole;
    send_invoices: boolean;
    send_quotes: boolean;
    is_primary: boolean;
  }>({
    name: "",
    email: "",
    role: "billing",
    send_invoices: true,
    send_quotes: true,
    is_primary: false,
  });

  const primaryContact = useMemo(() => contacts.find((item) => item.is_primary) || null, [contacts]);
  const invoiceRecipients = useMemo(() => contacts.filter((item) => item.send_invoices).length, [contacts]);
  const quoteRecipients = useMemo(() => contacts.filter((item) => item.send_quotes).length, [contacts]);
  const canSeedFromCustomerEmail = Boolean(
    canWrite &&
    customerEmail &&
    !contacts.some((item) => item.email?.trim().toLowerCase() === String(customerEmail).trim().toLowerCase()),
  );

  const loadContacts = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await rawApi(`/api/customers/${customerId}/contacts`);
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        throw new Error(extractUserFacingApiMessage(payload, res.status, "Impossible de charger les contacts."));
      }
      const payload = await res.json().catch(() => []);
      setContacts(Array.isArray(payload) ? payload : []);
    } catch (err) {
      setContacts([]);
      setError(formatApiError(err, "Impossible de charger les contacts."));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadContacts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId]);

  const refreshParent = () => {
    onChange?.();
  };

  const updateContact = async (contactId: string, patch: Partial<CustomerContact>) => {
    setSaving(true);
    setBusyKey(contactId);
    setError(null);
    setNotice(null);
    try {
      const updated: any = await api(`/api/customers/${customerId}/contacts/${contactId}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      setContacts((prev) =>
        prev.map((item) =>
          item.id === contactId ? updated : patch.is_primary ? { ...item, is_primary: false } : item,
        ),
      );
      if (patch.is_primary) {
        await loadContacts();
      }
      setNotice("Contact mis à jour.");
      refreshParent();
    } catch (err) {
      setError(formatApiError(err, "Mise à jour du contact impossible."));
    } finally {
      setSaving(false);
      setBusyKey(null);
    }
  };

  const deleteContact = async (contactId: string) => {
    if (typeof window !== "undefined" && !window.confirm("Supprimer ce contact ?")) return;
    setSaving(true);
    setBusyKey(contactId);
    setError(null);
    setNotice(null);
    try {
      await api(`/api/customers/${customerId}/contacts/${contactId}`, { method: "DELETE" });
      setContacts((prev) => prev.filter((item) => item.id !== contactId));
      setNotice("Contact supprimé.");
      refreshParent();
    } catch (err) {
      setError(formatApiError(err, "Suppression du contact impossible."));
    } finally {
      setSaving(false);
      setBusyKey(null);
    }
  };

  const createContact = async (payloadOverride?: any) => {
    if (!canWrite) return;
    const payload = payloadOverride || {
      name: (newContact.name || "").trim() || null,
      email: (newContact.email || "").trim(),
      role: newContact.role,
      send_invoices: Boolean(newContact.send_invoices),
      send_quotes: Boolean(newContact.send_quotes),
      is_primary: Boolean(newContact.is_primary),
    };
    setSaving(true);
    setBusyKey("create");
    setError(null);
    setNotice(null);
    try {
      const created: any = await api(`/api/customers/${customerId}/contacts`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      setContacts((prev) => {
        const base = payload.is_primary ? prev.map((item) => ({ ...item, is_primary: false })) : prev;
        return [created, ...base];
      });
      setNewContact({
        name: "",
        email: "",
        role: "billing",
        send_invoices: true,
        send_quotes: true,
        is_primary: false,
      });
      if (payload.is_primary) {
        await loadContacts();
      }
      setNotice("Contact ajouté.");
      refreshParent();
    } catch (err) {
      setError(formatApiError(err, "Ajout du contact impossible."));
    } finally {
      setSaving(false);
      setBusyKey(null);
    }
  };

  const seedFromCustomerEmail = async () => {
    if (!customerEmail) return;
    await createContact({
      name: null,
      email: customerEmail,
      role: "billing",
      send_invoices: true,
      send_quotes: true,
      is_primary: !primaryContact,
    });
  };

  return (
    <Card>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <SectionTitle>Contacts de diffusion</SectionTitle>
          <p className="mt-1 max-w-3xl text-xs leading-relaxed text-[#64748b]">
            Gère les destinataires des factures et devis : principal, facturation, copie et contacts commerciaux.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill status={contacts.length > 0 ? "info" : "muted"} label={`${contacts.length} contact(s)`} />
          <StatusPill
            status={invoiceRecipients > 0 ? "ok" : "warn"}
            label={`${invoiceRecipients} destinataire(s) facture`}
          />
          <StatusPill status={quoteRecipients > 0 ? "ok" : "warn"} label={`${quoteRecipients} destinataire(s) devis`} />
          <SecondaryButton onClick={loadContacts} disabled={loading || saving}>
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} /> Rafraîchir
          </SecondaryButton>
          {canSeedFromCustomerEmail ? (
            <SecondaryButton
              onClick={seedFromCustomerEmail}
              disabled={saving}
              title="Créer un contact à partir de l'email principal du client."
            >
              <UserRoundPlus className="h-3.5 w-3.5" /> Créer depuis l&apos;email
            </SecondaryButton>
          ) : null}
        </div>
      </div>

      {notice ? (
        <NoticeBanner tone="success" className="mt-4">
          {notice}
        </NoticeBanner>
      ) : null}
      {error ? (
        <NoticeBanner tone="danger" className="mt-4">
          {error}
        </NoticeBanner>
      ) : null}

      <div className="mt-4 grid gap-3 md:grid-cols-3">
        <div className="rounded-2xl border border-[#e2e8f0] bg-[#f8fafc] px-4 py-3">
          <div className="text-[0.6875rem] font-bold uppercase tracking-[0.08em] text-[#94a3b8]">Contact principal</div>
          <div className="mt-1 text-sm font-semibold text-[#0f172a]">{primaryContact?.email || "À définir"}</div>
          <div className="mt-1 text-xs text-[#64748b]">
            {primaryContact?.name || "Le contact principal sert de point d&apos;entrée clair pour le compte."}
          </div>
        </div>
        <div className="rounded-2xl border border-[#e2e8f0] bg-[#f8fafc] px-4 py-3">
          <div className="text-[0.6875rem] font-bold uppercase tracking-[0.08em] text-[#94a3b8]">Facturation</div>
          <div className="mt-1 text-sm font-semibold text-[#0f172a]">{invoiceRecipients} contact(s)</div>
          <div className="mt-1 text-xs text-[#64748b]">
            Les relances et envois de facture tombent sur les bonnes boîtes.
          </div>
        </div>
        <div className="rounded-2xl border border-[#e2e8f0] bg-[#f8fafc] px-4 py-3">
          <div className="text-[0.6875rem] font-bold uppercase tracking-[0.08em] text-[#94a3b8]">Commercial</div>
          <div className="mt-1 text-sm font-semibold text-[#0f172a]">{quoteRecipients} contact(s)</div>
          <div className="mt-1 text-xs text-[#64748b]">
            Le suivi devis peut passer par d&apos;autres destinataires que la compta.
          </div>
        </div>
      </div>

      {loading ? (
        <div className="mt-4 rounded-2xl border border-dashed border-[#dbe4ef] bg-[#f8fafc] px-4 py-5 text-sm text-[#64748b]">
          Chargement des contacts…
        </div>
      ) : contacts.length === 0 ? (
        <EmptyCard
          className="mt-4"
          compact
          title="Aucun contact dédié"
          description="Le client repose encore uniquement sur l'email principal de la fiche. Ajoutez au moins un contact pour fiabiliser les envois."
        />
      ) : (
        <div className="mt-4 space-y-3">
          {contacts.map((contact) => {
            const contactBusy = saving && busyKey === contact.id;
            return (
              <div
                key={contact.id}
                className="rounded-2xl border border-[#e2e8f0] bg-white px-4 py-4 shadow-[0_1px_2px_rgba(0,0,0,0.04)]"
              >
                <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
                  <div className="min-w-0 xl:max-w-[42%]">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-semibold text-[#0f172a]">
                        {contact.name || contact.email}
                      </span>
                      {contact.is_primary ? <StatusPill status="ok" label="Principal" /> : null}
                      <StatusPill status={roleTone(contact.role)} label={roleLabel(contact.role)} />
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-[#64748b]">
                      <span className="inline-flex items-center gap-1.5">
                        <Mail className="h-3.5 w-3.5" />
                        {contact.email}
                      </span>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 xl:justify-end">
                    <select
                      value={contact.role}
                      disabled={!canWrite || contactBusy}
                      onChange={(event) =>
                        void updateContact(contact.id, { role: event.target.value as CustomerContactRole })
                      }
                      className="rounded-xl border border-[#e2e8f0] bg-white px-3 py-2 text-xs font-semibold text-[#374151] shadow-[0_1px_2px_rgba(0,0,0,0.04)] focus:outline-none focus:ring-2 focus:ring-[#1d4ed8]/15"
                    >
                      <option value="billing">Facturation</option>
                      <option value="cc">Copie</option>
                      <option value="other">Autre</option>
                    </select>
                    <FlagButton
                      active={Boolean(contact.send_invoices)}
                      disabled={!canWrite || contactBusy}
                      onClick={() => void updateContact(contact.id, { send_invoices: !contact.send_invoices })}
                      icon={ReceiptText}
                      label="Factures"
                    />
                    <FlagButton
                      active={Boolean(contact.send_quotes)}
                      disabled={!canWrite || contactBusy}
                      onClick={() => void updateContact(contact.id, { send_quotes: !contact.send_quotes })}
                      icon={Send}
                      label="Devis"
                    />
                    <FlagButton
                      active={Boolean(contact.is_primary)}
                      disabled={!canWrite || contactBusy}
                      onClick={() => void updateContact(contact.id, { is_primary: true })}
                      icon={Star}
                      label={contact.is_primary ? "Principal" : "Définir principal"}
                    />
                    {canWrite ? (
                      <DangerButton
                        className="!px-3 !py-2 !text-xs"
                        onClick={() => void deleteContact(contact.id)}
                        disabled={contactBusy}
                      >
                        <Trash2 className="h-3.5 w-3.5" /> Supprimer
                      </DangerButton>
                    ) : null}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {canWrite ? (
        <div className="mt-5 rounded-2xl border border-[#e2e8f0] bg-[#f8fafc] p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-[#0f172a]">Ajouter un contact</div>
              <p className="mt-1 text-xs leading-relaxed text-[#64748b]">
                Utile pour séparer comptabilité, direction et interlocuteurs commerciaux.
              </p>
            </div>
          </div>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <InputField
              label="Nom"
              value={newContact.name}
              onChange={(event) => setNewContact((prev) => ({ ...prev, name: event.target.value }))}
              placeholder="Nom du contact"
            />
            <InputField
              label="Email"
              type="email"
              value={newContact.email}
              onChange={(event) => setNewContact((prev) => ({ ...prev, email: event.target.value }))}
              placeholder="compta@client.fr"
            />
            <SelectField
              label="Rôle"
              value={newContact.role}
              onChange={(event) =>
                setNewContact((prev) => ({ ...prev, role: event.target.value as CustomerContactRole }))
              }
            >
              <option value="billing">Facturation</option>
              <option value="cc">Copie</option>
              <option value="other">Autre</option>
            </SelectField>
            <div className="flex flex-col justify-end gap-2">
              <label className="inline-flex items-center gap-2 text-xs font-medium text-[#475569]">
                <input
                  type="checkbox"
                  className="rounded border-[#cbd5e1]"
                  checked={newContact.send_invoices}
                  onChange={(event) => setNewContact((prev) => ({ ...prev, send_invoices: event.target.checked }))}
                />
                Reçoit les factures
              </label>
              <label className="inline-flex items-center gap-2 text-xs font-medium text-[#475569]">
                <input
                  type="checkbox"
                  className="rounded border-[#cbd5e1]"
                  checked={newContact.send_quotes}
                  onChange={(event) => setNewContact((prev) => ({ ...prev, send_quotes: event.target.checked }))}
                />
                Reçoit les devis
              </label>
              <label className="inline-flex items-center gap-2 text-xs font-medium text-[#475569]">
                <input
                  type="checkbox"
                  className="rounded border-[#cbd5e1]"
                  checked={newContact.is_primary}
                  onChange={(event) => setNewContact((prev) => ({ ...prev, is_primary: event.target.checked }))}
                />
                Définir comme principal
              </label>
            </div>
          </div>
          <div className="mt-4 flex justify-end">
            <PrimaryButton
              onClick={() => void createContact()}
              disabled={saving || !String(newContact.email || "").trim()}
            >
              {busyKey === "create" ? "Ajout…" : "Ajouter le contact"}
            </PrimaryButton>
          </div>
        </div>
      ) : null}
    </Card>
  );
}
