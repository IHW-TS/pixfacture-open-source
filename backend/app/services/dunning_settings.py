from __future__ import annotations

from typing import Any

from ..models import Tenant


def _get_features(tenant: Tenant) -> dict[str, Any]:
    settings = getattr(tenant, "settings", None)
    features = getattr(settings, "features", None) if settings else None
    return features if isinstance(features, dict) else {}


def get_dunning_settings(tenant: Tenant) -> dict[str, Any]:
    """Retourne les réglages de relance automatique (dunning).

    Clés:
    - enabled: bool
    - schedule_days: list[int] (offsets relatifs à due_date)
    - min_interval_hours: int
    - attach_pdf: bool
    - steps: dict[str, {subject, body}]
    """

    features = _get_features(tenant)
    dunning = features.get("dunning")
    dunning = dunning if isinstance(dunning, dict) else {}

    enabled = bool(dunning.get("enabled"))
    attach_pdf = bool(dunning.get("attach_pdf"))

    # schedule
    raw_sched = dunning.get("schedule_days")
    schedule: list[int] = []
    if isinstance(raw_sched, list):
        for item in raw_sched:
            try:
                v = int(item)
            except Exception:
                continue
            if v not in schedule:
                schedule.append(v)
    if not schedule:
        schedule = [-2, 3, 10]

    # min interval
    try:
        min_interval_hours = int(dunning.get("min_interval_hours") or 24)
    except Exception:
        min_interval_hours = 24
    min_interval_hours = max(1, min(24 * 30, min_interval_hours))

    # steps
    steps = dunning.get("steps")
    steps = steps if isinstance(steps, dict) else {}
    cleaned_steps: dict[str, dict[str, str]] = {}
    for offset in schedule:
        key = str(offset)
        raw = steps.get(key)
        raw = raw if isinstance(raw, dict) else {}
        subj = str(raw.get("subject") or "Rappel - facture {number}").strip()
        body = str(
            raw.get("body")
            or "Bonjour {client},\n\nSauf erreur de notre part, la facture {number}, échue le {due_date}, reste à régler.\n\nSi le paiement a déjà été effectué, merci de transmettre la référence du règlement à votre contact habituel. À défaut, merci d'indiquer la date de paiement prévue."
        ).strip()
        cleaned_steps[key] = {"subject": subj, "body": body}

    return {
        "enabled": enabled,
        "schedule_days": schedule,
        "min_interval_hours": min_interval_hours,
        "attach_pdf": attach_pdf,
        "steps": cleaned_steps,
    }
