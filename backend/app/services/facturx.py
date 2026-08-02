import io
import logging
import shutil
import subprocess
import time
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path
from tempfile import NamedTemporaryFile, TemporaryDirectory
from typing import Any, Callable

from facturx import generate_from_file
import pikepdf

from ..config import settings
from ..validators.invoice_sanity_checks import validate_invoice_xml_issues
from .pdf import _normalize_pdf_bytes, invoice_pdf

try:
    from facturx import PROFILE_BASIC, PROFILE_EN16931
except ImportError:  # Fallback for older factur-x versions without PROFILE_* exports.
    PROFILE_BASIC = "basic"
    PROFILE_EN16931 = "en16931"
PROFILE_MINIMUM = "minimum"
PROFILE_EXTENDED = "extended"
_facturx_xsd_check: Callable[..., Any] | None = None
_FACTURX_XSD_CHECK_KIND: str | None = None

try:
    from facturx import xml_check_xsd as _facturx_xsd_check_import
except ImportError:  # Fallback for older factur-x versions.
    _facturx_xsd_check_import = None

if _facturx_xsd_check_import is not None:
    _facturx_xsd_check = _facturx_xsd_check_import
    _FACTURX_XSD_CHECK_KIND = "xml_check_xsd"
else:
    try:
        from facturx import check_facturx_xsd as _facturx_xsd_check_import
    except ImportError:
        _facturx_xsd_check_import = None
    if _facturx_xsd_check_import is not None:
        _facturx_xsd_check = _facturx_xsd_check_import
        _FACTURX_XSD_CHECK_KIND = "check_facturx_xsd"


_FACTURX_PROFILE_MAP = {
    "minimum": PROFILE_MINIMUM,
    "basic": PROFILE_BASIC,
    "en16931": PROFILE_EN16931,
    "extended": PROFILE_EXTENDED,
    "extended-ctc-fr": PROFILE_EXTENDED,
}


def _facturx_profile(profile: str | None = None, ctx: dict | None = None) -> str:
    from .cii import resolve_facturx_profile

    normalized = resolve_facturx_profile(ctx, profile)
    return _FACTURX_PROFILE_MAP.get(normalized, _FACTURX_PROFILE_MAP["en16931"])


logger = logging.getLogger(__name__)
_GS_TIMEOUT_SECONDS = 60
_VERAPDF_TIMEOUT_SECONDS = 120
_PDFA_DEF_PLACEHOLDER = "__SRGB_ICC__"
_PDFA_DEF_NAME = "PDFA_def.ps"
FACTURX_XSD_ERROR_CODE = "facturx_xsd_invalid"
FACTURX_SCHEMATRON_ERROR_CODE = "facturx_schematron_invalid"
FACTURX_EMBED_ERROR_CODE = "facturx_embed_error"
FACTURX_PDFA_ERROR_CODE = "facturx_pdfa3_failed"
FACTURX_DOC_URL = "https://www.factur-x.eu/en/factur-x/"
FACTURX_XSD_PUBLIC_MESSAGE = "Le document XML Factur-X ne respecte pas le schéma attendu."
FACTURX_PDFA_VALIDATION_PUBLIC_MESSAGE = (
    "Le contrôle PDF/A-3 n’a pas validé le document Factur-X."
)
FACTURX_PDFA_WARNING_PUBLIC_MESSAGE = (
    "Le document Factur-X a été généré avec un avertissement de conformité PDF/A-3."
)


class FacturxValidationError(ValueError):
    code = "facturx_validation_failed"

    def __init__(self, message: str, *, issues: list[dict] | None = None):
        super().__init__(message)
        self.issues = issues or []


class FacturxXsdValidationError(FacturxValidationError):
    code = FACTURX_XSD_ERROR_CODE


class FacturxSchematronValidationError(FacturxValidationError):
    code = FACTURX_SCHEMATRON_ERROR_CODE


class FacturxEmbedError(ValueError):
    code = FACTURX_EMBED_ERROR_CODE

    def __init__(self, message: str):
        super().__init__(message)


class FacturxPdfa3Error(ValueError):
    code = FACTURX_PDFA_ERROR_CODE

    def __init__(self, message: str):
        super().__init__(message)


@dataclass(frozen=True)
class PdfaPolicy:
    mode: str
    convert: bool
    validate: bool
    strict: bool


def _pdfa_assets_dir() -> Path:
    return Path(__file__).resolve().parents[1] / "assets" / "pdfa"


def _pdfa_def_template_path() -> Path:
    return _pdfa_assets_dir() / _PDFA_DEF_NAME


def _load_pdfa_def_template() -> str:
    path = _pdfa_def_template_path()
    if not path.is_file():
        raise RuntimeError("PDFA_def.ps introuvable (assets/pdfa).")
    return path.read_text(encoding="utf-8")


def _escape_ps_string(value: str) -> str:
    return value.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def _resolve_srgb_icc_path() -> Path:
    candidates = [
        _pdfa_assets_dir() / "sRGB.icc",
        Path("/usr/share/color/icc/sRGB.icc"),
        Path("/usr/share/color/icc/srgb.icc"),
        Path("/usr/share/color/icc/ghostscript/sRGB.icc"),
        Path("/usr/share/color/icc/ghostscript/srgb.icc"),
    ]
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    ghostscript_root = Path("/usr/share/ghostscript")
    if ghostscript_root.is_dir():
        for pattern in ("iccprofiles/srgb.icc", "iccprofiles/sRGB.icc"):
            for match in ghostscript_root.rglob(pattern):
                if match.is_file():
                    return match
    raise RuntimeError("Profil ICC sRGB introuvable (installez icc-profiles-free).")


def _render_pdfa_def(icc_path: Path) -> str:
    template = _load_pdfa_def_template()
    if _PDFA_DEF_PLACEHOLDER not in template:
        raise RuntimeError("PDFA_def.ps invalide (placeholder ICC absent).")
    return template.replace(_PDFA_DEF_PLACEHOLDER, _escape_ps_string(str(icc_path)))


def _pdfa_policy() -> PdfaPolicy:
    mode = (settings.FACTURX_PDFA_MODE or "").strip().lower()
    if mode:
        if mode not in {"off", "best_effort", "strict"}:
            logger.warning("FACTURX_PDFA_MODE invalide (%s), fallback best_effort.", mode)
            mode = "best_effort"
        if mode == "off":
            return PdfaPolicy(mode="off", convert=False, validate=False, strict=False)
        if mode == "strict":
            return PdfaPolicy(mode="strict", convert=True, validate=True, strict=True)
        return PdfaPolicy(mode="best_effort", convert=True, validate=True, strict=False)

    legacy_validation = (settings.FACTURX_PDFA_VALIDATION or "warn").strip().lower()
    if legacy_validation not in {"off", "warn", "strict"}:
        logger.warning("FACTURX_PDFA_VALIDATION invalide (%s), fallback warn.", legacy_validation)
        legacy_validation = "warn"
    convert = bool(settings.FACTURX_PDFA_CONVERT) or legacy_validation == "strict"
    validate = legacy_validation != "off"
    strict = legacy_validation == "strict"
    if strict:
        mode = "strict"
    elif not validate and not convert:
        mode = "off"
    else:
        mode = "best_effort"
    return PdfaPolicy(mode=mode, convert=convert, validate=validate, strict=strict)


def _record_pdfa_issue(policy: PdfaPolicy, warnings: list[str], message: str) -> None:
    if policy.strict:
        raise FacturxPdfa3Error(message)
    warnings.append(message)
    logger.warning("%s Mode %s: PDF/A-3 non bloquant.", message, policy.mode)


def _format_pdfa_report(policy: PdfaPolicy, warnings: list[str]) -> tuple[str, str | None]:
    if policy.mode == "off":
        return "warning", "PDF/A-3 désactivé (mode off)."
    if not warnings:
        return "ok", None
    report = sanitize_public_pdfa_report(" ".join(warnings), "warning")
    return "warning", report


def _log_xsd_validation_failure(exc: Exception, profile: str) -> None:
    logger.warning(
        "facturx_xsd_validation_failed",
        extra={
            "facturx_profile": profile,
            "validator_kind": _FACTURX_XSD_CHECK_KIND,
            "exception_type": type(exc).__name__,
        },
        exc_info=(type(exc), exc, exc.__traceback__),
    )


def _format_xsd_error(_exc: Exception | None = None) -> str:
    """Return a stable public message; raw validator diagnostics stay in logs."""

    return FACTURX_XSD_PUBLIC_MESSAGE


def sanitize_public_pdfa_report(report: object | None, status: object | None = None) -> str | None:
    """Map PDF/A diagnostics to a bounded public vocabulary.

    Historical reports may contain full veraPDF/Ghostscript output, Java stack
    traces or temporary filenames.  Never echo those values back or persist
    them again.
    """

    normalized_status = str(status or "").strip().lower()
    if normalized_status in {"ok", "valid", "success"}:
        return None
    raw_text = str(report or "").strip()
    if not raw_text:
        if normalized_status in {"failed", "error", "invalid"}:
            return FACTURX_PDFA_VALIDATION_PUBLIC_MESSAGE
        return None
    known_public_messages = {
        FACTURX_PDFA_VALIDATION_PUBLIC_MESSAGE,
        FACTURX_PDFA_WARNING_PUBLIC_MESSAGE,
        "Le contrôle PDF/A-3 est désactivé pour ce document.",
        "Le contrôle PDF/A-3 est temporairement indisponible.",
        "La conversion PDF/A-3 n’a pas pu être terminée.",
        "Le document source n’a pas pu être converti au format PDF/A-3 attendu.",
        "La structure du document Factur-X est incomplète.",
    }
    if raw_text in known_public_messages:
        return raw_text
    text = raw_text.lower()

    public_messages: list[str] = []

    def add(message: str) -> None:
        if message not in public_messages:
            public_messages.append(message)

    if "désactiv" in text or "desactiv" in text or "mode off" in text:
        add("Le contrôle PDF/A-3 est désactivé pour ce document.")
    if any(marker in text for marker in ("indisponible", "non install", "introuvable", "not found")):
        add("Le contrôle PDF/A-3 est temporairement indisponible.")
    if "conversion" in text:
        add("La conversion PDF/A-3 n’a pas pu être terminée.")
    if any(marker in text for marker in ("document source", "not pdf/a", "cannot produce")):
        add("Le document source n’a pas pu être converti au format PDF/A-3 attendu.")
    if "verapdf" in text or "validation pdf/a" in text:
        add(FACTURX_PDFA_VALIDATION_PUBLIC_MESSAGE)
    if any(marker in text for marker in ("sans fichier attaché", "sans fichier attache", "sans marqueur")):
        add("La structure du document Factur-X est incomplète.")
    if not public_messages:
        add(
            FACTURX_PDFA_VALIDATION_PUBLIC_MESSAGE
            if normalized_status in {"failed", "error", "invalid"}
            else FACTURX_PDFA_WARNING_PUBLIC_MESSAGE
        )
    return " ".join(public_messages)


def public_verapdf_result(*, available: bool, ok: bool | None) -> dict[str, object]:
    """Return verification metadata without exposing the validator stdout."""

    message = None
    if available and ok is False:
        message = FACTURX_PDFA_VALIDATION_PUBLIC_MESSAGE
    return {"available": available, "ok": ok, "output": None, "message": message}


def _issue_payload(
    code: str,
    message: str,
    *,
    field: str | None = None,
    source: str = "xsd",
    level: str = "error",
) -> dict:
    payload = {
        "code": code,
        "field": field,
        "champ": field,
        "message": message,
        "doc_url": FACTURX_DOC_URL,
        "source": source,
        "level": level,
    }
    return payload


def validate_facturx_xml_issues(xml_bytes: bytes, profile: str | None = None) -> list[dict]:
    issues: list[dict] = []
    profile = _facturx_profile(profile)

    xsd_errors = validate_facturx_xml(xml_bytes, profile)
    for err in xsd_errors:
        level = "warning" if "indisponible" in err.lower() else "error"
        code = "facturx_xsd_unavailable" if level == "warning" else FACTURX_XSD_ERROR_CODE
        issues.append(
            _issue_payload(
                code=code,
                message=err,
                source="xsd",
                level=level,
            )
        )

    for issue in validate_invoice_xml_issues(xml_bytes):
        level = issue.level or "error"
        issues.append(
            _issue_payload(
                code=issue.code or "schematron_failed_assert",
                message=issue.message,
                field=issue.path,
                source="schematron",
                level=level,
            )
        )
    return issues


def validate_facturx_xml(xml_bytes: bytes, profile: str | None = None) -> list[str]:
    profile = _facturx_profile(profile)
    if not _facturx_xsd_check:
        return ["Validation XSD Factur-X indisponible (validator XSD introuvable)."]
    try:
        if _FACTURX_XSD_CHECK_KIND == "xml_check_xsd":
            _facturx_xsd_check(xml_bytes, flavor="factur-x", level=profile)
        else:
            _facturx_xsd_check(xml_bytes, flavor="factur-x", facturx_level=profile)
    except Exception as exc:
        _log_xsd_validation_failure(exc, profile)
        return [_format_xsd_error(exc)]
    return []


def _validate_facturx_xsd(xml_bytes: bytes, profile: str) -> bool:
    if not _facturx_xsd_check:
        return False
    try:
        if _FACTURX_XSD_CHECK_KIND == "xml_check_xsd":
            _facturx_xsd_check(xml_bytes, flavor="factur-x", level=profile)
        else:
            _facturx_xsd_check(xml_bytes, flavor="factur-x", facturx_level=profile)
    except Exception as exc:
        _log_xsd_validation_failure(exc, profile)
        raise FacturxXsdValidationError(_format_xsd_error(exc)) from exc
    return True


def ensure_pdfa_validator_available() -> None:
    policy = _pdfa_policy()
    if policy.convert:
        if not shutil.which("gs"):
            raise RuntimeError("Conversion PDF/A-3 requiert Ghostscript installé (outil introuvable dans l'image).")
        _load_pdfa_def_template()
        _resolve_srgb_icc_path()
    if not policy.strict:
        return
    if shutil.which("verapdf"):
        return
    raise RuntimeError("Validation PDF/A-3 requiert veraPDF installé (outil introuvable).")


def _basic_facturx_check(pdf_bytes: bytes) -> list[str]:
    issues: list[str] = []
    lowered = pdf_bytes.lower()
    has_af = False
    facturx_names: list[str] = []
    try:
        with pikepdf.open(io.BytesIO(pdf_bytes)) as pdf:
            has_af = bool(pdf.Root.get("/AF"))
            try:
                attachments = getattr(pdf, "attachments", None)
                if attachments:
                    facturx_names.extend([str(name) for name in attachments.keys()])
            except Exception:
                pass
            try:
                names_tree = pdf.Root.get("/Names")
                embedded = names_tree.get("/EmbeddedFiles") if names_tree else None
                names_array = embedded.get("/Names") if embedded else None
                if isinstance(names_array, list):
                    for idx in range(0, len(names_array), 2):
                        name = names_array[idx]
                        if name is not None:
                            facturx_names.append(str(name))
            except Exception:
                pass
    except Exception:
        pass
    has_af_marker = has_af or b"/af" in lowered
    if not has_af_marker:
        issues.append("PDF Factur-X sans fichier attaché (AF) détecté.")
    facturx_names = [name.lower() for name in facturx_names if name]
    has_facturx_marker = any("factur-x" in name or "facturx" in name for name in facturx_names)
    if not has_facturx_marker and b"factur-x" not in lowered:
        issues.append("PDF Factur-X sans marqueur factur-x détecté.")
    return issues


def _is_pdfa_pdf(pdf_bytes: bytes) -> bool:
    try:
        with pikepdf.open(io.BytesIO(pdf_bytes)) as pdf:
            root = pdf.Root
            output_intents = root.get("/OutputIntents")
            has_output_intent = bool(output_intents and len(output_intents) > 0)
            has_metadata = False
            try:
                meta = pdf.open_metadata()
                if meta:
                    if meta.get("pdfaid:part") or meta.get("pdfaid:conformance"):
                        has_metadata = True
            except Exception:
                has_metadata = False
            if not has_metadata:
                has_metadata = bool(root.get("/Metadata"))
            return has_output_intent and has_metadata
    except Exception:
        return False


def _xml_local_name(tag: object) -> str:
    return str(tag).rsplit("}", 1)[-1]


def _verapdf_report_is_compliant(raw_report: str) -> bool:
    try:
        root = ET.fromstring(raw_report)
    except (ET.ParseError, ValueError):
        return False
    validation_reports = [
        node
        for node in root.iter()
        if _xml_local_name(node.tag) in {"validationReport", "validationResult"}
    ]
    batch_summaries = [node for node in root.iter() if _xml_local_name(node.tag) == "batchSummary"]
    summary_reports = [
        node
        for batch in batch_summaries
        for node in batch.iter()
        if _xml_local_name(node.tag) == "validationReports"
    ]
    if len(validation_reports) != 1 or len(batch_summaries) != 1 or len(summary_reports) != 1:
        return False
    validation = validation_reports[0]
    batch = batch_summaries[0]
    summary = summary_reports[0]
    return (
        validation.attrib.get("isCompliant", "").strip().lower() == "true"
        and validation.attrib.get("jobEndStatus", "NORMAL").strip().upper() == "NORMAL"
        and batch.attrib.get("totalJobs") == "1"
        and batch.attrib.get("failedToParse", "0") == "0"
        and batch.attrib.get("encrypted", "0") == "0"
        and batch.attrib.get("outOfMemory", "0") == "0"
        and batch.attrib.get("veraExceptions", "0") == "0"
        and summary.attrib.get("compliant") == "1"
        and summary.attrib.get("nonCompliant") == "0"
        and summary.attrib.get("failedJobs") == "0"
        and (summary.text or "").strip() == "1"
    )


def _run_verapdf(pdf_path: str) -> tuple[bool, str]:
    cmd = [
        "verapdf",
        "--format",
        "raw",
        "--flavour",
        "3b",
        "--maxfailures",
        "1",
        pdf_path,
    ]
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=_VERAPDF_TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return False, f"veraPDF execution failed: {type(exc).__name__}"
    output = (result.stdout or "").strip()
    if result.stderr:
        output = f"{output}\n{result.stderr.strip()}" if output else result.stderr.strip()
    compliant = result.returncode == 0 and _verapdf_report_is_compliant(result.stdout or "")
    return compliant, output


def _run_ghostscript_convert(
    input_path: str,
    output_path: str,
    pdfa_def_path: str,
    icc_path: str,
) -> tuple[bool, str]:
    cmd = [
        "gs",
        "-dSAFER",
        "-dBATCH",
        "-dNOPAUSE",
        "-sDEVICE=pdfwrite",
        "-dPDFA=3",
        "-dPDFACompatibilityPolicy=1",
        "-sProcessColorModel=DeviceRGB",
        "-sColorConversionStrategy=RGB",
        "-dUseCIEColor",
        f"--permit-file-read={input_path}",
        f"--permit-file-read={pdfa_def_path}",
        f"--permit-file-read={icc_path}",
        f"-sOutputFile={output_path}",
        pdfa_def_path,
        input_path,
    ]
    try:
        started = time.monotonic()
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=_GS_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired as exc:
        output = ""
        stdout = (exc.stdout or "").strip() if isinstance(exc.stdout, str) else ""
        stderr = (exc.stderr or "").strip() if isinstance(exc.stderr, str) else ""
        if stdout or stderr:
            output = "\n".join([part for part in [stdout, stderr] if part])
        else:
            output = f"Timeout après {_GS_TIMEOUT_SECONDS}s."
        return False, output
    elapsed = time.monotonic() - started
    output = (result.stdout or "").strip()
    if result.stderr:
        output = f"{output}\n{result.stderr.strip()}" if output else result.stderr.strip()
    if result.returncode != 0 and not output:
        output = f"Ghostscript a échoué après {elapsed:.1f}s."
    return result.returncode == 0, output


def convert_pdf_to_pdfa3(pdf_bytes: bytes) -> bytes:
    if not shutil.which("gs"):
        raise RuntimeError("Ghostscript introuvable (conversion PDF/A-3 impossible).")
    icc_path = _resolve_srgb_icc_path()
    pdfa_def = _render_pdfa_def(icc_path)
    with TemporaryDirectory() as tmp_dir:
        pdfa_def_path = Path(tmp_dir) / _PDFA_DEF_NAME
        pdfa_def_path.write_text(pdfa_def, encoding="utf-8")
        with NamedTemporaryFile(suffix=".pdf") as src_pdf, NamedTemporaryFile(suffix=".pdf") as dst_pdf:
            src_pdf.write(pdf_bytes)
            src_pdf.flush()
            ok, output = _run_ghostscript_convert(
                src_pdf.name,
                dst_pdf.name,
                str(pdfa_def_path),
                str(icc_path),
            )
            if not ok:
                msg = "Conversion PDF/A-3 échouée via Ghostscript."
                if output:
                    msg = f"{msg} {output}"
                raise RuntimeError(msg)
            dst_pdf.seek(0)
            converted = dst_pdf.read()
    if not converted:
        raise RuntimeError("Conversion PDF/A-3 échouée: sortie vide.")
    return converted


def _validate_pdfa3(pdf_bytes: bytes, policy: PdfaPolicy) -> list[str]:
    warnings: list[str] = []
    if not policy.validate:
        return warnings
    with NamedTemporaryFile(suffix=".pdf") as tmp_pdf:
        tmp_pdf.write(pdf_bytes)
        tmp_pdf.flush()
        validator = shutil.which("verapdf")
        if validator:
            ok, output = _run_verapdf(tmp_pdf.name)
            if not ok:
                logger.warning(
                    "facturx_verapdf_validation_failed",
                    extra={
                        "validator": "verapdf",
                        "validator_output": output[:8000] if output else None,
                        "validator_output_truncated": bool(output and len(output) > 8000),
                    },
                )
                _record_pdfa_issue(policy, warnings, FACTURX_PDFA_VALIDATION_PUBLIC_MESSAGE)
        else:
            _record_pdfa_issue(policy, warnings, "Validation PDF/A-3 indisponible (veraPDF non installée).")
    basic_issues = _basic_facturx_check(pdf_bytes)
    if basic_issues:
        _record_pdfa_issue(policy, warnings, " ".join(basic_issues))
    return warnings


def _maybe_convert_pdfa3(pdf_bytes: bytes, policy: PdfaPolicy, warnings: list[str]) -> bytes:
    if policy.mode == "off":
        return pdf_bytes
    if _is_pdfa_pdf(pdf_bytes):
        return pdf_bytes
    if not policy.convert:
        warnings.append("Conversion PDF/A-3 désactivée.")
        return pdf_bytes
    try:
        return convert_pdf_to_pdfa3(pdf_bytes)
    except Exception:
        logger.exception("facturx_pdfa3_conversion_failed")
        _record_pdfa_issue(policy, warnings, "La conversion PDF/A-3 n’a pas pu être terminée.")
        return pdf_bytes


def facturx_from_pdf_xml_with_meta(
    pdf_bytes: bytes,
    xml_bytes: bytes,
    profile: str | None = None,
) -> tuple[bytes, str, str | None]:
    """
    Génère un PDF Factur-X à partir d'un PDF existant et d'un XML CII.
    Le PDF source doit être PDF/A (OutputIntents + Metadata), sinon erreur.
    Retourne le PDF + statut PDF/A-3 + rapport (PDF/A-3 si activé).
    """
    policy = _pdfa_policy()
    warnings: list[str] = []
    pdf_bytes = _maybe_convert_pdfa3(pdf_bytes, policy, warnings)
    if policy.mode != "off" and not _is_pdfa_pdf(pdf_bytes):
        _record_pdfa_issue(
            policy,
            warnings,
            "Le document source n’est pas au format PDF/A requis pour produire un fichier Factur-X conforme.",
        )
    profile = _facturx_profile(profile)
    issues = validate_facturx_xml_issues(xml_bytes, profile)
    errors = [issue for issue in issues if issue.get("level") != "warning"]
    issue_warnings: list[str] = []
    for issue in issues:
        if issue.get("level") != "warning":
            continue
        message = issue.get("message")
        if isinstance(message, str) and message:
            issue_warnings.append(message)
    if issue_warnings:
        logger.warning(
            "Factur-X validation warnings: %s",
            "; ".join(issue_warnings),
        )
        warnings.extend(issue_warnings)
    if errors:
        message = errors[0].get("message") or "Validation Factur-X échouée."
        if any(issue.get("source") == "xsd" for issue in errors):
            raise FacturxXsdValidationError(message, issues=errors)
        raise FacturxSchematronValidationError(message, issues=errors)
    with NamedTemporaryFile(suffix=".pdf") as f_pdf:
        f_pdf.write(pdf_bytes)
        f_pdf.flush()
        try:
            generate_from_file(
                f_pdf.name,
                xml_bytes,
                "factur-x",
                profile,
                check_xsd=False,
            )
        except Exception as exc:
            logger.exception(
                "facturx_embed_failed",
                extra={"facturx_profile": profile, "exception_type": type(exc).__name__},
            )
            raise FacturxEmbedError(
                "Impossible d’intégrer les données structurées dans le PDF de la facture."
            ) from exc

        f_pdf.seek(0)
        facturx_bytes = _normalize_pdf_bytes(f_pdf.read())
        warnings.extend(_validate_pdfa3(facturx_bytes, policy))
        status, report = _format_pdfa_report(policy, warnings)
        return facturx_bytes, status, report


def facturx_from_pdf_xml(
    pdf_bytes: bytes,
    xml_bytes: bytes,
    profile: str | None = None,
) -> bytes:
    facturx_bytes, _, _ = facturx_from_pdf_xml_with_meta(pdf_bytes, xml_bytes, profile)
    return facturx_bytes


def facturx_pdf(ctx: dict) -> bytes:
    """
    Génère un PDF Factur-X (XML CII intégré, PDF/A-3 si activé) à partir
    du contexte applicatif.
    """
    invoice_ctx = ctx.get("invoice") if isinstance(ctx, dict) else None
    if isinstance(invoice_ctx, dict) and "delivery_address_differs" not in invoice_ctx:
        delivery_address = (invoice_ctx.get("delivery_address") or "").strip()
        customer_address = ((ctx.get("customer") or {}).get("address") or "").strip() if isinstance(ctx, dict) else ""
        invoice_ctx["delivery_address_differs"] = bool(delivery_address and delivery_address != customer_address)
    # 1) Générer le PDF "normal" et le XML CII
    from .cii import cii_invoice_xml, resolve_facturx_profile

    pdf_ctx = dict(ctx or {})
    pdf_ctx["is_facturx_pdf"] = True
    pdf_bytes = invoice_pdf(pdf_ctx)
    xml_bytes = cii_invoice_xml(ctx, False)
    profile = resolve_facturx_profile(ctx, (ctx or {}).get("facturx_profile"))

    return facturx_from_pdf_xml(
        pdf_bytes,
        xml_bytes,
        profile,
    )


def facturx_pdf_with_meta(ctx: dict) -> tuple[bytes, str, str | None]:
    invoice_ctx = ctx.get("invoice") if isinstance(ctx, dict) else None
    if isinstance(invoice_ctx, dict) and "delivery_address_differs" not in invoice_ctx:
        delivery_address = (invoice_ctx.get("delivery_address") or "").strip()
        customer_address = ((ctx.get("customer") or {}).get("address") or "").strip() if isinstance(ctx, dict) else ""
        invoice_ctx["delivery_address_differs"] = bool(delivery_address and delivery_address != customer_address)
    from .cii import cii_invoice_xml, resolve_facturx_profile

    pdf_ctx = dict(ctx or {})
    pdf_ctx["is_facturx_pdf"] = True
    pdf_bytes = invoice_pdf(pdf_ctx)
    xml_bytes = cii_invoice_xml(ctx, False)
    profile = resolve_facturx_profile(ctx, (ctx or {}).get("facturx_profile"))
    return facturx_from_pdf_xml_with_meta(
        pdf_bytes,
        xml_bytes,
        profile,
    )
