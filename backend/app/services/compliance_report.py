from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import logging
import shutil
from tempfile import NamedTemporaryFile
from typing import Any
import zipfile

from ..compliance.fr_2026 import validate_fr_einvoicing_fields
from ..compliance.fr_specs_v31.validator import validate_fr_specs_v31
from ..config import settings
from ..validators.invoice_sanity_checks import validate_invoice_ctx
from ..services.cii import resolve_facturx_profile
from sqlalchemy.orm import Session

from ..models import Customer, EInvoicingTransmission, Invoice, Numbering, PdpConnection, Tenant
from ..services.document_attachments import sanitize_filename
from ..services.facturx import (
    _run_verapdf,
    public_verapdf_result,
    sanitize_public_pdfa_report,
)
from ..services.pdf import env, render_pdf
from ..services.pdp.service import is_fr_b2b
from ..services.seqino_mandates import seqino_has_active_mandate
from ..services.storage import get_object_bytes, head_object, invoice_artifact_key, put_object


COMPLIANCE_REPORT_JSON_KIND = "compliance_report_json"
COMPLIANCE_REPORT_PDF_KIND = "compliance_report_pdf"
COMPLIANCE_REPORT_SCHEMA_VERSION = "2026-01"
logger = logging.getLogger(__name__)

READINESS_ACTION_URLS: dict[str, str] = {
    "company_profile": "/app/company",
    "invoice_settings": "/app/company",
    "fr_customers_siren": "/app/customers",
    "dse_v31": "/app/conformite",
    "pdp_connection": "/app/einvoicing",
    "ereporting": "/app/e-reporting",
}


def _digits(value: str | None) -> str:
    if not value:
        return ""
    return "".join(ch for ch in value if ch.isdigit())


def _normalize_country(value: str | None) -> str | None:
    if value is None:
        return None
    cleaned = value.strip().upper()
    if not cleaned:
        return None
    return cleaned


def _object_dict(value: object | None) -> dict[str, object]:
    return value if isinstance(value, dict) else {}


def _object_list(value: object | None) -> list[object]:
    return list(value) if isinstance(value, list | tuple) else []


def _object_text(value: object | None) -> str | None:
    return value if isinstance(value, str) else None


def _object_int(value: object | None, default: int = 0) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return default
    return default


def _readiness_item(
    *,
    key: str,
    label: str,
    required: bool,
    severity: str,
    missing_fields: list[str] | None,
    next_action: str | None,
    details: dict[str, object] | None = None,
) -> dict[str, object]:
    missing = [field for field in (missing_fields or []) if field]
    status = "ok"
    if missing:
        status = "missing" if required else "warning"
    item: dict[str, object] = {
        "key": key,
        "label": label,
        "status": status,
        "required": required,
        "severity": severity,
        "missing_fields": missing,
        "next_action": next_action,
    }
    if details:
        item["details"] = details
    action_url = READINESS_ACTION_URLS.get(key)
    if action_url:
        item["action_url"] = action_url
    return item


def _status_counts(items: list[dict[str, object]]) -> dict[str, int]:
    blocking = len(
        [item for item in items if item.get("severity") == "p0" and item.get("status") == "missing"]
    )
    watch = len(
        [
            item
            for item in items
            if item.get("status") == "warning"
            or (item.get("status") == "missing" and item.get("severity") != "p0")
        ]
    )
    ok = len([item for item in items if item.get("status") == "ok"])
    return {"blocking": blocking, "watch": watch, "ok": ok}


def _completion_rate(items: list[dict[str, object]]) -> int:
    if not items:
        return 100
    ok = len([item for item in items if item.get("status") == "ok"])
    return round((ok / len(items)) * 100)


def _find_item(items: list[dict[str, object]], key: str) -> dict[str, object] | None:
    for item in items:
        if item.get("key") == key:
            return item
    return None


def _timeline_status(date_text: str) -> str:
    try:
        target = datetime.fromisoformat(date_text).date()
    except ValueError:
        return "info"
    return "active" if datetime.now(timezone.utc).date() >= target else "upcoming"


def _company_profile_label(
    *,
    tenant_country: str,
    fr_b2b_count: int,
    other_flows_count: int,
) -> str:
    if tenant_country != "FR":
        return "Profil hors reforme FR domestique"
    if fr_b2b_count and other_flows_count:
        return "Flux mixtes FR B2B + e-reporting"
    if fr_b2b_count:
        return "B2B domestique FR"
    if other_flows_count:
        return "Flux hors B2B domestique"
    return "Profil a confirmer"


def _build_company_profile(
    tenant: Tenant,
    customers: list[Customer],
    fr_customers: list[Customer],
    *,
    ereporting_required: bool,
) -> dict[str, object]:
    tenant_country = _normalize_country(tenant.country) or "FR"
    other_flows = [
        customer
        for customer in customers
        if not is_fr_b2b(tenant_country, customer.country, customer.client_type)
    ]
    return {
        "country": tenant_country,
        "plan": (tenant.plan or "starter").lower(),
        "subscription_status": tenant.subscription_status,
        "vat_regime": tenant.vat_regime,
        "vat_exempt": bool(tenant.vat_exemption_notice and not tenant.vat_number),
        "customers_total": len(customers),
        "fr_b2b_customers": len(fr_customers),
        "other_flows_customers": len(other_flows),
        "ereporting_required": ereporting_required,
        "profile_label": _company_profile_label(
            tenant_country=tenant_country,
            fr_b2b_count=len(fr_customers),
            other_flows_count=len(other_flows),
        ),
        "company_size_known": False,
        "company_size_status": "a_confirmer",
        "company_size_hint": "La vague d'emission 2026 ou 2027 depend de la taille de l'entreprise, non suivie dans l'application aujourd'hui.",
    }


def _build_reform_timeline(profile: dict[str, object]) -> list[dict[str, object]]:
    in_scope = profile.get("country") == "FR"
    ereporting_required = bool(profile.get("ereporting_required"))
    milestones = [
        {
            "date": "2026-09-01",
            "title": "Reception obligatoire",
            "detail": "Toutes les entreprises assujetties a la TVA devront pouvoir recevoir des factures electroniques.",
            "applicable": in_scope,
            "applies_to": "Toutes les entreprises assujetties a la TVA",
        },
        {
            "date": "2026-09-01",
            "title": "Emission grande entreprise / ETI",
            "detail": "La premiere vague d'emission concerne les grandes entreprises et ETI. La taille du tenant reste a confirmer.",
            "applicable": in_scope,
            "applies_to": "Grandes entreprises et ETI",
            "requires_confirmation": True,
        },
        {
            "date": "2026-09-01",
            "title": "E-reporting si flux hors B2B domestique",
            "detail": "A preparer si vous avez des flux B2C, internationaux ou d'autres operations hors B2B domestique FR.",
            "applicable": in_scope and ereporting_required,
            "applies_to": "Flux hors B2B domestique FR",
        },
        {
            "date": "2027-09-01",
            "title": "Emission PME / micro",
            "detail": "Si le tenant n'entre pas dans la vague 2026, l'echeance cible passe en septembre 2027.",
            "applicable": in_scope,
            "applies_to": "PME et micro-entreprises",
            "requires_confirmation": True,
        },
    ]
    for milestone in milestones:
        milestone["status"] = _timeline_status(str(milestone["date"]))
    return milestones


def _obligation_status(item: dict[str, object] | None, *, default: str = "planned") -> str:
    if not item:
        return default
    item_status = str(item.get("status") or "").lower()
    severity = str(item.get("severity") or "").lower()
    if item_status == "ok":
        return "ready"
    if item_status == "warning":
        return "attention"
    if item_status == "missing":
        return "blocked" if severity == "p0" else "planned"
    return default


def _build_profile_obligations(
    items: list[dict[str, object]],
    profile: dict[str, object],
) -> list[dict[str, object]]:
    company_item = _find_item(items, "company_profile")
    invoice_item = _find_item(items, "invoice_settings")
    siren_item = _find_item(items, "fr_customers_siren")
    pdp_item = _find_item(items, "pdp_connection")
    ereporting_item = _find_item(items, "ereporting")
    in_scope = profile.get("country") == "FR"
    fr_b2b_customers = _object_int(profile.get("fr_b2b_customers"))
    ereporting_required = bool(profile.get("ereporting_required"))
    reception_status = "ready" if _obligation_status(company_item) == "ready" and _obligation_status(invoice_item) == "ready" else _obligation_status(company_item, default="attention")
    emission_status = "ready"
    for item in (company_item, invoice_item, siren_item):
        status = _obligation_status(item, default="planned")
        if status == "blocked":
            emission_status = "blocked"
            break
        if status in {"planned", "attention"} and emission_status != "blocked":
            emission_status = status
    obligations = [
        {
            "key": "receive_einvoices",
            "title": "Recevoir des factures electroniques",
            "applicable": in_scope,
            "deadline": "2026-09-01",
            "status": reception_status,
            "detail": "Base entreprise et parametres facture alignes pour recevoir et traiter des factures electroniques.",
            "action_url": "/app/setup/einvoicing",
        },
        {
            "key": "issue_b2b_fr",
            "title": "Emettre en B2B domestique FR",
            "applicable": in_scope
            and (fr_b2b_customers > 0 or _object_int(profile.get("customers_total")) == 0),
            "deadline": "2026-09-01 ou 2027-09-01",
            "status": emission_status,
            "detail": "L'echeance exacte depend de la taille de l'entreprise; la checklist couvre deja le profil, la numerotation et les identifiants clients.",
            "action_url": "/app/conformite",
            "requires_confirmation": True,
        },
        {
            "key": "ereporting",
            "title": "Couvrir l'e-reporting",
            "applicable": in_scope and ereporting_required,
            "deadline": "2026-09-01",
            "status": _obligation_status(ereporting_item, default="planned"),
            "detail": "Obligatoire si le tenant a des flux hors B2B domestique FR.",
            "action_url": "/app/e-reporting",
        },
        {
            "key": "connected_transmission",
            "title": "Preparer la transmission connectee",
            "applicable": in_scope,
            "deadline": "Selon ouverture PDP/PA",
            "status": _obligation_status(pdp_item, default="planned"),
            "detail": "Le mode export suffit pour demarrer; la connexion PDP devient necessaire pour une transmission connectee.",
            "action_url": "/app/einvoicing",
        },
    ]
    return obligations


def _build_proof_summary(db: Session, tenant_id: str) -> dict[str, object]:
    invoices = db.query(Invoice).filter(Invoice.tenant_id == tenant_id).all()
    transmissions = (
        db.query(EInvoicingTransmission)
        .join(Invoice, EInvoicingTransmission.invoice_id == Invoice.id)
        .filter(Invoice.tenant_id == tenant_id)
        .all()
    )
    issued = [inv for inv in invoices if inv.issued_at or (inv.status or "").lower() != "draft"]
    latest_issued = max(
        (inv.issued_at or inv.created_at for inv in issued if inv.issued_at or inv.created_at),
        default=None,
    )
    latest_transmission = max(
        (tx.updated_at or tx.created_at for tx in transmissions if tx.updated_at or tx.created_at),
        default=None,
    )
    return {
        "documents_total": len(invoices),
        "documents_issued": len(issued),
        "facturx_ready": len([inv for inv in invoices if inv.facturx_key]),
        "hash_sealed": len([inv for inv in invoices if inv.issued_hash]),
        "transmissions_total": len(transmissions),
        "latest_issued_at": _iso(latest_issued),
        "latest_transmission_at": _iso(latest_transmission),
    }


def build_readiness_checklist(db: Session, tenant_id: str) -> dict[str, object]:
    tenant = db.get(Tenant, tenant_id)
    if not tenant:
        raise ValueError("Entreprise introuvable.")

    customers = (
        db.query(Customer)
        .filter(Customer.tenant_id == tenant_id)
        .order_by(Customer.created_at.asc())
        .all()
    )

    items: list[dict[str, object]] = []

    siret_digits = _digits(tenant.siret)
    company_missing: list[str] = []
    if len(siret_digits) not in {9, 14}:
        company_missing.append("SIRET/SIREN")
    if not (tenant.vat_number or tenant.vat_exemption_notice):
        company_missing.append("TVA")
    if not (tenant.address or "").strip():
        company_missing.append("Adresse")
    if not (tenant.rcs or "").strip():
        company_missing.append("RCS")
    items.append(
        _readiness_item(
            key="company_profile",
            label="Société complétée",
            required=True,
            severity="p0",
            missing_fields=company_missing,
            next_action="Compléter le profil entreprise (SIRET/SIREN, TVA, adresse, RCS).",
        )
    )

    numbering = (
        db.query(Numbering)
        .filter(Numbering.tenant_id == tenant_id)
        .first()
    )
    invoice_missing: list[str] = []
    if numbering is None:
        invoice_missing.append("Numérotation")
    if not (tenant.iban or "").strip():
        invoice_missing.append("IBAN")
    if not (tenant.late_payment_interest or "").strip():
        invoice_missing.append("Pénalités de retard")
    if tenant.recovery_fee_eur is None:
        invoice_missing.append("Indemnité forfaitaire")
    if not (tenant.discount_terms or "").strip():
        invoice_missing.append("Escompte")
    items.append(
        _readiness_item(
            key="invoice_settings",
            label="Paramètres facture",
            required=True,
            severity="p0",
            missing_fields=invoice_missing,
            next_action="Renseigner la numérotation, IBAN et pénalités de paiement.",
        )
    )

    tenant_country = _normalize_country(tenant.country) or "FR"
    fr_customers = [
        customer
        for customer in customers
        if is_fr_b2b(tenant_country, customer.country, customer.client_type)
    ]
    missing_siren: list[str] = []
    for customer in fr_customers:
        siren_digits = _digits(customer.siren)
        if len(siren_digits) == 9:
            continue
        siret_digits = _digits(customer.siret)
        if len(siret_digits) >= 9:
            continue
        missing_siren.append(customer.id)
    customer_required = bool(fr_customers)
    items.append(
        _readiness_item(
            key="fr_customers_siren",
            label="Clients FR avec SIREN",
            required=customer_required,
            severity="p1",
            missing_fields=["SIREN client"] if missing_siren else [],
            next_action="Compléter le SIREN pour chaque client FR B2B.",
            details={
                "missing_count": len(missing_siren),
                "customer_ids": missing_siren,
            },
        )
    )

    dse_applicable = bool(fr_customers) and tenant_country == "FR"
    items.append(
        _readiness_item(
            key="dse_v31",
            label="DSE v3.1",
            required=False,
            severity="p1",
            missing_fields=[],
            next_action="Verifier la checklist DSE v3.1 sur chaque facture FR B2B.",
            details={"applicable": dse_applicable, "version": "v3.1"},
        )
    )

    pdp_required = False
    connections = (
        db.query(PdpConnection)
        .filter(PdpConnection.tenant_id == tenant_id, PdpConnection.status == "connected")
        .all()
    )
    providers: list[str] = []
    seqino_mandate_missing = False
    for conn in connections:
        slug = (conn.provider_slug or "").strip().lower()
        if not slug:
            continue
        if slug == "seqino" and not seqino_has_active_mandate(tenant_id, db=db):
            seqino_mandate_missing = True
            continue
        if slug not in providers:
            providers.append(slug)
    pdp_missing_fields = [] if providers else ["Connexion plateforme partenaire active"]
    pdp_next_action = "Optionnel pour l’export Factur‑X. Requis pour transmettre via une PA partenaire."
    if seqino_mandate_missing and not providers:
        pdp_next_action = "Optionnel pour l’export Factur‑X. Requis pour transmettre via une PA partenaire."
    items.append(
        _readiness_item(
            key="pdp_connection",
            label="Connexion plateforme agréée (transmission)",
            required=pdp_required,
            severity="p1",
            missing_fields=pdp_missing_fields,
            next_action=pdp_next_action,
            details={"providers": providers},
        )
    )

    ereporting_required = False
    if tenant_country == "FR":
        for customer in customers:
            if not is_fr_b2b(tenant_country, customer.country, customer.client_type):
                ereporting_required = True
                break
    ereporting_missing: list[str] = []
    if ereporting_required:
        if tenant.payments_reporting_enabled is False:
            ereporting_missing.append("Activation e-reporting paiements")
        if not (tenant.transaction_periodicity or "").strip():
            ereporting_missing.append("Périodicité transactions")
        if tenant.payments_reporting_enabled and not (tenant.payment_periodicity or "").strip():
            ereporting_missing.append("Périodicité paiements")
    items.append(
        _readiness_item(
            key="ereporting",
            label="E-reporting activé si requis",
            required=ereporting_required,
            severity="p0" if ereporting_required else "p1",
            missing_fields=ereporting_missing,
            next_action="Activer l’e-reporting et configurer les périodicités.",
        )
    )

    blocking_items = [
        item for item in items if item.get("severity") == "p0" and item.get("status") == "missing"
    ]
    needs_attention = [item for item in items if item.get("status") in {"missing", "warning"}]
    if blocking_items:
        overall_status = "blocked"
        next_action = blocking_items[0].get("next_action")
    elif needs_attention:
        overall_status = "warning"
        next_action = needs_attention[0].get("next_action")
    else:
        overall_status = "ok"
        next_action = None

    summary_counts = _status_counts(items)
    profile = _build_company_profile(
        tenant,
        customers,
        fr_customers,
        ereporting_required=ereporting_required,
    )

    return {
        "generated_at": _iso(datetime.now(timezone.utc).replace(tzinfo=None)),
        "status": overall_status,
        "next_action": next_action,
        "items": items,
        "summary": {
            "blocking_count": summary_counts["blocking"],
            "watch_count": summary_counts["watch"],
            "ok_count": summary_counts["ok"],
            "completion_rate": _completion_rate(items),
        },
        "company_profile": profile,
        "reform_timeline": _build_reform_timeline(profile),
        "obligations": _build_profile_obligations(items, profile),
        "proof": _build_proof_summary(db, tenant_id),
    }


def build_readiness_proof_export(
    db: Session,
    tenant_id: str,
    *,
    public_settings: dict[str, object] | None = None,
) -> dict[str, object]:
    readiness = build_readiness_checklist(db, tenant_id)
    return {
        "kind": "readiness_proof",
        "generated_at": _iso(datetime.now(timezone.utc).replace(tzinfo=None)),
        "public_settings": public_settings or {},
        "readiness": readiness,
        "notes": [
            "Ce fichier sert de preuve exploitable pour la preparation go-live et la reforme FR 2026-2027.",
            "La date d'emission exacte depend encore de la taille de l'entreprise, non suivie dans ce tenant.",
        ],
    }


def _readiness_summary_text(payload: dict[str, object]) -> str:
    readiness = _object_dict(payload.get("readiness"))
    summary = _object_dict(readiness.get("summary"))
    profile = _object_dict(readiness.get("company_profile"))
    proof = _object_dict(readiness.get("proof"))
    obligations = [
        _object_dict(item)
        for item in _object_list(readiness.get("obligations"))
        if isinstance(item, dict) and item.get("applicable", True) is not False
    ]
    lines = [
        "Pack de preuve readiness",
        "",
        f"Genere le: {_object_text(payload.get('generated_at')) or '-'}",
        f"Statut global: {_object_text(readiness.get('status')) or '-'}",
        f"Prochaine action: {_object_text(readiness.get('next_action')) or '-'}",
        "",
        "Synthese",
        f"- Completion: {_object_int(summary.get('completion_rate'))}%",
        f"- Bloquants: {_object_int(summary.get('blocking_count'))}",
        f"- Surveillance: {_object_int(summary.get('watch_count'))}",
        f"- OK: {_object_int(summary.get('ok_count'))}",
        "",
        "Profil",
        f"- Pays: {_object_text(profile.get('country')) or '-'}",
        f"- Plan: {_object_text(profile.get('plan')) or '-'}",
        f"- Profil: {_object_text(profile.get('profile_label')) or '-'}",
        f"- Clients total: {_object_int(profile.get('customers_total'))}",
        f"- Clients FR B2B: {_object_int(profile.get('fr_b2b_customers'))}",
        f"- Autres flux: {_object_int(profile.get('other_flows_customers'))}",
        "",
        "Preuves disponibles",
        f"- Documents total: {_object_int(proof.get('documents_total'))}",
        f"- Documents emis: {_object_int(proof.get('documents_issued'))}",
        f"- Factur-X pret: {_object_int(proof.get('facturx_ready'))}",
        f"- Hashes emis: {_object_int(proof.get('hash_sealed'))}",
        f"- Dernier document emis: {_object_text(proof.get('latest_issued_at')) or '-'}",
        f"- Derniere transmission: {_object_text(proof.get('latest_transmission_at')) or '-'}",
    ]
    if obligations:
        lines.extend(["", "Obligations applicables"])
        for item in obligations:
            lines.append(
                f"- {item.get('title') or item.get('key')}: "
                f"{item.get('status') or '-'} "
                f"(echeance {item.get('deadline') or '-'})"
            )
    notes = [note for note in _object_list(payload.get("notes")) if isinstance(note, str) and note.strip()]
    if notes:
        lines.extend(["", "Notes"])
        lines.extend([f"- {note}" for note in notes])
    return "\n".join(lines) + "\n"


def build_readiness_proof_bundle_zip(
    db: Session,
    tenant_id: str,
    *,
    public_settings: dict[str, object] | None = None,
) -> tuple[str, str]:
    tenant = db.get(Tenant, tenant_id)
    if not tenant:
        raise ValueError("Entreprise introuvable.")
    payload = build_readiness_proof_export(
        db,
        tenant_id,
        public_settings=public_settings,
    )
    readiness = _object_dict(payload.get("readiness"))
    generated_at = _object_text(payload.get("generated_at")) or datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    timestamp = generated_at.replace(":", "").replace("-", "")
    slug = sanitize_filename(getattr(tenant, "tenant_slug", None) or getattr(tenant, "name", None) or "tenant")
    filename = f"readiness-proof-{slug}-{timestamp}.zip"

    tmp = NamedTemporaryFile(suffix=".zip", delete=False)
    tmp_path = tmp.name
    tmp.close()

    with zipfile.ZipFile(tmp_path, mode="w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(
            "readiness-proof.json",
            json.dumps(payload, ensure_ascii=False, indent=2),
        )
        archive.writestr(
            "readiness-summary.txt",
            _readiness_summary_text(payload),
        )
        archive.writestr(
            "public-settings.json",
            json.dumps(payload.get("public_settings") or {}, ensure_ascii=False, indent=2),
        )
        archive.writestr(
            "checklist-items.json",
            json.dumps(readiness.get("items") or [], ensure_ascii=False, indent=2),
        )
        archive.writestr(
            "obligations.json",
            json.dumps(readiness.get("obligations") or [], ensure_ascii=False, indent=2),
        )
        archive.writestr(
            "README.txt",
            "\n".join(
                [
                    "Pack de preuve readiness pour la preparation go-live et la reforme FR 2026-2027.",
                    "",
                    "Contenu:",
                    "- readiness-proof.json : export complet exploitable par machine",
                    "- readiness-summary.txt : synthese humaine rapide",
                    "- public-settings.json : moteurs et versions publics",
                    "- checklist-items.json : liste plate des controles",
                    "- obligations.json : obligations applicables et leurs echeances",
                    "",
                    "Ce bundle ne remplace pas un audit legal; il sert de preuve de preparation et de recette.",
                ]
            )
            + "\n",
        )

    return tmp_path, filename


def _iso(value: Any) -> str | None:
    if not value:
        return None
    try:
        return value.isoformat()
    except AttributeError:
        return str(value)


def _decimal_str(value: Any) -> str | None:
    if value is None:
        return None
    return str(value)


def _validation_status(errors: list[str]) -> dict[str, object]:
    if not errors:
        return {"status": "ok", "errors": []}
    status = "unavailable" if any("indisponible" in err.lower() for err in errors) else "error"
    return {"status": status, "errors": errors}


def _validation_status_with_warnings(errors: list[str], warnings: list[str]) -> dict[str, object]:
    if errors:
        status = "error"
    elif warnings:
        status = "warning"
    else:
        status = "ok"
    return {"status": status, "errors": errors, "warnings": warnings}


def _pdfa_proof(inv: Invoice) -> dict[str, object]:
    proof: dict[str, object] = {
        "available": False,
        "sha256": None,
        "stored_status": inv.pdfa3_status,
        "stored_report": sanitize_public_pdfa_report(inv.pdfa3_report, inv.pdfa3_status),
        "verapdf": public_verapdf_result(available=False, ok=None),
    }
    pdf_bytes = None
    if inv.facturx_key and head_object(inv.facturx_key):
        pdf_bytes = get_object_bytes(inv.facturx_key)
    if not pdf_bytes:
        proof["reason"] = "PDF Factur-X indisponible."
        return proof
    proof["available"] = True
    proof["sha256"] = hashlib.sha256(pdf_bytes).hexdigest()
    if shutil.which("verapdf"):
        with NamedTemporaryFile(suffix=".pdf") as tmp_pdf:
            tmp_pdf.write(pdf_bytes)
            tmp_pdf.flush()
            ok, output = _run_verapdf(tmp_pdf.name)
        if not ok:
            logger.warning(
                "compliance_report_verapdf_validation_failed",
                extra={
                    "invoice_id": inv.id,
                    "validator_output": output[:8000] if output else None,
                    "validator_output_truncated": bool(output and len(output) > 8000),
                },
            )
        proof["verapdf"] = public_verapdf_result(available=True, ok=ok)
    return proof


def _latest_transmission(
    transmissions: list[EInvoicingTransmission] | None,
) -> EInvoicingTransmission | None:
    if not transmissions:
        return None
    return max(
        transmissions,
        key=lambda tx: tx.updated_at or tx.created_at or datetime.min,
    )


def _transmission_payload(tx: EInvoicingTransmission | None) -> dict[str, object]:
    if not tx:
        return {
            "status": "not_sent",
            "channel": None,
            "external_id": None,
            "payload_hash": None,
            "created_at": None,
            "updated_at": None,
        }
    return {
        "status": tx.status,
        "channel": tx.channel,
        "external_id": tx.external_id,
        "payload_hash": tx.payload_hash,
        "created_at": _iso(tx.created_at),
        "updated_at": _iso(tx.updated_at),
    }


def _build_summary(
    cii_report: dict[str, object],
    fr_checks: list[dict[str, Any]],
    pdfa_proof: dict[str, object],
    fr_specs_v31: dict[str, object] | None,
) -> dict[str, object]:
    cii_payload = _object_dict(cii_report)
    pdfa_payload = _object_dict(pdfa_proof)
    fr_specs_payload = _object_dict(fr_specs_v31)
    blocking: list[dict[str, object]] = []
    if cii_payload.get("status") == "error":
        for err in _object_list(cii_payload.get("errors")):
            blocking.append({"source": "sanity_checks", "message": err})
    for check in fr_checks:
        status = (check.get("status") or "missing").lower()
        if status == "missing":
            blocking.append(
                {
                    "source": "fr_2026",
                    "code": check.get("code"),
                    "field": check.get("field"),
                    "message": check.get("message"),
                    "target": check.get("target"),
                }
            )
    for err in _object_list(fr_specs_payload.get("errors")):
        blocking.append({"source": "fr_specs_v31", "message": err})

    warnings: list[dict[str, object]] = []
    if cii_payload.get("status") == "unavailable":
        warnings.append(
            {
                "source": "sanity_checks",
                "message": (
                    "Le controle avance du document est temporairement indisponible. "
                    "Vous pouvez reessayer ou contacter le support si le probleme persiste."
                ),
            }
        )
    for check in fr_checks:
        if (check.get("status") or "").lower() == "info":
            warnings.append(
                {
                    "source": "fr_2026",
                    "code": check.get("code"),
                    "message": check.get("message"),
                    "target": check.get("target"),
                }
            )
    for warn in _object_list(fr_specs_payload.get("warnings")):
        warnings.append({"source": "fr_specs_v31", "message": warn})
    stored_status = (_object_text(pdfa_payload.get("stored_status")) or "").lower()
    if stored_status in {"warning", "failed"}:
        warnings.append(
            {
                "source": "pdfa",
                "message": _object_text(pdfa_payload.get("stored_report")) or "PDF/A-3 non conforme.",
            }
        )
    if not pdfa_payload.get("available"):
        warnings.append(
            {
                "source": "pdfa",
                "message": _object_text(pdfa_payload.get("reason")) or "PDF Factur-X indisponible.",
            }
        )
    verapdf = _object_dict(pdfa_payload.get("verapdf"))
    if verapdf.get("available") and verapdf.get("ok") is False:
        warnings.append(
            {
                "source": "verapdf",
                "message": _object_text(verapdf.get("message")) or "Le contrôle PDF/A-3 n’a pas validé le document.",
            }
        )

    if blocking:
        status = "error"
    elif warnings:
        status = "warning"
    else:
        status = "ok"
    return {"status": status, "blocking_issues": blocking, "warnings": warnings}


def build_compliance_report(
    inv: Invoice,
    tenant: Tenant,
    customer: Customer,
    ctx: dict[str, Any],
    transmissions: list[EInvoicingTransmission] | None = None,
) -> dict[str, object]:
    generated_at = datetime.now(timezone.utc).replace(tzinfo=None).replace(microsecond=0).isoformat() + "Z"
    cii_errors = validate_invoice_ctx(ctx)
    cii_report = _validation_status(cii_errors)
    fr_checks = validate_fr_einvoicing_fields(inv, tenant, customer)
    fr_specs_errors, fr_specs_warnings, fr_specs_meta = validate_fr_specs_v31(
        inv, tenant, customer, ctx.get("lines") if isinstance(ctx, dict) else None
    )
    fr_specs_report = _validation_status_with_warnings(fr_specs_errors, fr_specs_warnings)
    pdfa_proof = _pdfa_proof(inv)
    facturx_profile = resolve_facturx_profile(ctx, inv.facturx_profile)
    facturx_spec = inv.facturx_spec_version or settings.FACTURX_SPEC_VERSION
    latest_tx = _latest_transmission(transmissions)

    report: dict[str, object] = {
        "schema_version": COMPLIANCE_REPORT_SCHEMA_VERSION,
        "kind": "compliance_report",
        "invoice_id": inv.id,
        "generated_at": generated_at,
        "invoice": {
            "id": inv.id,
            "number": inv.number,
            "status": inv.status,
            "type": inv.type,
            "issue_date": _iso(inv.issue_date),
            "due_date": _iso(inv.due_date),
            "currency": inv.currency,
            "total_ex_vat": _decimal_str(inv.total_ex_vat),
            "total_vat": _decimal_str(inv.total_vat),
            "total_inc_vat": _decimal_str(inv.total_inc_vat),
        },
        "timestamps": {
            "created_at": _iso(inv.created_at),
            "issued_at": _iso(inv.issued_at),
            "sent_at": _iso(inv.sent_at),
            "paid_at": _iso(inv.paid_at),
            "transmission_updated_at": _iso(latest_tx.updated_at) if latest_tx else None,
        },
        "tenant": {
            "id": tenant.id,
            "name": tenant.name,
            "country": tenant.country,
            "siret": tenant.siret,
            "vat_number": tenant.vat_number,
        },
        "customer": {
            "id": customer.id,
            "name": customer.name,
            "country": customer.country,
            "siren": customer.siren,
            "siret": customer.siret,
            "vat_number": customer.vat_number,
        },
        "facturx": {
            "profile": facturx_profile,
            "spec_version": facturx_spec,
        },
        "sanity_checks": cii_report,
        "fr_checks": fr_checks,
        "fr_specs_v31": {**fr_specs_report, "metadata": fr_specs_meta},
        "pdfa": pdfa_proof,
        "transmission": _transmission_payload(latest_tx),
        "artifacts": {
            "pdf": {"available": bool(inv.pdf_key), "sha256": inv.pdf_checksum},
            "cii_xml": {"available": bool(inv.xml_key), "sha256": inv.xml_checksum},
            "facturx_pdf": {"available": bool(inv.facturx_key), "sha256": inv.facturx_checksum},
            "issued_hash": inv.issued_hash,
        },
        "summary": {},
    }

    report["summary"] = _build_summary(cii_report, fr_checks, pdfa_proof, fr_specs_report)
    return report


def _report_json_bytes(report: dict[str, object]) -> bytes:
    return json.dumps(
        report,
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
        default=str,
    ).encode("utf-8")


def store_compliance_report_json(
    invoice_id: str,
    report: dict[str, object],
    *,
    retain_until: datetime | None = None,
) -> str:
    key = invoice_artifact_key(invoice_id, COMPLIANCE_REPORT_JSON_KIND)
    put_object(key, _report_json_bytes(report), "application/json", legal_archive=True, retain_until=retain_until)
    return key


def render_compliance_report_pdf(report: dict[str, object]) -> bytes:
    html = env.get_template("compliance_report.html").render(report=report)
    return render_pdf(html)


def store_compliance_report_pdf(
    invoice_id: str,
    pdf_bytes: bytes,
    *,
    retain_until: datetime | None = None,
) -> str:
    key = invoice_artifact_key(invoice_id, COMPLIANCE_REPORT_PDF_KIND)
    put_object(key, pdf_bytes, "application/pdf", legal_archive=True, retain_until=retain_until)
    return key
