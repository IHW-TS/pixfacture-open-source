"""quote_ultra

Ajoute (B2B Ultra):
- Portail devis : tracking vues (count + first/last)
- Preuve / scellé : hash + snapshots (supplier/buyer/lines/totals)
- OTP acceptation devis (hash, email, expire, attempts)
- CGV acceptées (url + date)
- Config tenant : mode acceptation (simple|otp), CGV, templates OTP
- Overrides FEC par tenant
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect
from sqlalchemy.dialects.postgresql import JSONB


revision = "20260704_02"
down_revision = "20260704_01"
branch_labels = None
depends_on = None


def _col_exists(table: str, col: str) -> bool:
    bind = op.get_bind()
    insp = inspect(bind)
    cols = [c["name"] for c in insp.get_columns(table)]
    return col in cols


def upgrade():
    # tenants
    with op.batch_alter_table("tenants") as batch:
        if not _col_exists("tenants", "quote_acceptance_mode"):
            batch.add_column(
                sa.Column(
                    "quote_acceptance_mode",
                    sa.String(),
                    nullable=False,
                    server_default="simple",
                )
            )
        if not _col_exists("tenants", "quote_terms_url"):
            batch.add_column(sa.Column("quote_terms_url", sa.Text(), nullable=True))
        if not _col_exists("tenants", "quote_terms_required"):
            batch.add_column(
                sa.Column(
                    "quote_terms_required",
                    sa.Boolean(),
                    nullable=False,
                    server_default=sa.false(),
                )
            )
        if not _col_exists("tenants", "quote_otp_subject_default"):
            batch.add_column(sa.Column("quote_otp_subject_default", sa.Text(), nullable=True))
        if not _col_exists("tenants", "quote_otp_body_default"):
            batch.add_column(sa.Column("quote_otp_body_default", sa.Text(), nullable=True))

        # FEC overrides
        if not _col_exists("tenants", "fec_journal_code"):
            batch.add_column(sa.Column("fec_journal_code", sa.String(), nullable=True))
        if not _col_exists("tenants", "fec_journal_label"):
            batch.add_column(sa.Column("fec_journal_label", sa.String(), nullable=True))
        if not _col_exists("tenants", "fec_account_customer"):
            batch.add_column(sa.Column("fec_account_customer", sa.String(), nullable=True))
        if not _col_exists("tenants", "fec_account_revenue"):
            batch.add_column(sa.Column("fec_account_revenue", sa.String(), nullable=True))
        if not _col_exists("tenants", "fec_account_vat"):
            batch.add_column(sa.Column("fec_account_vat", sa.String(), nullable=True))

    # quotes
    with op.batch_alter_table("quotes") as batch:
        if not _col_exists("quotes", "public_view_count"):
            batch.add_column(sa.Column("public_view_count", sa.Integer(), nullable=False, server_default="0"))
        if not _col_exists("quotes", "public_first_viewed_at"):
            batch.add_column(sa.Column("public_first_viewed_at", sa.DateTime(), nullable=True))
        if not _col_exists("quotes", "public_last_viewed_at"):
            batch.add_column(sa.Column("public_last_viewed_at", sa.DateTime(), nullable=True))

        if not _col_exists("quotes", "seal_hash"):
            batch.add_column(sa.Column("seal_hash", sa.String(), nullable=True))
        if not _col_exists("quotes", "seal_created_at"):
            batch.add_column(sa.Column("seal_created_at", sa.DateTime(), nullable=True))

        json_type = sa.JSON().with_variant(JSONB, "postgresql")
        if not _col_exists("quotes", "supplier_snapshot"):
            batch.add_column(sa.Column("supplier_snapshot", json_type, nullable=True))
        if not _col_exists("quotes", "buyer_snapshot"):
            batch.add_column(sa.Column("buyer_snapshot", json_type, nullable=True))
        if not _col_exists("quotes", "lines_snapshot"):
            batch.add_column(sa.Column("lines_snapshot", json_type, nullable=True))
        if not _col_exists("quotes", "totals_snapshot"):
            batch.add_column(sa.Column("totals_snapshot", json_type, nullable=True))

        if not _col_exists("quotes", "otp_hash"):
            batch.add_column(sa.Column("otp_hash", sa.String(), nullable=True))
        if not _col_exists("quotes", "otp_email"):
            batch.add_column(sa.Column("otp_email", sa.String(), nullable=True))
        if not _col_exists("quotes", "otp_expires_at"):
            batch.add_column(sa.Column("otp_expires_at", sa.DateTime(), nullable=True))
        if not _col_exists("quotes", "otp_attempts"):
            batch.add_column(sa.Column("otp_attempts", sa.Integer(), nullable=False, server_default="0"))
        if not _col_exists("quotes", "otp_last_sent_at"):
            batch.add_column(sa.Column("otp_last_sent_at", sa.DateTime(), nullable=True))

        if not _col_exists("quotes", "accepted_terms_url"):
            batch.add_column(sa.Column("accepted_terms_url", sa.Text(), nullable=True))
        if not _col_exists("quotes", "accepted_terms_at"):
            batch.add_column(sa.Column("accepted_terms_at", sa.DateTime(), nullable=True))


def downgrade():
    # volontairement non destructif
    pass
