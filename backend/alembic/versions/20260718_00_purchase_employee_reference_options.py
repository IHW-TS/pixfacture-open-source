"""Add purchase employee payer reference options

Revision ID: 20260718_purchase_employee_opts
Revises: 20260717_purchase_refs
Create Date: 2026-07-18 00:00:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = "20260718_purchase_employee_opts"
down_revision = "20260717_purchase_refs"
branch_labels = None
depends_on = None


def _column_exists(conn, table_name: str, column_name: str) -> bool:
    inspector = sa.inspect(conn)
    return any(column["name"] == column_name for column in inspector.get_columns(table_name))


def upgrade() -> None:
    conn = op.get_bind()
    table = "purchase_employee_payers"
    if not _column_exists(conn, table, "user_label"):
        op.add_column(table, sa.Column("user_label", sa.String(), nullable=True))
    if not _column_exists(conn, table, "vehicle_type"):
        op.add_column(table, sa.Column("vehicle_type", sa.String(), nullable=True))
    if not _column_exists(conn, table, "fiscal_power"):
        op.add_column(table, sa.Column("fiscal_power", sa.String(), nullable=True))


def downgrade() -> None:
    conn = op.get_bind()
    table = "purchase_employee_payers"
    if _column_exists(conn, table, "fiscal_power"):
        op.drop_column(table, "fiscal_power")
    if _column_exists(conn, table, "vehicle_type"):
        op.drop_column(table, "vehicle_type")
    if _column_exists(conn, table, "user_label"):
        op.drop_column(table, "user_label")
