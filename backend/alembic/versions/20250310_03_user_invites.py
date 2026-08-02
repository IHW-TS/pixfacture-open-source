"""Add user_invites table

Revision ID: 20250310_03
Revises: 20250205_02
Create Date: 2025-03-10
"""

from alembic import op
import sqlalchemy as sa


def _table_exists(conn, table: str) -> bool:
    inspector = sa.inspect(conn)
    return table in inspector.get_table_names()


def _index_exists(conn, table: str, name: str) -> bool:
    inspector = sa.inspect(conn)
    return any(idx["name"] == name for idx in inspector.get_indexes(table))


def _unique_constraint_exists(conn, table: str, columns: list[str]) -> bool:
    inspector = sa.inspect(conn)
    target = set(columns)
    for constraint in inspector.get_unique_constraints(table):
        if set(constraint.get("column_names") or []) == target:
            return True
    return False

# revision identifiers, used by Alembic.
revision = "20250310_03"
down_revision = "20250205_02"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    if not _table_exists(conn, "user_invites"):
        op.create_table(
            "user_invites",
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column("tenant_id", sa.String(), sa.ForeignKey("tenants.id"), nullable=False),
            sa.Column("email", sa.String(), nullable=False),
            sa.Column("role", sa.String(), nullable=False, server_default="accountant"),
            sa.Column("token_hash", sa.String(), nullable=False),
            sa.Column("invited_by_user_id", sa.String(), sa.ForeignKey("users.id"), nullable=True),
            sa.Column("accepted_by_user_id", sa.String(), sa.ForeignKey("users.id"), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("now()")),
            sa.Column("expires_at", sa.DateTime(), nullable=False),
            sa.Column("accepted_at", sa.DateTime(), nullable=True),
            sa.Column("revoked_at", sa.DateTime(), nullable=True),
        )
    if not _index_exists(conn, "user_invites", "ix_user_invites_tenant_id"):
        op.create_index("ix_user_invites_tenant_id", "user_invites", ["tenant_id"])
    if not _index_exists(conn, "user_invites", "ix_user_invites_email"):
        op.create_index("ix_user_invites_email", "user_invites", ["email"])
    if not _index_exists(conn, "user_invites", "ix_user_invites_invited_by_user_id"):
        op.create_index("ix_user_invites_invited_by_user_id", "user_invites", ["invited_by_user_id"])
    if not _index_exists(conn, "user_invites", "ix_user_invites_accepted_by_user_id"):
        op.create_index("ix_user_invites_accepted_by_user_id", "user_invites", ["accepted_by_user_id"])
    if not _index_exists(conn, "user_invites", "ix_user_invites_token_hash") and not _unique_constraint_exists(
        conn, "user_invites", ["token_hash"]
    ):
        op.create_index("ix_user_invites_token_hash", "user_invites", ["token_hash"], unique=True)
    if not _index_exists(conn, "user_invites", "ix_user_invites_active_email"):
        op.create_index(
            "ix_user_invites_active_email",
            "user_invites",
            ["tenant_id", "email"],
            unique=True,
            postgresql_where=sa.text("accepted_at IS NULL AND revoked_at IS NULL"),
        )


def downgrade() -> None:
    op.drop_index("ix_user_invites_active_email", table_name="user_invites")
    op.drop_index("ix_user_invites_token_hash", table_name="user_invites")
    op.drop_index("ix_user_invites_accepted_by_user_id", table_name="user_invites")
    op.drop_index("ix_user_invites_invited_by_user_id", table_name="user_invites")
    op.drop_index("ix_user_invites_email", table_name="user_invites")
    op.drop_index("ix_user_invites_tenant_id", table_name="user_invites")
    op.drop_table("user_invites")
