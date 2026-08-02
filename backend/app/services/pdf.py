from collections.abc import Iterable
import io
import re
from pathlib import Path
from urllib.parse import urlparse, unquote
from datetime import date, datetime
from decimal import Decimal, InvalidOperation

from jinja2 import Environment, FileSystemLoader, select_autoescape
from weasyprint import HTML
from weasyprint.text.fonts import FontConfiguration
from fontTools.ttLib import TTFont
import pikepdf
from weasyprint.urls import URLFetchingError, default_url_fetcher
import pydyf

from ..utils.asset_security import (
    TEMPLATE_DIR,
    STATIC_DIR,
    allowed_cdn_hosts,
    is_private_host,
    resolve_static_path,
)
from .document_pdf_context import document_vat_labels, line_vat_reason_label

# weasyprint>=62 expects pydyf.Stream to expose transform/text_matrix; some
# 0.12.x builds miss them, so we polyfill with the available setters.
if not hasattr(pydyf.Stream, "transform"):
    def _transform(self, a=1, b=0, c=0, d=1, e=0, f=0):
        self.set_matrix(a, b, c, d, e, f)
    pydyf.Stream.transform = _transform

if not hasattr(pydyf.Stream, "text_matrix"):
    def _text_matrix(self, a=1, b=0, c=0, d=1, e=0, f=0):
        self.set_text_matrix(a, b, c, d, e, f)
    pydyf.Stream.text_matrix = _text_matrix

env = Environment(
    loader=FileSystemLoader(TEMPLATE_DIR),
    autoescape=select_autoescape(['html']),
)


def _to_decimal(value: object | None) -> Decimal:
    if value is None or value == "":
        return Decimal("0")
    try:
        return Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        return Decimal("0")


def _format_fr_amount(value: object | None, currency: str = "€") -> str:
    amount = _to_decimal(value).quantize(Decimal("0.01"))
    rendered = f"{amount:,.2f}".replace(",", " ").replace(".", ",")
    return f"{rendered} {currency}".strip()


def _format_fr_amount_compact(value: object | None, currency: str = "€") -> str:
    amount = _to_decimal(value).quantize(Decimal("0.01"))
    if amount == amount.to_integral_value():
        rendered = f"{amount:,.0f}".replace(",", " ")
    else:
        rendered = f"{amount:,.2f}".replace(",", " ").replace(".", ",")
    return f"{rendered} {currency}".strip()


def _format_fr_number(value: object | None, decimals: int = 2) -> str:
    quant = Decimal("1").scaleb(-decimals)
    number = _to_decimal(value).quantize(quant)
    rendered = f"{number:,.{decimals}f}".replace(",", " ").replace(".", ",")
    return rendered


def _format_fr_percent(value: object | None) -> str:
    return f"{_format_fr_number(value, 2)} %"


def _format_fr_date(value: object | None) -> str:
    if value is None or value == "":
        return ""
    if isinstance(value, datetime):
        return value.strftime("%d/%m/%Y")
    if isinstance(value, date):
        return value.strftime("%d/%m/%Y")
    text = str(value).strip()
    if not text:
        return ""
    for parser in (
        lambda raw: datetime.fromisoformat(raw.replace("Z", "+00:00")),
        lambda raw: datetime.strptime(raw, "%Y-%m-%d"),
        lambda raw: datetime.strptime(raw, "%d/%m/%Y"),
    ):
        try:
            return parser(text).strftime("%d/%m/%Y")
        except Exception:
            continue
    return text


def _multiline_text(value: object | None) -> str:
    text = str(value or "")
    return text.replace("\\r\\n", "\n").replace("\\n", "\n").replace("\r\n", "\n").strip()


def _format_postal_address(value: object | None) -> str:
    text = _multiline_text(value)
    if not text:
        return ""
    if "\n" in text:
        chunks = [part.strip() for part in text.splitlines() if part.strip()]
    else:
        chunks = [part.strip() for part in re.split(r",\s*", text) if part.strip()]
    lines: list[str] = []
    for chunk in chunks:
        chunk = re.sub(r"\s{2,}", " ", chunk).strip()
        match = re.match(r"^(.*?)(\b\d{5}\b\s+.+)$", chunk)
        if match and match.group(1).strip():
            candidates = [match.group(1).strip(), match.group(2).strip()]
        else:
            candidates = [chunk]
        for candidate in candidates:
            normalized = re.sub(r"[\s.\-]+", "", candidate).upper()
            if normalized in {"FR", "FRANCE"}:
                continue
            lines.append(candidate)
    return "\n".join(lines)


def _group_digits(value: object | None, groups: tuple[int, ...]) -> str:
    digits = re.sub(r"\D+", "", str(value or ""))
    if not digits:
        return ""
    chunks: list[str] = []
    cursor = 0
    for size in groups:
        if cursor >= len(digits):
            break
        chunks.append(digits[cursor : cursor + size])
        cursor += size
    if cursor < len(digits):
        chunks.append(digits[cursor:])
    return " ".join(chunk for chunk in chunks if chunk)


def _format_siren(value: object | None) -> str:
    return _group_digits(value, (3, 3, 3))


def _format_siret(value: object | None) -> str:
    return _group_digits(value, (3, 3, 3, 5))


def _format_vat_number(value: object | None) -> str:
    text = str(value or "").strip().upper()
    if not text:
        return ""
    country_match = re.match(r"^([A-Z]{2})\s*(.+)$", text)
    if not country_match:
        return _group_digits(text, (2, 3, 3, 3))
    country, rest = country_match.groups()
    digits = re.sub(r"\D+", "", rest)
    if not digits:
        return text
    return f"{country} {_group_digits(digits, (2, 3, 3, 3))}"


def _format_iban(value: object | None) -> str:
    raw = re.sub(r"\s+", "", str(value or "").strip()).upper()
    if not raw:
        return ""
    return " ".join(raw[index : index + 4] for index in range(0, len(raw), 4))


def _format_phone(value: object | None) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    compact = re.sub(r"[^\d+]+", "", raw)
    digits = re.sub(r"\D+", "", compact)
    if not digits:
        return raw
    if len(digits) == 10 and digits.startswith("0"):
        return " ".join(digits[index : index + 2] for index in range(0, len(digits), 2))
    if compact.startswith("+33") and len(digits) == 11:
        national = digits[2:]
        return f"+33 {national[:1]} {' '.join(national[index:index + 2] for index in range(1, len(national), 2))}".strip()
    if digits.startswith("0033") and len(digits) == 13:
        national = digits[4:]
        return f"+33 {national[:1]} {' '.join(national[index:index + 2] for index in range(1, len(national), 2))}".strip()
    if compact.startswith("+"):
        return f"+{' '.join(digits[index:index + 2] for index in range(0, len(digits), 2))}"
    return " ".join(digits[index : index + 2] for index in range(0, len(digits), 2))


def _natural_join(values: object, is_english: bool = False) -> str:
    if isinstance(values, (str, bytes)):
        items = [str(values).strip()]
    elif isinstance(values, Iterable):
        items = [str(item).strip() for item in values]
    else:
        items = [str(values or "").strip()]
    items = [item for item in items if item]
    if not items:
        return ""
    if len(items) == 1:
        return items[0]
    separator = " or " if is_english else " ou "
    return ", ".join(items[:-1]) + separator + items[-1]


env.filters["fr_amount"] = _format_fr_amount
env.filters["fr_amount_compact"] = _format_fr_amount_compact
env.filters["fr_number"] = _format_fr_number
env.filters["fr_percent"] = _format_fr_percent
env.filters["fr_date"] = _format_fr_date
env.filters["multiline_text"] = _multiline_text
env.filters["postal_address"] = _format_postal_address
env.filters["fr_siren"] = _format_siren
env.filters["fr_siret"] = _format_siret
env.filters["fr_vat"] = _format_vat_number
env.filters["fr_iban"] = _format_iban
env.filters["fr_phone"] = _format_phone
env.filters["natural_join"] = _natural_join
env.globals["document_vat_labels"] = document_vat_labels
env.globals["line_vat_reason_label"] = line_vat_reason_label

def _placeholder_response(url: str) -> dict[str, object]:
    raise URLFetchingError(f"Blocked unsafe PDF asset URL: {url}")


def _safe_url_fetcher(url: str) -> dict[str, object]:
    if url.startswith("data:"):
        return default_url_fetcher(url)
    parsed = urlparse(url)
    scheme = (parsed.scheme or "").lower()
    if scheme == "file":
        static_alias = resolve_static_path(parsed.path)
        if static_alias:
            return default_url_fetcher(static_alias.as_uri())
        candidate = Path(unquote(parsed.path or "")).resolve()
        if _is_within_static(candidate):
            return default_url_fetcher(candidate.as_uri())
        return _placeholder_response(url)
    if scheme in {"http", "https"}:
        if scheme != "https":
            return _placeholder_response(url)
        host = (parsed.hostname or "").strip().lower()
        if not host or is_private_host(host):
            return _placeholder_response(url)
        if host not in allowed_cdn_hosts():
            return _placeholder_response(url)
        return default_url_fetcher(url)
    if not scheme:
        static_path = resolve_static_path(parsed.path or url)
        if static_path:
            return default_url_fetcher(static_path.as_uri())
    return _placeholder_response(url)


def _is_within_static(candidate: Path) -> bool:
    try:
        candidate.relative_to(STATIC_DIR.resolve())
        return True
    except ValueError:
        return False


def _font_config() -> FontConfiguration:
    # Fresh config avoids cross-call font state affecting PDF determinism.
    return FontConfiguration()


def render_pdf(html: str) -> bytes:
    base_url = TEMPLATE_DIR.as_uri()
    font_config = _font_config()
    pdf_bytes = HTML(string=html, base_url=base_url, url_fetcher=_safe_url_fetcher).write_pdf(
        pdf_variant="pdf/a-3b",
        font_config=font_config,
    )
    return _normalize_pdf_bytes(pdf_bytes)


def invoice_html(ctx: dict) -> str:
    """Rend le document depuis le template unique utilise par l'aperçu et le PDF."""
    return env.get_template("invoice_document.html").render(**ctx)


def invoice_pdf(ctx: dict) -> bytes:
    """Génère le PDF de facture en PDF/A-3b via WeasyPrint."""
    html = invoice_html(ctx)
    base_url = TEMPLATE_DIR.as_uri()
    font_config = _font_config()
    pdf_bytes = HTML(string=html, base_url=base_url, url_fetcher=_safe_url_fetcher).write_pdf(
        pdf_variant="pdf/a-3b",
        font_config=font_config,
    )
    return _normalize_pdf_bytes(pdf_bytes)


def _disable_pdfa_forbidden_image_interpolation(pdf: pikepdf.Pdf) -> None:
    """PDF/A requires image dictionaries to omit /Interpolate or set it to false."""
    for obj in pdf.objects:
        if not hasattr(obj, "get"):
            continue
        try:
            if obj.get("/Subtype") == "/Image":
                obj["/Interpolate"] = False
            smask = obj.get("/SMask")
            if smask is not None and hasattr(smask, "get") and smask.get("/Subtype") == "/Image":
                smask["/Interpolate"] = False
        except Exception:
            continue


def _normalize_pdf_bytes_once(pdf_bytes: bytes) -> bytes:
    try:
        with pikepdf.open(io.BytesIO(pdf_bytes)) as pdf:
            _disable_pdfa_forbidden_image_interpolation(pdf)
            try:
                info = pdf.docinfo
                if info is not None:
                    for key in ("/CreationDate", "/ModDate"):
                        if key in info:
                            info[key] = "D:20000101000000Z"
            except Exception:
                pass
            try:
                with pdf.open_metadata(set_pikepdf_as_editor=False) as meta:
                    for key in ("xmp:CreateDate", "xmp:ModifyDate", "xmp:MetadataDate"):
                        if key in meta:
                            meta[key] = "2000-01-01T00:00:00Z"
                    xmp_metadata_key = "{http://ns.adobe.com/xap/1.0/}MetadataDate"
                    if xmp_metadata_key in meta:
                        meta[xmp_metadata_key] = "2000-01-01T00:00:00Z"
                    for key in ("xmpMM:DocumentID", "xmpMM:InstanceID", "xmpMM:OriginalDocumentID"):
                        if key in meta:
                            meta[key] = "uuid:00000000-0000-0000-0000-000000000000"
            except Exception:
                pass
            try:
                for obj in pdf.objects:
                    if not hasattr(obj, "get"):
                        continue
                    if obj.get("/Type") != "/Font":
                        continue
                    desc = obj.get("/FontDescriptor")
                    if not desc:
                        continue
                    for key in ("/FontFile2", "/FontFile", "/FontFile3"):
                        fontfile = desc.get(key)
                        if not fontfile:
                            continue
                        try:
                            data = fontfile.read_bytes()
                            font = TTFont(io.BytesIO(data), recalcTimestamp=False, recalcBBoxes=False)
                            if "head" in font:
                                head = font["head"]
                                head.modified = head.created
                            font.recalcTimestamp = False
                            out_font = io.BytesIO()
                            font.save(out_font, reorderTables=False)
                            fontfile.write(out_font.getvalue())
                        except Exception:
                            continue
            except Exception:
                pass
            try:
                fixed = pikepdf.String(b"\x00" * 16)
                pdf.trailer["/ID"] = pikepdf.Array([fixed, fixed])
            except Exception:
                pass
            out = io.BytesIO()
            pdf.save(
                out,
                static_id=True,
                deterministic_id=True,
                qdf=False,
                normalize_content=False,
                object_stream_mode=pikepdf.ObjectStreamMode.generate,
                compress_streams=True,
                recompress_flate=True,
            )
            return out.getvalue()
    except Exception:
        return pdf_bytes


def _normalize_pdf_bytes(pdf_bytes: bytes) -> bytes:
    current = pdf_bytes
    for _ in range(3):
        normalized = _normalize_pdf_bytes_once(current)
        if normalized == current:
            return normalized
        current = normalized
    return current
