"""Add partner e-invoice transmissions table

Revision ID: 20260605_00
Revises: 20260604_00
Create Date: 2026-06-05
"""

from alembic import op
import sqlalchemy as sa


revision = "20260605_00"
down_revision = "20260604_00"
branch_labels = None
depends_on = None


def _table_exists(conn, table: str) -> bool:
    inspector = sa.inspect(conn)
    return table in inspector.get_table_names()


def upgrade() -> None:
    conn = op.get_bind()
    if _table_exists(conn, "einvoice_transmissions"):
        return
    op.create_table(
        "einvoice_transmissions",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("tenant_id", sa.String(), sa.ForeignKey("tenants.id"), nullable=False),
        sa.Column("invoice_id", sa.String(), sa.ForeignKey("invoices.id"), nullable=False),
        sa.Column("direction", sa.String(), nullable=False, server_default="OUT"),
        sa.Column("platform", sa.String(), nullable=False),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("external_id", sa.String(), nullable=True),
        sa.Column("error_code", sa.String(), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("raw_events", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.Column("last_event_at", sa.DateTime(), nullable=True),
    )
    op.create_index("ix_einvoice_transmissions_tenant_id", "einvoice_transmissions", ["tenant_id"])
    op.create_index("ix_einvoice_transmissions_invoice_id", "einvoice_transmissions", ["invoice_id"])
    op.create_index("ix_einvoice_transmissions_external_id", "einvoice_transmissions", ["external_id"])
    op.create_index("ix_einvoice_transmissions_platform", "einvoice_transmissions", ["platform"])


def downgrade() -> None:
    conn = op.get_bind()
    if not _table_exists(conn, "einvoice_transmissions"):
        return
    op.drop_index("ix_einvoice_transmissions_platform", table_name="einvoice_transmissions")
    op.drop_index("ix_einvoice_transmissions_external_id", table_name="einvoice_transmissions")
    op.drop_index("ix_einvoice_transmissions_invoice_id", table_name="einvoice_transmissions")
    op.drop_index("ix_einvoice_transmissions_tenant_id", table_name="einvoice_transmissions")
    op.drop_table("einvoice_transmissions")
