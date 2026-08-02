"""quote_portal_email

Ajoute:
- Portail public devis (token public)
- Signature simple (nom/email/ip/ua)
- Relances (compteur + last_reminder)
- Emails devis (templates + email_events.quote_id)
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


revision = "20260704_01"
down_revision = "20260704_00"
branch_labels = None
depends_on = None


def _col_exists(table: str, col: str) -> bool:
    bind = op.get_bind()
    insp = inspect(bind)
    cols = [c["name"] for c in insp.get_columns(table)]
    return col in cols


def _index_exists(table: str, index_name: str) -> bool:
    bind = op.get_bind()
    insp = inspect(bind)
    idx = insp.get_indexes(table)
    return any(i.get("name") == index_name for i in idx)


def upgrade():
    # tenants: templates emails devis
    with op.batch_alter_table("tenants") as batch:
        if not _col_exists("tenants", "quote_email_subject_default"):
            batch.add_column(sa.Column("quote_email_subject_default", sa.Text(), nullable=True))
        if not _col_exists("tenants", "quote_email_body_default"):
            batch.add_column(sa.Column("quote_email_body_default", sa.Text(), nullable=True))
        if not _col_exists("tenants", "quote_followup_subject_default"):
            batch.add_column(sa.Column("quote_followup_subject_default", sa.Text(), nullable=True))
        if not _col_exists("tenants", "quote_followup_body_default"):
            batch.add_column(sa.Column("quote_followup_body_default", sa.Text(), nullable=True))

    # quotes: portail public + signature + relances
    with op.batch_alter_table("quotes") as batch:
        if not _col_exists("quotes", "public_token"):
            batch.add_column(sa.Column("public_token", sa.String(), nullable=True))
        if not _col_exists("quotes", "public_enabled"):
            batch.add_column(sa.Column("public_enabled", sa.Boolean(), nullable=False, server_default=sa.false()))
        if not _col_exists("quotes", "public_created_at"):
            batch.add_column(sa.Column("public_created_at", sa.DateTime(), nullable=True))

        if not _col_exists("quotes", "accepted_name"):
            batch.add_column(sa.Column("accepted_name", sa.String(), nullable=True))
        if not _col_exists("quotes", "accepted_email"):
            batch.add_column(sa.Column("accepted_email", sa.String(), nullable=True))
        if not _col_exists("quotes", "accepted_ip"):
            batch.add_column(sa.Column("accepted_ip", sa.String(), nullable=True))
        if not _col_exists("quotes", "accepted_user_agent"):
            batch.add_column(sa.Column("accepted_user_agent", sa.Text(), nullable=True))

        if not _col_exists("quotes", "rejected_reason"):
            batch.add_column(sa.Column("rejected_reason", sa.Text(), nullable=True))

        if not _col_exists("quotes", "reminder_count"):
            batch.add_column(sa.Column("reminder_count", sa.Integer(), nullable=False, server_default="0"))
        if not _col_exists("quotes", "last_reminder_at"):
            batch.add_column(sa.Column("last_reminder_at", sa.DateTime(), nullable=True))

    if not _index_exists("quotes", "ix_quotes_public_token"):
        op.create_index("ix_quotes_public_token", "quotes", ["public_token"], unique=True)

    # email_events: lien vers devis
    with op.batch_alter_table("email_events") as batch:
        if not _col_exists("email_events", "quote_id"):
            batch.add_column(sa.Column("quote_id", sa.String(), sa.ForeignKey("quotes.id"), nullable=True))
    if not _index_exists("email_events", "ix_email_events_quote_id"):
        op.create_index("ix_email_events_quote_id", "email_events", ["quote_id"])


def downgrade():
    # best effort
    with op.batch_alter_table("email_events") as batch:
        if _col_exists("email_events", "quote_id"):
            batch.drop_column("quote_id")
    try:
        op.drop_index("ix_email_events_quote_id", table_name="email_events")
    except Exception:
        pass

    try:
        op.drop_index("ix_quotes_public_token", table_name="quotes")
    except Exception:
        pass

    with op.batch_alter_table("quotes") as batch:
        for col in [
            "last_reminder_at",
            "reminder_count",
            "rejected_reason",
            "accepted_user_agent",
            "accepted_ip",
            "accepted_email",
            "accepted_name",
            "public_created_at",
            "public_enabled",
            "public_token",
        ]:
            if _col_exists("quotes", col):
                batch.drop_column(col)

    with op.batch_alter_table("tenants") as batch:
        for col in [
            "quote_followup_body_default",
            "quote_followup_subject_default",
            "quote_email_body_default",
            "quote_email_subject_default",
        ]:
            if _col_exists("tenants", col):
                batch.drop_column(col)
