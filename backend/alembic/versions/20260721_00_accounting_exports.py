"""Add accounting export history

Revision ID: 20260721_accounting_exports
Revises: 20260720_tenant_phone
Create Date: 2026-07-21 00:00:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = "20260721_accounting_exports"
down_revision = "20260720_tenant_phone"
branch_labels = None
depends_on = None


def _table_exists(conn, table_name: str) -> bool:
    inspector = sa.inspect(conn)
    return table_name in inspector.get_table_names()


def _index_exists(conn, table_name: str, index_name: str) -> bool:
    inspector = sa.inspect(conn)
    return any(index["name"] == index_name for index in inspector.get_indexes(table_name))


def upgrade() -> None:
    conn = op.get_bind()
    if not _table_exists(conn, "accounting_exports"):
        op.create_table(
            "accounting_exports",
            sa.Column("id", sa.String(), nullable=False),
            sa.Column("tenant_id", sa.String(), nullable=False),
            sa.Column("format", sa.String(), nullable=False),
            sa.Column("period_start", sa.Date(), nullable=True),
            sa.Column("period_end", sa.Date(), nullable=True),
            sa.Column("customer_id", sa.String(), nullable=True),
            sa.Column("record_count", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("filters", sa.JSON(), nullable=True),
            sa.Column("status", sa.String(), nullable=False, server_default="generated"),
            sa.Column("delivered_to_accountant_at", sa.DateTime(), nullable=True),
            sa.Column("delivered_to_accountant_by", sa.String(), nullable=True),
            sa.Column("created_by", sa.String(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.ForeignKeyConstraint(["created_by"], ["users.id"]),
            sa.ForeignKeyConstraint(["customer_id"], ["customers.id"]),
            sa.ForeignKeyConstraint(["delivered_to_accountant_by"], ["users.id"]),
            sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"]),
            sa.PrimaryKeyConstraint("id"),
        )
    if not _index_exists(conn, "accounting_exports", "ix_accounting_exports_tenant_id"):
        op.create_index("ix_accounting_exports_tenant_id", "accounting_exports", ["tenant_id"])
    if not _index_exists(conn, "accounting_exports", "ix_accounting_exports_format"):
        op.create_index("ix_accounting_exports_format", "accounting_exports", ["format"])
    if not _index_exists(conn, "accounting_exports", "ix_accounting_exports_customer_id"):
        op.create_index("ix_accounting_exports_customer_id", "accounting_exports", ["customer_id"])
    if not _index_exists(conn, "accounting_exports", "ix_accounting_exports_status"):
        op.create_index("ix_accounting_exports_status", "accounting_exports", ["status"])
    if not _index_exists(conn, "accounting_exports", "ix_accounting_exports_tenant_created"):
        op.create_index("ix_accounting_exports_tenant_created", "accounting_exports", ["tenant_id", "created_at"])
    if not _index_exists(conn, "accounting_exports", "ix_accounting_exports_tenant_period"):
        op.create_index(
            "ix_accounting_exports_tenant_period",
            "accounting_exports",
            ["tenant_id", "period_start", "period_end"],
        )
    if not _index_exists(conn, "accounting_exports", "ix_accounting_exports_tenant_status"):
        op.create_index("ix_accounting_exports_tenant_status", "accounting_exports", ["tenant_id", "status"])


def downgrade() -> None:
    conn = op.get_bind()
    if _table_exists(conn, "accounting_exports"):
        op.drop_table("accounting_exports")
