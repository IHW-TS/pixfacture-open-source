"""widen sales monetary precision

Revision ID: 20260807_sales_amount_precision
Revises: 20260806_harden_portal_defaults
Create Date: 2026-06-11
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260807_sales_amount_precision"
down_revision = "20260806_harden_portal_defaults"
branch_labels = None
depends_on = None


MONEY_COLUMNS: dict[str, list[tuple[str, tuple[int, int]]]] = {
    "products": [("unit_price", (10, 2))],
    "invoices": [
        ("total_ex_vat", (12, 2)),
        ("total_vat", (12, 2)),
        ("total_inc_vat", (12, 2)),
        ("allowance_total", (12, 2)),
        ("charge_total", (12, 2)),
    ],
    "invoice_deposit_applications": [
        ("amount_ht", (12, 2)),
        ("amount_vat", (12, 2)),
        ("amount_ttc", (12, 2)),
    ],
    "invoice_lines": [
        ("quantity", (10, 2)),
        ("unit_price", (10, 2)),
        ("line_total", (12, 2)),
    ],
    "quotes": [
        ("total_ex_vat", (12, 2)),
        ("total_vat", (12, 2)),
        ("total_inc_vat", (12, 2)),
    ],
    "quote_lines": [
        ("quantity", (10, 2)),
        ("unit_price", (10, 2)),
        ("line_total", (12, 2)),
    ],
    "payments": [("amount", (12, 2))],
    "credit_note_refunds": [("amount", (12, 2))],
    "inbound_invoices": [
        ("total_ex_vat", (12, 2)),
        ("total_vat", (12, 2)),
        ("total_ttc", (12, 2)),
        ("employee_reimbursement_amount", (12, 2)),
    ],
    "purchase_payments": [("amount", (12, 2))],
}


def _table_columns(conn, table_name: str) -> set[str]:
    inspector = sa.inspect(conn)
    if table_name not in inspector.get_table_names():
        return set()
    return {column["name"] for column in inspector.get_columns(table_name)}


def _alter_numeric(table_name: str, column_name: str, existing_precision: int, existing_scale: int) -> None:
    op.alter_column(
        table_name,
        column_name,
        type_=sa.Numeric(20, 2),
        existing_type=sa.Numeric(existing_precision, existing_scale),
        existing_nullable=True,
    )


def upgrade() -> None:
    conn = op.get_bind()
    for table_name, columns in MONEY_COLUMNS.items():
        existing_columns = _table_columns(conn, table_name)
        if not existing_columns:
            continue
        for column_name, (precision, scale) in columns:
            if column_name in existing_columns:
                _alter_numeric(table_name, column_name, precision, scale)


def downgrade() -> None:
    # Non-destructive downgrade: keeping the wider precision avoids truncating
    # documents that may already have been created with larger amounts.
    return
