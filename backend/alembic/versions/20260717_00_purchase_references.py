"""Add purchase supplier and employee payer references

Revision ID: 20260717_purchase_refs
Revises: 20260716_emp_reimburse
Create Date: 2026-05-10
"""

from alembic import op
import sqlalchemy as sa


revision = "20260717_purchase_refs"
down_revision = "20260716_emp_reimburse"
branch_labels = None
depends_on = None


def _table_exists(conn, table_name: str) -> bool:
    return table_name in sa.inspect(conn).get_table_names()


def _index_exists(conn, table_name: str, index_name: str) -> bool:
    if not _table_exists(conn, table_name):
        return False
    return any(index["name"] == index_name for index in sa.inspect(conn).get_indexes(table_name))


def upgrade() -> None:
    conn = op.get_bind()
    if not _table_exists(conn, "purchase_suppliers"):
        op.create_table(
            "purchase_suppliers",
            sa.Column("id", sa.String(), nullable=False),
            sa.Column("tenant_id", sa.String(), nullable=False),
            sa.Column("name", sa.String(), nullable=False),
            sa.Column("normalized_name", sa.String(), nullable=False),
            sa.Column("siren", sa.String(), nullable=True),
            sa.Column("siret", sa.String(), nullable=True),
            sa.Column("vat_number", sa.String(), nullable=True),
            sa.Column("default_accounting_account", sa.String(), nullable=True),
            sa.Column("default_purchase_nature", sa.String(), nullable=True),
            sa.Column("default_payment_delay_days", sa.Integer(), nullable=True),
            sa.Column("notes", sa.Text(), nullable=True),
            sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
            sa.Column("last_used_at", sa.DateTime(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.Column("updated_at", sa.DateTime(), nullable=False),
            sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"]),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("tenant_id", "normalized_name", name="uniq_purchase_suppliers_tenant_normalized_name"),
        )
    if not _index_exists(conn, "purchase_suppliers", "ix_purchase_suppliers_tenant_id"):
        op.create_index("ix_purchase_suppliers_tenant_id", "purchase_suppliers", ["tenant_id"], unique=False)
    if not _index_exists(conn, "purchase_suppliers", "ix_purchase_suppliers_siren"):
        op.create_index("ix_purchase_suppliers_siren", "purchase_suppliers", ["siren"], unique=False)
    if not _index_exists(conn, "purchase_suppliers", "ix_purchase_suppliers_siret"):
        op.create_index("ix_purchase_suppliers_siret", "purchase_suppliers", ["siret"], unique=False)
    if not _index_exists(conn, "purchase_suppliers", "ix_purchase_suppliers_tenant_siren"):
        op.create_index("ix_purchase_suppliers_tenant_siren", "purchase_suppliers", ["tenant_id", "siren"], unique=False)
    if not _index_exists(conn, "purchase_suppliers", "ix_purchase_suppliers_tenant_siret"):
        op.create_index("ix_purchase_suppliers_tenant_siret", "purchase_suppliers", ["tenant_id", "siret"], unique=False)

    if not _table_exists(conn, "purchase_employee_payers"):
        op.create_table(
            "purchase_employee_payers",
            sa.Column("id", sa.String(), nullable=False),
            sa.Column("tenant_id", sa.String(), nullable=False),
            sa.Column("name", sa.String(), nullable=False),
            sa.Column("normalized_name", sa.String(), nullable=False),
            sa.Column("role", sa.String(), nullable=False, server_default="manager"),
            sa.Column("default_accounting_account", sa.String(), nullable=True),
            sa.Column("reimbursement_method", sa.String(), nullable=True),
            sa.Column("notes", sa.Text(), nullable=True),
            sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
            sa.Column("last_used_at", sa.DateTime(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.Column("updated_at", sa.DateTime(), nullable=False),
            sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"]),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("tenant_id", "normalized_name", name="uniq_purchase_employee_payers_tenant_normalized_name"),
        )
    if not _index_exists(conn, "purchase_employee_payers", "ix_purchase_employee_payers_tenant_id"):
        op.create_index("ix_purchase_employee_payers_tenant_id", "purchase_employee_payers", ["tenant_id"], unique=False)


def downgrade() -> None:
    conn = op.get_bind()
    if _table_exists(conn, "purchase_employee_payers"):
        op.drop_table("purchase_employee_payers")
    if _table_exists(conn, "purchase_suppliers"):
        op.drop_table("purchase_suppliers")
