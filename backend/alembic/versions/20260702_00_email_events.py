"""Add email events table

Revision ID: 20260702_00
Revises: 20260701_05
Create Date: 2026-01-28
"""

from alembic import op
import sqlalchemy as sa


revision = "20260702_00"
down_revision = "20260701_05"
branch_labels = None
depends_on = None


def _table_exists(conn, name: str) -> bool:
    inspector = sa.inspect(conn)
    return name in inspector.get_table_names()


def _index_exists(conn, table: str, name: str) -> bool:
    inspector = sa.inspect(conn)
    return any(idx["name"] == name for idx in inspector.get_indexes(table))


def upgrade() -> None:
    conn = op.get_bind()
    if not _table_exists(conn, "email_events"):
        op.create_table(
            "email_events",
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column("tenant_id", sa.String(), sa.ForeignKey("tenants.id"), nullable=True),
            sa.Column("user_id", sa.String(), sa.ForeignKey("users.id"), nullable=True),
            sa.Column("invoice_id", sa.String(), sa.ForeignKey("invoices.id"), nullable=True),
            sa.Column("type", sa.String(), nullable=False),
            sa.Column("to", sa.String(), nullable=False),
            sa.Column("status", sa.String(), nullable=False, server_default="queued"),
            sa.Column("error", sa.Text(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("now()")),
            sa.Column("sent_at", sa.DateTime(), nullable=True),
        )
    if _table_exists(conn, "email_events"):
        if not _index_exists(conn, "email_events", "ix_email_events_tenant_id"):
            op.create_index("ix_email_events_tenant_id", "email_events", ["tenant_id"])
        if not _index_exists(conn, "email_events", "ix_email_events_user_id"):
            op.create_index("ix_email_events_user_id", "email_events", ["user_id"])
        if not _index_exists(conn, "email_events", "ix_email_events_invoice_id"):
            op.create_index("ix_email_events_invoice_id", "email_events", ["invoice_id"])


def downgrade() -> None:
    conn = op.get_bind()
    if _table_exists(conn, "email_events"):
        if _index_exists(conn, "email_events", "ix_email_events_invoice_id"):
            op.drop_index("ix_email_events_invoice_id", table_name="email_events")
        if _index_exists(conn, "email_events", "ix_email_events_user_id"):
            op.drop_index("ix_email_events_user_id", table_name="email_events")
        if _index_exists(conn, "email_events", "ix_email_events_tenant_id"):
            op.drop_index("ix_email_events_tenant_id", table_name="email_events")
        op.drop_table("email_events")
