from __future__ import annotations

from sqlalchemy.orm import Session

from ..models import Invoice, InvoiceArtifact


def has_stored_facturx_artifact(db: Session, inv: Invoice) -> bool:
    """Return true only when a final Factur-X artifact is recorded.

    Public portals should not advertise Factur-X just because the tenant is Pro
    or the invoice has a number; the artifact must exist in DB/storage metadata.
    """
    if not getattr(inv, "id", None) or not getattr(inv, "tenant_id", None):
        return False

    artifact = (
        db.query(InvoiceArtifact)
        .filter(
            InvoiceArtifact.invoice_id == inv.id,
            InvoiceArtifact.tenant_id == inv.tenant_id,
            InvoiceArtifact.kind == "FACTURX",
        )
        .first()
    )
    if artifact:
        return bool(
            (getattr(artifact, "storage_key", None) or getattr(artifact, "data", None))
            and getattr(artifact, "sha256", None)
            and int(getattr(artifact, "size_bytes", 0) or 0) > 0
        )

    # Backward-compatible legacy metadata check, but still require checksum/size.
    return bool(
        getattr(inv, "facturx_key", None)
        and getattr(inv, "facturx_checksum", None)
        and int(getattr(inv, "facturx_size", 0) or 0) > 0
    )
