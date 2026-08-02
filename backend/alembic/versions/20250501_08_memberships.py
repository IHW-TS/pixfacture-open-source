"""Add memberships table and backfill from users

Revision ID: 20250501_08
Revises: 20250416_07
Create Date: 2025-05-01
"""

from alembic import op
import sqlalchemy as sa
import uuid
from datetime import datetime


def _table_exists(conn, table: str) -> bool:
    inspector = sa.inspect(conn)
    return table in inspector.get_table_names()

# revision identifiers, used by Alembic.
revision = "20250501_08"
down_revision = "20250416_07"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    if _table_exists(conn, "memberships"):
        return
    op.create_table(
        "memberships",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("user_id", sa.String(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("tenant_id", sa.String(), sa.ForeignKey("tenants.id"), nullable=False),
        sa.Column("role", sa.String(), nullable=False, server_default="viewer"),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("user_id", "tenant_id", name="uniq_membership_user_tenant"),
    )
    op.create_index("ix_memberships_user_id", "memberships", ["user_id"])
    op.create_index("ix_memberships_tenant_id", "memberships", ["tenant_id"])

    users = sa.table(
        "users",
        sa.column("id", sa.String()),
        sa.column("tenant_id", sa.String()),
        sa.column("role", sa.String()),
    )
    memberships = sa.table(
        "memberships",
        sa.column("id", sa.String()),
        sa.column("user_id", sa.String()),
        sa.column("tenant_id", sa.String()),
        sa.column("role", sa.String()),
        sa.column("created_at", sa.DateTime()),
    )
    rows = conn.execute(
        sa.select(users.c.id, users.c.tenant_id, users.c.role).where(users.c.tenant_id.isnot(None))
    ).fetchall()
    for row in rows:
        conn.execute(
            memberships.insert().values(
                id=str(uuid.uuid4()),
                user_id=row.id,
                tenant_id=row.tenant_id,
                role=row.role or "owner",
                created_at=datetime.utcnow(),
            )
        )


def downgrade() -> None:
    conn = op.get_bind()
    if not _table_exists(conn, "memberships"):
        return
    op.drop_index("ix_memberships_tenant_id", table_name="memberships")
    op.drop_index("ix_memberships_user_id", table_name="memberships")
    op.drop_table("memberships")
