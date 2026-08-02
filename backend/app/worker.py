def run() -> None:
    from app.jobs.worker import run as run_worker

    run_worker()


def main() -> None:
    run()


if __name__ == "__main__":
    main()
