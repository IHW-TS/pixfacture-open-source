"""Add tenant country for Factur-X

Revision ID: 20260115_11
Revises: 20250524_10
Create Date: 2026-01-15
"""

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "20260115_11"
down_revision = "20250524_10"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    existing_columns = {col["name"] for col in inspector.get_columns("tenants")}

    if "country" not in existing_columns:
        if conn.dialect.name == "postgresql":
            op.execute("ALTER TABLE tenants ADD COLUMN country VARCHAR DEFAULT 'FR' NOT NULL")
        else:
            op.add_column(
                "tenants",
                sa.Column("country", sa.String(), nullable=False, server_default="FR"),
            )

    op.execute("UPDATE tenants SET country = 'FR' WHERE country IS NULL;")


def downgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    existing_columns = {col["name"] for col in inspector.get_columns("tenants")}
    if "country" in existing_columns:
        op.drop_column("tenants", "country")
