"""Make invoice number nullable for drafts

Revision ID: 20260320_20
Revises: 20260315_19
Create Date: 2026-03-20
"""

from alembic import op
import sqlalchemy as sa

revision = "20260320_20"
down_revision = "20260315_19"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    existing_columns = {col["name"] for col in inspector.get_columns("invoices")}
    if "number" in existing_columns:
        op.alter_column(
            "invoices",
            "number",
            existing_type=sa.String(),
            nullable=True,
        )


def downgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    existing_columns = {col["name"] for col in inspector.get_columns("invoices")}
    if "number" in existing_columns:
        op.alter_column(
            "invoices",
            "number",
            existing_type=sa.String(),
            nullable=False,
        )
