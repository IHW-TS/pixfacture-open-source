"""purchase workflow states table

Revision ID: 20260805_purchase_workflow
Revises: 20260804_inbound_attachment_size
Create Date: 2026-06-09
"""

from alembic import op
import sqlalchemy as sa


revision = "20260805_purchase_workflow"
down_revision = "20260804_inbound_attachment_size"
branch_labels = None
depends_on = None


def _table_exists(conn, table_name: str) -> bool:
    inspector = sa.inspect(conn)
    return table_name in inspector.get_table_names()


def _index_exists(conn, table_name: str, index_name: str) -> bool:
    inspector = sa.inspect(conn)
    return any(index.get("name") == index_name for index in inspector.get_indexes(table_name))


def upgrade() -> None:
    conn = op.get_bind()
    if not _table_exists(conn, "purchase_workflow_states"):
        op.create_table(
            "purchase_workflow_states",
            sa.Column("id", sa.String(), nullable=False),
            sa.Column("tenant_id", sa.String(), nullable=False),
            sa.Column("inbound_invoice_id", sa.String(), nullable=False),
            sa.Column("state", sa.String(), nullable=False, server_default="new"),
            sa.Column("owner_role", sa.String(), nullable=True),
            sa.Column("note", sa.Text(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.Column("updated_at", sa.DateTime(), nullable=False),
            sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"]),
            sa.ForeignKeyConstraint(["inbound_invoice_id"], ["inbound_invoices.id"]),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("tenant_id", "inbound_invoice_id", name="uniq_purchase_workflow_invoice"),
        )
    if not _index_exists(conn, "purchase_workflow_states", "ix_purchase_workflow_states_tenant_id"):
        op.create_index("ix_purchase_workflow_states_tenant_id", "purchase_workflow_states", ["tenant_id"])
    if not _index_exists(conn, "purchase_workflow_states", "ix_purchase_workflow_states_inbound_invoice_id"):
        op.create_index(
            "ix_purchase_workflow_states_inbound_invoice_id",
            "purchase_workflow_states",
            ["inbound_invoice_id"],
        )
    if not _index_exists(conn, "purchase_workflow_states", "ix_purchase_workflow_tenant_state"):
        op.create_index("ix_purchase_workflow_tenant_state", "purchase_workflow_states", ["tenant_id", "state"])
    if not _index_exists(conn, "purchase_workflow_states", "ix_purchase_workflow_tenant_updated"):
        op.create_index("ix_purchase_workflow_tenant_updated", "purchase_workflow_states", ["tenant_id", "updated_at"])


def downgrade() -> None:
    conn = op.get_bind()
    if not _table_exists(conn, "purchase_workflow_states"):
        return
    for index_name in (
        "ix_purchase_workflow_tenant_updated",
        "ix_purchase_workflow_tenant_state",
        "ix_purchase_workflow_states_inbound_invoice_id",
        "ix_purchase_workflow_states_tenant_id",
    ):
        if _index_exists(conn, "purchase_workflow_states", index_name):
            op.drop_index(index_name, table_name="purchase_workflow_states")
    op.drop_table("purchase_workflow_states")
