"""seqino welcome tokens and ledger normalization

Revision ID: 20260708_00
Revises: 20260707_00
Create Date: 2026-07-08
"""

from alembic import op
import sqlalchemy as sa


revision = "20260708_00"
down_revision = "20260707_00"
branch_labels = None
depends_on = None


def _column_exists(conn, table: str, column: str) -> bool:
    inspector = sa.inspect(conn)
    try:
        columns = inspector.get_columns(table)
    except Exception:
        return False
    return any(col.get("name") == column for col in columns)


def upgrade() -> None:
    conn = op.get_bind()
    if not _column_exists(conn, "token_wallets", "welcome_bonus_granted_at"):
        op.add_column("token_wallets", sa.Column("welcome_bonus_granted_at", sa.DateTime(), nullable=True))
    op.execute(
        sa.text(
            """
            UPDATE token_ledger
            SET type = 'usage'
            WHERE type = 'consume'
            """
        )
    )


def downgrade() -> None:
    conn = op.get_bind()
    if _column_exists(conn, "token_wallets", "welcome_bonus_granted_at"):
        op.drop_column("token_wallets", "welcome_bonus_granted_at")
    op.execute(
        sa.text(
            """
            UPDATE token_ledger
            SET type = 'consume'
            WHERE type = 'usage'
            """
        )
    )
