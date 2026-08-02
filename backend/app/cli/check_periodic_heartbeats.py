from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone

from app.config import settings
from app.jobs.heartbeat import collect_periodic_heartbeat_status


def _parse_modes(raw: str | None) -> list[str]:
    return [item.strip() for item in (raw or "").split(",") if item.strip()]


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Fail when a required periodic scheduler heartbeat is absent or stale."
    )
    parser.add_argument(
        "--modes",
        default=None,
        help=(
            "Comma-separated modes. Defaults to PERIODIC_JOBS_REQUIRED_MODES "
            "from the runtime environment."
        ),
    )
    parser.add_argument(
        "--not-before-epoch",
        type=int,
        default=None,
        help="Require every heartbeat to have been written at or after this Unix timestamp.",
    )
    args = parser.parse_args()
    raw_modes = (
        args.modes
        if args.modes is not None
        else settings.PERIODIC_JOBS_REQUIRED_MODES
    )
    not_before = (
        datetime.fromtimestamp(args.not_before_epoch, tz=timezone.utc)
        if args.not_before_epoch is not None
        else None
    )
    report = collect_periodic_heartbeat_status(
        _parse_modes(raw_modes),
        not_before=not_before,
    )
    print(json.dumps(report, ensure_ascii=False, sort_keys=True))
    return 0 if report["status"] == "ok" else 1


if __name__ == "__main__":
    raise SystemExit(main())
