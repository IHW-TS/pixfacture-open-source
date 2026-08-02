"""document attachments (invoices/quotes)

Revision ID: 20260707_00
Revises: 20260706_00
Create Date: 2026-07-07

"""

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "20260707_00"
down_revision = "20260706_00"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "document_attachments",
        sa.Column("id", sa.String(), primary_key=True, nullable=False),
        sa.Column("tenant_id", sa.String(), sa.ForeignKey("tenants.id"), nullable=False),
        sa.Column("invoice_id", sa.String(), sa.ForeignKey("invoices.id"), nullable=True),
        sa.Column("quote_id", sa.String(), sa.ForeignKey("quotes.id"), nullable=True),
        sa.Column("filename", sa.String(), nullable=False),
        sa.Column("label", sa.String(), nullable=True),
        sa.Column("content_type", sa.String(), nullable=False),
        sa.Column("size_bytes", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("sha256", sa.String(), nullable=True),
        sa.Column("storage_key", sa.String(), nullable=False),
        sa.Column("public_visible", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("now()")),
        sa.Column("created_by", sa.String(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
        sa.Column("updated_by", sa.String(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("deleted_at", sa.DateTime(), nullable=True),
        sa.Column("deleted_by", sa.String(), sa.ForeignKey("users.id"), nullable=True),
        sa.CheckConstraint(
            "((invoice_id IS NOT NULL)::int + (quote_id IS NOT NULL)::int) = 1",
            name="ck_document_attachments_one_parent",
        ),
    )

    op.create_index("ix_document_attachments_tenant_created", "document_attachments", ["tenant_id", "created_at"])
    op.create_index("ix_document_attachments_invoice_created", "document_attachments", ["invoice_id", "created_at"])
    op.create_index("ix_document_attachments_quote_created", "document_attachments", ["quote_id", "created_at"])


def downgrade():
    op.drop_index("ix_document_attachments_quote_created", table_name="document_attachments")
    op.drop_index("ix_document_attachments_invoice_created", table_name="document_attachments")
    op.drop_index("ix_document_attachments_tenant_created", table_name="document_attachments")
    op.drop_table("document_attachments")
