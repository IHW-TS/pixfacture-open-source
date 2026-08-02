"""Add vat_exemption_notice to tenants

Revision ID: 20250401_05
Revises: 20250320_04
Create Date: 2025-04-01
"""

from alembic import op
import sqlalchemy as sa


def _column_exists(conn, table: str, column: str) -> bool:
    inspector = sa.inspect(conn)
    return column in {col["name"] for col in inspector.get_columns(table)}

# revision identifiers, used by Alembic.
revision = "20250401_05"
down_revision = "20250320_04"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    if not _column_exists(conn, "tenants", "vat_exemption_notice"):
        op.add_column("tenants", sa.Column("vat_exemption_notice", sa.Text(), nullable=True))


def downgrade() -> None:
    conn = op.get_bind()
    if _column_exists(conn, "tenants", "vat_exemption_notice"):
        op.drop_column("tenants", "vat_exemption_notice")
