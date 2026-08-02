"""Add tenant_slug and drop unique name constraint

Revision ID: 20250320_04
Revises: 20250310_03
Create Date: 2025-03-20
"""

from alembic import op
import sqlalchemy as sa
import re
import unicodedata

# revision identifiers, used by Alembic.
revision = "20250320_04"
down_revision = "20250310_03"
branch_labels = None
depends_on = None


def _slugify(value: str) -> str:
    raw = (value or "").strip().lower()
    normalized = unicodedata.normalize("NFKD", raw)
    ascii_only = normalized.encode("ascii", "ignore").decode("ascii")
    slug = re.sub(r"[^a-z0-9]+", "-", ascii_only).strip("-")
    return slug or "entreprise"


def _column_exists(conn, table: str, column: str) -> bool:
    inspector = sa.inspect(conn)
    return column in {col["name"] for col in inspector.get_columns(table)}


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


def upgrade() -> None:
    conn = op.get_bind()
    if not _column_exists(conn, "tenants", "tenant_slug"):
        op.add_column("tenants", sa.Column("tenant_slug", sa.String(), nullable=True))

        rows = conn.execute(sa.text("SELECT id, name FROM tenants")).fetchall()
        used: set[str] = set()
        for row in rows:
            base = _slugify(row.name)
            slug = base
            suffix = 2
            while slug in used:
                slug = f"{base}-{suffix}"
                suffix += 1
            used.add(slug)
            conn.execute(
                sa.text("UPDATE tenants SET tenant_slug = :slug WHERE id = :id"),
                {"slug": slug, "id": row.id},
            )

        op.alter_column("tenants", "tenant_slug", nullable=False)

    if not _index_exists(conn, "tenants", "ix_tenants_tenant_slug") and not _unique_constraint_exists(
        conn, "tenants", ["tenant_slug"]
    ):
        op.create_index("ix_tenants_tenant_slug", "tenants", ["tenant_slug"], unique=True)

    if conn.dialect.name == "postgresql":
        op.execute("ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_name_key")


def downgrade() -> None:
    conn = op.get_bind()
    if conn.dialect.name == "postgresql":
        op.execute("ALTER TABLE tenants ADD CONSTRAINT tenants_name_key UNIQUE (name)")
    op.drop_index("ix_tenants_tenant_slug", table_name="tenants")
    op.drop_column("tenants", "tenant_slug")
