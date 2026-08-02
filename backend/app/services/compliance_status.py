from __future__ import annotations

READY_LEVEL = "basic"

_SUPPORTED = [
    {
        "key": "facturx",
        "label": "Factur-X (EN16931)",
        "message": "Emission Factur-X (PDF + XML CII) pour facture sortante.",
    },
    {
        "key": "invoice_sanity_checks",
        "label": "Contrôles internes (CII)",
        "message": "Contrôles internes sur l'XML CII lors de l'emission.",
    },
    {
        "key": "fr_mentions",
        "label": "Mentions FR",
        "message": "Controle des mentions FR (SIREN client, nature d'operation, etc.).",
    },
    {
        "key": "ppf_directory",
        "label": "Annuaire officiel PPF",
        "message": "Recherche/synchronisation annuaire PPF pour le routage.",
    },
]

_NOT_SUPPORTED = [
    {
        "key": "e_reporting",
        "label": "E-reporting complet",
        "message": "E-reporting fiscal complet non supporte actuellement.",
    },
    {
        "key": "incoming_invoices",
        "label": "Reception de factures",
        "message": "Pas de reception/ingestion des factures entrantes.",
    },
    {
        "key": "pdp_interop",
        "label": "Interop PDP standard",
        "message": "Interop réglementaire via plateforme partenaire non encore disponible.",
    },
]


def build_capabilities() -> dict:
    return {"reform_preparation": READY_LEVEL}


def build_compliance_status() -> dict:
    return {
        "einvoicing_fr_ready_level": READY_LEVEL,
        "supported": [dict(item) for item in _SUPPORTED],
        "not_supported": [dict(item) for item in _NOT_SUPPORTED],
        "capabilities": build_capabilities(),
    }
