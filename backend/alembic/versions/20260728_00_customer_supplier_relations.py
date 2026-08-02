"""Add explicit customer supplier relations

Revision ID: 20260728_cust_supplier_rel
Revises: 20260727_export_cabinet_review
Create Date: 2026-05-19 18:20:00.000000
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260728_cust_supplier_rel"
down_revision = "20260727_export_cabinet_review"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "customer_supplier_relations",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("tenant_id", sa.String(), nullable=False),
        sa.Column("customer_id", sa.String(), nullable=False),
        sa.Column("supplier_id", sa.String(), nullable=False),
        sa.Column("relation_type", sa.String(), nullable=False),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("reason", sa.String(), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("confirmed_by_user_id", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["confirmed_by_user_id"], ["users.id"]),
        sa.ForeignKeyConstraint(["customer_id"], ["customers.id"]),
        sa.ForeignKeyConstraint(["supplier_id"], ["purchase_suppliers.id"]),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("tenant_id", "customer_id", "supplier_id", name="uniq_customer_supplier_relation_pair"),
    )
    op.create_index(
        "ix_customer_supplier_relations_customer_id",
        "customer_supplier_relations",
        ["customer_id"],
        unique=False,
    )
    op.create_index(
        "ix_customer_supplier_relations_supplier_id",
        "customer_supplier_relations",
        ["supplier_id"],
        unique=False,
    )
    op.create_index(
        "ix_customer_supplier_relations_tenant_customer",
        "customer_supplier_relations",
        ["tenant_id", "customer_id"],
        unique=False,
    )
    op.create_index(
        "ix_customer_supplier_relations_tenant_id",
        "customer_supplier_relations",
        ["tenant_id"],
        unique=False,
    )
    op.create_index(
        "ix_customer_supplier_relations_tenant_supplier",
        "customer_supplier_relations",
        ["tenant_id", "supplier_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_customer_supplier_relations_tenant_supplier", table_name="customer_supplier_relations")
    op.drop_index("ix_customer_supplier_relations_tenant_id", table_name="customer_supplier_relations")
    op.drop_index("ix_customer_supplier_relations_tenant_customer", table_name="customer_supplier_relations")
    op.drop_index("ix_customer_supplier_relations_supplier_id", table_name="customer_supplier_relations")
    op.drop_index("ix_customer_supplier_relations_customer_id", table_name="customer_supplier_relations")
    op.drop_table("customer_supplier_relations")
