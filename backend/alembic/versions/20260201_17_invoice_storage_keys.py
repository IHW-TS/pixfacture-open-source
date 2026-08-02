"""Move invoice artefacts to object storage

Revision ID: 20260201_17
Revises: 20260118_16
Create Date: 2026-02-01
"""

from alembic import op
import sqlalchemy as sa
import hashlib

from app.services.storage import invoice_artifact_key, put_object


revision = "20260201_17"
down_revision = "20260118_16"
branch_labels = None
depends_on = None


def _column_exists(conn, table: str, column: str) -> bool:
    inspector = sa.inspect(conn)
    return column in {col["name"] for col in inspector.get_columns(table)}


def upgrade() -> None:
    conn = op.get_bind()
    if not _column_exists(conn, "invoices", "pdf_key"):
        op.add_column("invoices", sa.Column("pdf_key", sa.String(), nullable=True))
    if not _column_exists(conn, "invoices", "xml_key"):
        op.add_column("invoices", sa.Column("xml_key", sa.String(), nullable=True))
    if not _column_exists(conn, "invoices", "facturx_key"):
        op.add_column("invoices", sa.Column("facturx_key", sa.String(), nullable=True))
    if not _column_exists(conn, "invoices", "pdf_checksum"):
        op.add_column("invoices", sa.Column("pdf_checksum", sa.String(), nullable=True))
    if not _column_exists(conn, "invoices", "xml_checksum"):
        op.add_column("invoices", sa.Column("xml_checksum", sa.String(), nullable=True))
    if not _column_exists(conn, "invoices", "facturx_checksum"):
        op.add_column("invoices", sa.Column("facturx_checksum", sa.String(), nullable=True))

    has_pdf = _column_exists(conn, "invoices", "issued_pdf")
    has_xml = _column_exists(conn, "invoices", "issued_facturx_xml")
    has_facturx = _column_exists(conn, "invoices", "issued_facturx_pdf")
    if has_pdf or has_xml or has_facturx:
        cols = [
            "id",
            "pdf_key",
            "xml_key",
            "facturx_key",
            "pdf_checksum",
            "xml_checksum",
            "facturx_checksum",
        ]
        if has_pdf:
            cols.append("issued_pdf")
        if has_xml:
            cols.append("issued_facturx_xml")
        if has_facturx:
            cols.append("issued_facturx_pdf")
        query = f"SELECT {', '.join(cols)} FROM invoices"
        result = conn.execute(sa.text(query))
        while True:
            rows = result.fetchmany(100)
            if not rows:
                break
            for row in rows:
                data = row._mapping
                updates = {
                    "id": data["id"],
                    "pdf_key": data.get("pdf_key"),
                    "xml_key": data.get("xml_key"),
                    "facturx_key": data.get("facturx_key"),
                    "pdf_checksum": data.get("pdf_checksum"),
                    "xml_checksum": data.get("xml_checksum"),
                    "facturx_checksum": data.get("facturx_checksum"),
                }
                changed = False
                if has_pdf and data.get("issued_pdf") is not None and not data.get("pdf_key"):
                    payload = bytes(data["issued_pdf"])
                    key = invoice_artifact_key(data["id"], "pdf")
                    put_object(key, payload, "application/pdf")
                    updates["pdf_key"] = key
                    updates["pdf_checksum"] = hashlib.sha256(payload).hexdigest()
                    changed = True
                if has_xml and data.get("issued_facturx_xml") is not None and not data.get("xml_key"):
                    payload = bytes(data["issued_facturx_xml"])
                    key = invoice_artifact_key(data["id"], "xml")
                    put_object(key, payload, "application/xml")
                    updates["xml_key"] = key
                    updates["xml_checksum"] = hashlib.sha256(payload).hexdigest()
                    changed = True
                if has_facturx and data.get("issued_facturx_pdf") is not None and not data.get("facturx_key"):
                    payload = bytes(data["issued_facturx_pdf"])
                    key = invoice_artifact_key(data["id"], "facturx")
                    put_object(key, payload, "application/pdf")
                    updates["facturx_key"] = key
                    updates["facturx_checksum"] = hashlib.sha256(payload).hexdigest()
                    changed = True
                if changed:
                    conn.execute(
                        sa.text(
                            "UPDATE invoices SET "
                            "pdf_key=:pdf_key, xml_key=:xml_key, facturx_key=:facturx_key, "
                            "pdf_checksum=:pdf_checksum, xml_checksum=:xml_checksum, facturx_checksum=:facturx_checksum "
                            "WHERE id=:id"
                        ),
                        updates,
                    )

    if _column_exists(conn, "invoices", "issued_pdf"):
        op.drop_column("invoices", "issued_pdf")
    if _column_exists(conn, "invoices", "issued_facturx_xml"):
        op.drop_column("invoices", "issued_facturx_xml")
    if _column_exists(conn, "invoices", "issued_facturx_pdf"):
        op.drop_column("invoices", "issued_facturx_pdf")


def downgrade() -> None:
    conn = op.get_bind()
    if not _column_exists(conn, "invoices", "issued_pdf"):
        op.add_column("invoices", sa.Column("issued_pdf", sa.LargeBinary(), nullable=True))
    if not _column_exists(conn, "invoices", "issued_facturx_xml"):
        op.add_column("invoices", sa.Column("issued_facturx_xml", sa.LargeBinary(), nullable=True))
    if not _column_exists(conn, "invoices", "issued_facturx_pdf"):
        op.add_column("invoices", sa.Column("issued_facturx_pdf", sa.LargeBinary(), nullable=True))
    if _column_exists(conn, "invoices", "pdf_key"):
        op.drop_column("invoices", "pdf_key")
    if _column_exists(conn, "invoices", "xml_key"):
        op.drop_column("invoices", "xml_key")
    if _column_exists(conn, "invoices", "facturx_key"):
        op.drop_column("invoices", "facturx_key")
    if _column_exists(conn, "invoices", "pdf_checksum"):
        op.drop_column("invoices", "pdf_checksum")
    if _column_exists(conn, "invoices", "xml_checksum"):
        op.drop_column("invoices", "xml_checksum")
    if _column_exists(conn, "invoices", "facturx_checksum"):
        op.drop_column("invoices", "facturx_checksum")
