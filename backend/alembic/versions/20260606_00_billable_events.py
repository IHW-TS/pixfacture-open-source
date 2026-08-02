"""Add billable events table

Revision ID: 20260606_00
Revises: 20260605_00
Create Date: 2026-06-06
"""

from alembic import op
import sqlalchemy as sa


revision = "20260606_00"
down_revision = "20260605_00"
branch_labels = None
depends_on = None


def _table_exists(conn, table: str) -> bool:
    inspector = sa.inspect(conn)
    return table in inspector.get_table_names()


def upgrade() -> None:
    conn = op.get_bind()
    if _table_exists(conn, "billable_events"):
        return
    op.create_table(
        "billable_events",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("tenant_id", sa.String(), sa.ForeignKey("tenants.id"), nullable=False),
        sa.Column("invoice_id", sa.String(), sa.ForeignKey("invoices.id"), nullable=True),
        sa.Column("event_type", sa.String(), nullable=False),
        sa.Column("provider_slug", sa.String(), nullable=True),
        sa.Column("status", sa.String(), nullable=True),
        sa.Column("source_type", sa.String(), nullable=False),
        sa.Column("source_id", sa.String(), nullable=False),
        sa.Column("occurred_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.UniqueConstraint("tenant_id", "source_type", "source_id", name="uniq_billable_event_source"),
    )
    op.create_index("ix_billable_events_tenant_id", "billable_events", ["tenant_id"])
    op.create_index("ix_billable_events_invoice_id", "billable_events", ["invoice_id"])
    op.create_index("ix_billable_events_tenant_occurred", "billable_events", ["tenant_id", "occurred_at"])


def downgrade() -> None:
    conn = op.get_bind()
    if not _table_exists(conn, "billable_events"):
        return
    op.drop_index("ix_billable_events_tenant_occurred", table_name="billable_events")
    op.drop_index("ix_billable_events_invoice_id", table_name="billable_events")
    op.drop_index("ix_billable_events_tenant_id", table_name="billable_events")
    op.drop_table("billable_events")
