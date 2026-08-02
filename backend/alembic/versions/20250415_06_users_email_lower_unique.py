"""Add unique index on lower(users.email) for Postgres

Revision ID: 20250415_06
Revises: 20250401_05
Create Date: 2025-04-15
"""

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "20250415_06"
down_revision = "20250401_05"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    if conn.dialect.name != "postgresql":
        return

    dup = conn.execute(
        sa.text(
            """
            SELECT lower(email) AS norm, COUNT(*) AS cnt
            FROM users
            GROUP BY lower(email)
            HAVING COUNT(*) > 1
            LIMIT 1
            """
        )
    ).fetchone()
    if dup:
        raise RuntimeError(
            "Duplicate emails detected (case-insensitive). "
            "Please merge or update duplicates before applying this migration."
        )

    op.execute("CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email_lower ON users (lower(email))")


def downgrade() -> None:
    conn = op.get_bind()
    if conn.dialect.name != "postgresql":
        return
    op.execute("DROP INDEX IF EXISTS uq_users_email_lower")
