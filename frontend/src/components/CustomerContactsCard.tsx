"use client";

import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "@/lib/api";
import { formatApiError } from "@/lib/api";

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

type Props = {
  customerId: string;
  canWrite: boolean;
};

const roleLabel = (role: CustomerContact["role"]) => {
  if (role === "billing") return "Facturation";
  if (role === "cc") return "Copie";
  return "Autre";
};

export default function CustomerContactsCard({ customerId, canWrite }: Props) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [contacts, setContacts] = useState<CustomerContact[]>([]);

  const [newName, setNewName] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newRole, setNewRole] = useState<CustomerContact["role"]>("billing");
  const [newSendInvoices, setNewSendInvoices] = useState(true);
  const [newSendQuotes, setNewSendQuotes] = useState(true);
  const [newPrimary, setNewPrimary] = useState(false);

  const primary = useMemo(() => contacts.find((c) => c.is_primary), [contacts]);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/customers/${customerId}/contacts`);
      const data = (await res.json()) as CustomerContact[];
      setContacts(Array.isArray(data) ? data : []);
    } catch (e) {
      setError(formatApiError(e, "Impossible de charger les contacts."));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId]);

  const updateContact = async (id: string, patch: Partial<CustomerContact>) => {
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch(`/customers/${customerId}/contacts/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const next = (await res.json()) as CustomerContact;
      setContacts((prev) => prev.map((c) => (c.id === id ? next : c)));
      // si on vient de passer primary=true, le backend a remis les autres a false
      if (patch.is_primary) {
        void load();
      }
    } catch (e) {
      setError(formatApiError(e, "Impossible de mettre à jour le contact."));
    } finally {
      setSaving(false);
    }
  };

  const deleteContact = async (id: string) => {
    if (!confirm("Supprimer ce contact ?")) return;
    setSaving(true);
    setError(null);
    try {
      await apiFetch(`/customers/${customerId}/contacts/${id}`, { method: "DELETE" });
      setContacts((prev) => prev.filter((c) => c.id !== id));
    } catch (e) {
      setError(formatApiError(e, "Impossible de supprimer le contact."));
    } finally {
      setSaving(false);
    }
  };

  const createContact = async () => {
    if (!canWrite) return;
    setSaving(true);
    setError(null);
    try {
      const payload = {
        name: newName.trim() || null,
        email: newEmail.trim(),
        role: newRole,
        send_invoices: newSendInvoices,
        send_quotes: newSendQuotes,
        is_primary: newPrimary,
      };
      const res = await apiFetch(`/customers/${customerId}/contacts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const created = (await res.json()) as CustomerContact;
      setContacts((prev) => [created, ...prev]);
      setNewName("");
      setNewEmail("");
      setNewRole("billing");
      setNewSendInvoices(true);
      setNewSendQuotes(true);
      setNewPrimary(false);
      if (created.is_primary) {
        void load();
      }
    } catch (e) {
      setError(formatApiError(e, "Impossible d'ajouter le contact."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card mt-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Contacts (destinataires factures / devis)</h2>
          <p className="muted">
            Par défaut, l'envoi passe par les contacts "Facturation" cochés. Si aucun contact n'est défini, l'adresse
            principale du client est utilisée.
          </p>
        </div>
        <button className="btn" onClick={load} disabled={loading || saving}>
          Rafraîchir
        </button>
      </div>

      {error ? <div className="alert alert-error mt-4">{error}</div> : null}

      {loading ? (
        <p className="muted mt-4">Chargement des contacts…</p>
      ) : (
        <>
          {primary ? (
            <div className="mt-4">
              <span className="badge">Principal</span> {primary.email} {primary.name ? `— ${primary.name}` : ""}
            </div>
          ) : null}

          <div className="mt-4 overflow-x-auto">
            {contacts.length ? (
              <table className="table">
                <thead>
                  <tr>
                    <th>Nom</th>
                    <th>Email</th>
                    <th>Rôle</th>
                    <th>Factures</th>
                    <th>Devis</th>
                    <th>Principal</th>
                    {canWrite ? <th /> : null}
                  </tr>
                </thead>
                <tbody>
                  {contacts.map((c) => (
                    <tr key={c.id}>
                      <td>{c.name || <span className="muted">—</span>}</td>
                      <td>{c.email}</td>
                      <td>
                        {canWrite ? (
                          <select
                            className="input"
                            value={c.role}
                            onChange={(e) => updateContact(c.id, { role: e.target.value as CustomerContact["role"] })}
                            disabled={saving}
                          >
                            <option value="billing">{roleLabel("billing")}</option>
                            <option value="cc">{roleLabel("cc")}</option>
                            <option value="other">{roleLabel("other")}</option>
                          </select>
                        ) : (
                          roleLabel(c.role)
                        )}
                      </td>
                      <td>
                        <input
                          type="checkbox"
                          checked={!!c.send_invoices}
                          disabled={!canWrite || saving}
                          onChange={(e) => updateContact(c.id, { send_invoices: e.target.checked })}
                        />
                      </td>
                      <td>
                        <input
                          type="checkbox"
                          checked={!!c.send_quotes}
                          disabled={!canWrite || saving}
                          onChange={(e) => updateContact(c.id, { send_quotes: e.target.checked })}
                        />
                      </td>
                      <td>
                        <input
                          type="radio"
                          name="primary-contact"
                          checked={!!c.is_primary}
                          disabled={!canWrite || saving}
                          onChange={() => updateContact(c.id, { is_primary: true })}
                        />
                      </td>
                      {canWrite ? (
                        <td>
                          <button className="btn btn-sm" onClick={() => deleteContact(c.id)} disabled={saving}>
                            Supprimer
                          </button>
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="muted">Aucun contact défini pour ce client.</p>
            )}
          </div>

          {canWrite ? (
            <div className="mt-6">
              <h3 className="font-semibold">Ajouter un contact</h3>
              <div className="grid-cols-auto-220 gap-12 mt-3">
                <div>
                  <label className="label">Nom (optionnel)</label>
                  <input className="input" value={newName} onChange={(e) => setNewName(e.target.value)} />
                </div>
                <div>
                  <label className="label">Email</label>
                  <input className="input" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} />
                </div>
                <div>
                  <label className="label">Rôle</label>
                  <select className="input" value={newRole} onChange={(e) => setNewRole(e.target.value as any)}>
                    <option value="billing">{roleLabel("billing")}</option>
                    <option value="cc">{roleLabel("cc")}</option>
                    <option value="other">{roleLabel("other")}</option>
                  </select>
                </div>
              </div>

              <div className="flex items-center gap-6 mt-3">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={newSendInvoices}
                    onChange={(e) => setNewSendInvoices(e.target.checked)}
                  />
                  Envoyer les factures
                </label>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={newSendQuotes} onChange={(e) => setNewSendQuotes(e.target.checked)} />
                  Envoyer les devis
                </label>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={newPrimary} onChange={(e) => setNewPrimary(e.target.checked)} />
                  Principal
                </label>
              </div>

              <div className="mt-4">
                <button className="btn" onClick={createContact} disabled={saving || !newEmail.trim()}>
                  Ajouter le contact
                </button>
                <span className="muted ml-3">{saving ? "Enregistrement…" : ""}</span>
              </div>
            </div>
          ) : (
            <p className="muted mt-6">Vous n'avez pas les droits pour modifier les contacts.</p>
          )}
        </>
      )}
    </div>
  );
}
