"use client";

import { useEffect, useMemo, useState } from "react";
import { api, apiUrl, formatApiError } from "@/lib/api";
import { downloadProtectedFile } from "@/lib/download";

export type DocumentAttachment = {
  id: string;
  filename: string;
  label?: string | null;
  content_type: string;
  size_bytes: number;
  public_visible: boolean;
  created_at: string;
};

const fmtBytes = (n: number) => {
  const v = Number(n || 0);
  if (!Number.isFinite(v) || v <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let val = v;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i += 1;
  }
  const digits = i === 0 ? 0 : val < 10 ? 1 : 0;
  return `${val.toFixed(digits)} ${units[i]}`;
};

const isPreviewable = (ct: string) => {
  const c = (ct || "").toLowerCase();
  return c.includes("application/pdf") || c.startsWith("image/");
};

export default function DocumentAttachmentsPanel(props: {
  documentType: "invoice" | "quote";
  documentId: string;
  editable?: boolean;
}) {
  const { documentType, documentId, editable = true } = props;

  const basePath = useMemo(() => {
    const plural = documentType === "invoice" ? "invoices" : "quotes";
    return `/api/${plural}/${documentId}/attachments`;
  }, [documentType, documentId]);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<DocumentAttachment[]>([]);

  const [label, setLabel] = useState<string>("");
  const [publicVisible, setPublicVisible] = useState<boolean>(false);
  const [uploading, setUploading] = useState(false);

  const [draftLabels, setDraftLabels] = useState<Record<string, string>>({});
  const [draftVisibility, setDraftVisibility] = useState<Record<string, boolean>>({});

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = (await api(basePath, {})) as DocumentAttachment[];
      const arr = Array.isArray(res) ? res : [];
      setItems(arr);
      const labels: Record<string, string> = {};
      const vis: Record<string, boolean> = {};
      for (const a of arr) {
        labels[a.id] = (a.label || "") as string;
        vis[a.id] = Boolean(a.public_visible);
      }
      setDraftLabels(labels);
      setDraftVisibility(vis);
    } catch (e: any) {
      setError(formatApiError(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [basePath]);

  const onUpload = async (file: File | null) => {
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      if ((label || "").trim()) form.append("label", (label || "").trim());
      form.append("public_visible", publicVisible ? "true" : "false");
      await api(basePath, { method: "POST", body: form });
      setLabel("");
      setPublicVisible(false);
      await refresh();
    } catch (e: any) {
      setError(formatApiError(e));
    } finally {
      setUploading(false);
    }
  };

  const save = async (att: DocumentAttachment) => {
    setError(null);
    try {
      const payload: any = {};
      const nextLabel = (draftLabels[att.id] ?? "").trim();
      payload.label = nextLabel ? nextLabel : null;
      payload.public_visible = Boolean(draftVisibility[att.id]);
      await api(`${basePath}/${att.id}`, { method: "PATCH", body: JSON.stringify(payload) });
      await refresh();
    } catch (e: any) {
      setError(formatApiError(e));
    }
  };

  const del = async (att: DocumentAttachment) => {
    if (!confirm("Supprimer cette pièce jointe ?")) return;
    setError(null);
    try {
      await api(`${basePath}/${att.id}`, { method: "DELETE" });
      await refresh();
    } catch (e: any) {
      setError(formatApiError(e));
    }
  };

  const preview = (att: DocumentAttachment) => {
    const url = apiUrl(`${basePath}/${att.id}/file`);
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const download = async (att: DocumentAttachment) => {
    await downloadProtectedFile(`${basePath}/${att.id}/file?download=1`, att.filename);
  };

  return (
    <section className="panel">
      <div className="panel__header">
        <h2>Pièces jointes</h2>
      </div>
      <div className="panel__body">
        <p className="muted">
          Ajoutez des documents (PDF/images) liés à ce document. Par défaut, ils ne sont pas visibles côté client.
        </p>

        {error ? (
          <div className="notice notice--danger" role="alert">
            {error}
          </div>
        ) : null}

        {editable ? (
          <div className="mb-10">
            <div className="form-grid">
              <label>
                Étiquette (optionnel)
                <input
                  className="input"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="ex: Bon de commande, Rapport d’intervention"
                />
                <small className="muted">Visible dans la liste côté client.</small>
              </label>

              <label className="vat-toggle">
                <input type="checkbox" checked={publicVisible} onChange={(e) => setPublicVisible(e.target.checked)} />
                <span>Visible au client</span>
                <span className="tag">Portail</span>
              </label>

              <label className="col-span-2">
                Ajouter un fichier
                <input
                  className="input"
                  type="file"
                  accept="application/pdf,image/png,image/jpeg,image/webp"
                  disabled={uploading}
                  onChange={(e) => onUpload(e.target.files?.[0] || null)}
                />
                <small className="muted">Types supportés : PDF, PNG, JPEG, WEBP.</small>
              </label>
            </div>
          </div>
        ) : null}

        {loading ? <div className="muted">Chargement des pièces jointes…</div> : null}
        {!loading && items.length === 0 ? <div className="muted">Aucune pièce jointe.</div> : null}

        {!loading && items.length > 0 ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Fichier</th>
                  <th>Type</th>
                  <th>Taille</th>
                  <th>Client</th>
                  <th>Actions fichier</th>
                </tr>
              </thead>
              <tbody>
                {items.map((att) => {
                  const name = (att.label || "").trim() || att.filename;
                  return (
                    <tr key={att.id}>
                      <td>
                        <div>
                          <strong>{name}</strong>
                        </div>
                        {editable ? (
                          <div className="mt-4">
                            <small className="muted">Étiquette</small>
                            <input
                              className="input"
                              value={draftLabels[att.id] ?? ""}
                              onChange={(e) =>
                                setDraftLabels((prev) => ({
                                  ...prev,
                                  [att.id]: e.target.value,
                                }))
                              }
                              placeholder="Étiquette (optionnel)"
                            />
                          </div>
                        ) : null}
                      </td>
                      <td className="muted">{att.content_type}</td>
                      <td className="muted">{fmtBytes(att.size_bytes)}</td>
                      <td>
                        {editable ? (
                          <label className="flex items-center gap-6">
                            <input
                              type="checkbox"
                              checked={Boolean(draftVisibility[att.id])}
                              onChange={(e) =>
                                setDraftVisibility((p) => ({
                                  ...p,
                                  [att.id]: e.target.checked,
                                }))
                              }
                            />
                            <span className="muted">Visible</span>
                          </label>
                        ) : (
                          <span className="muted">{att.public_visible ? "Oui" : "Non"}</span>
                        )}
                      </td>
                      <td>
                        <div className="flex gap-6 flex-wrap">
                          {isPreviewable(att.content_type) ? (
                            <button className="btn btn--ghost btn--sm" type="button" onClick={() => preview(att)}>
                              Prévisualiser
                            </button>
                          ) : null}
                          <button className="btn btn--ghost btn--sm" type="button" onClick={() => download(att)}>
                            Télécharger le fichier
                          </button>
                          {editable ? (
                            <>
                              <button className="btn btn--primary btn--sm" type="button" onClick={() => save(att)}>
                                Enregistrer
                              </button>
                              <button className="btn btn--danger btn--sm" type="button" onClick={() => del(att)}>
                                Supprimer
                              </button>
                            </>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </section>
  );
}
