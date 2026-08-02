import sys


def run() -> int:
    from app.jobs.periodic import run as run_periodic

    return run_periodic()


def main() -> None:
    sys.exit(run())


if __name__ == "__main__":
    main()
