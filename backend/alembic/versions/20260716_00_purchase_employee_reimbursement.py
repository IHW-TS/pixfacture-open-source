"""Add purchase employee reimbursement fields

Revision ID: 20260716_emp_reimburse
Revises: 20260715_purchase_completion
Create Date: 2026-05-10
"""

from alembic import op
import sqlalchemy as sa


revision = "20260716_emp_reimburse"
down_revision = "20260715_purchase_completion"
branch_labels = None
depends_on = None


def _table_exists(conn, table_name: str) -> bool:
    return table_name in sa.inspect(conn).get_table_names()


def _column_exists(conn, table_name: str, column_name: str) -> bool:
    if not _table_exists(conn, table_name):
        return False
    return any(column["name"] == column_name for column in sa.inspect(conn).get_columns(table_name))


def upgrade() -> None:
    conn = op.get_bind()
    columns = {
        "employee_payer_name": sa.Column("employee_payer_name", sa.String(), nullable=True),
        "employee_payer_role": sa.Column("employee_payer_role", sa.String(), nullable=True),
        "employee_reimbursement_amount": sa.Column("employee_reimbursement_amount", sa.Numeric(12, 2), nullable=True),
        "employee_reimbursement_due_date": sa.Column("employee_reimbursement_due_date", sa.Date(), nullable=True),
        "employee_reimbursement_method": sa.Column("employee_reimbursement_method", sa.String(), nullable=True),
        "employee_reimbursement_status": sa.Column("employee_reimbursement_status", sa.String(), nullable=True),
    }
    for name, column in columns.items():
        if not _column_exists(conn, "inbound_invoices", name):
            op.add_column("inbound_invoices", column)


def downgrade() -> None:
    conn = op.get_bind()
    for name in (
        "employee_reimbursement_status",
        "employee_reimbursement_method",
        "employee_reimbursement_due_date",
        "employee_reimbursement_amount",
        "employee_payer_role",
        "employee_payer_name",
    ):
        if _column_exists(conn, "inbound_invoices", name):
            op.drop_column("inbound_invoices", name)
