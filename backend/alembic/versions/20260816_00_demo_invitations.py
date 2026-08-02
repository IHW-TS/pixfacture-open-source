"""Add one-time demo invitations.

Revision ID: 20260816_demo_invitations
Revises: 20260815_provider_token_pool
"""

from alembic import op
import sqlalchemy as sa


revision = "20260816_demo_invitations"
down_revision = "20260815_provider_token_pool"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "demo_invitations",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("email", sa.String(), nullable=False),
        sa.Column("preset", sa.String(), nullable=False, server_default="services"),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("created_by_user_id", sa.String(), nullable=True),
        sa.Column("consumed_by_user_id", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        sa.Column("consumed_at", sa.DateTime(), nullable=True),
        sa.Column("revoked_at", sa.DateTime(), nullable=True),
        sa.CheckConstraint(
            "preset IN ('services', 'retail', 'construction', 'public_sector', 'health')",
            name="ck_demo_invitations_preset",
        ),
        sa.CheckConstraint("length(token_hash) = 64", name="ck_demo_invitations_token_hash_length"),
        sa.ForeignKeyConstraint(["consumed_by_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["created_by_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("token_hash", name="uq_demo_invitations_token_hash"),
    )
    op.create_index("ix_demo_invitations_email", "demo_invitations", ["email"], unique=False)
    op.create_index("ix_demo_invitations_expires_at", "demo_invitations", ["expires_at"], unique=False)
    op.create_index(
        "ix_demo_invitations_created_by_user_id",
        "demo_invitations",
        ["created_by_user_id"],
        unique=False,
    )
    op.create_index(
        "ix_demo_invitations_consumed_by_user_id",
        "demo_invitations",
        ["consumed_by_user_id"],
        unique=False,
    )
    op.create_index(
        "ix_demo_invitations_email_state",
        "demo_invitations",
        ["email", "consumed_at", "revoked_at", "expires_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_demo_invitations_email_state", table_name="demo_invitations")
    op.drop_index("ix_demo_invitations_consumed_by_user_id", table_name="demo_invitations")
    op.drop_index("ix_demo_invitations_created_by_user_id", table_name="demo_invitations")
    op.drop_index("ix_demo_invitations_expires_at", table_name="demo_invitations")
    op.drop_index("ix_demo_invitations_email", table_name="demo_invitations")
    op.drop_table("demo_invitations")
