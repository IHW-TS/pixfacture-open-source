"""Source-controlled registry of formally adopted legal documents.

Only a version/hash pair backed by a completed adoption process belongs here.
Candidate documents must stay out of this registry until the authorised
representative has signed the corresponding adoption act.
"""

from __future__ import annotations


ADOPTED_LEGAL_DOCUMENTS: dict[str, dict[str, str]] = {
    "terms": {
        "2026-07-11": "7290601f7104b167678e1e9a8a51905080cdde443b7c7104e669d0b892671595",
    },
    "dpa": {
        "2026-07-11": "8406bd32c5e3d640ffc9fcf2e6eccc69d4f24f1f252850a9296cb77e1327488a",
    },
}

# The self-service product opens a seven-day Pro trial. Public signup must
# remain closed until the terms version describing that exact trial has been
# signed, added to ADOPTED_LEGAL_DOCUMENTS and activated atomically.
PUBLIC_PRO_TRIAL_TERMS_VERSION = "2026-07-14"


def adopted_legal_document_hash(slug: str | None, version: str | None) -> str | None:
    normalized_slug = (slug or "").strip().lower()
    normalized_version = (version or "").strip()
    return ADOPTED_LEGAL_DOCUMENTS.get(normalized_slug, {}).get(normalized_version)


def is_adopted_legal_document(
    slug: str | None,
    version: str | None,
    document_sha256: str | None,
) -> bool:
    expected = adopted_legal_document_hash(slug, version)
    normalized_hash = (document_sha256 or "").strip().lower()
    return bool(expected and normalized_hash == expected)
