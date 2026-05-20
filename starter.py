from __future__ import annotations

import argparse
import http.client
import subprocess
import sys
import time
import webbrowser
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parent
DASHBOARD_URL = "http://localhost:8000"


def run(cmd: list[str], check: bool = True, capture: bool = False) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        cmd,
        cwd=ROOT,
        check=check,
        text=True,
        capture_output=capture,
    )


def check_docker() -> None:
    checks = [
        ["docker", "--version"],
        ["docker", "compose", "version"],
        ["docker", "info"],
    ]
    for cmd in checks:
        try:
            run(cmd, check=True)
        except Exception as error:
            print(f"[ERROR] Docker check failed for: {' '.join(cmd)}")
            print(error)
            sys.exit(1)


def wait_for_dashboard(timeout_seconds: int = 60) -> bool:
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        try:
            with urlopen(f"{DASHBOARD_URL}/api/state", timeout=2) as response:
                if response.status == 200:
                    return True
        except (URLError, ConnectionError, ConnectionResetError, OSError, TimeoutError, http.client.HTTPException):
            time.sleep(1)
    return False


def start_stack(open_browser: bool = True, build: bool = True) -> None:
    check_docker()
    cmd = ["docker", "compose", "up", "-d"]
    if build:
        cmd.insert(3, "--build")

    print("[INFO] Starting MTD demo stack...")
    run(cmd, check=True)

    print("[INFO] Waiting for controller API...")
    ready = wait_for_dashboard(timeout_seconds=90)
    if not ready:
        print("[WARN] Stack is up, but controller API is not ready yet.")
        print("[INFO] Last controller logs:")
        run(["docker", "compose", "logs", "--tail=60", "controller"], check=False)
        print("[INFO] Use: python starter.py logs")
        return

    print(f"[OK] Dashboard is ready: {DASHBOARD_URL}")
    if open_browser:
        webbrowser.open(DASHBOARD_URL)


def stop_stack() -> None:
    print("[INFO] Stopping MTD demo stack...")
    run(["docker", "compose", "down"], check=True)


def show_status() -> None:
    run(["docker", "compose", "ps"], check=True)


def show_logs() -> None:
    run(["docker", "compose", "logs", "-f", "controller"], check=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="MTD Local Demo Starter")
    parser.add_argument(
        "command",
        nargs="?",
        default="start",
        choices=["start", "stop", "status", "logs"],
        help="Command to execute",
    )
    parser.add_argument(
        "--no-browser",
        action="store_true",
        help="Do not open browser after start",
    )
    parser.add_argument(
        "--no-build",
        action="store_true",
        help="Start without rebuilding images",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    if args.command == "start":
        start_stack(open_browser=not args.no_browser, build=not args.no_build)
    elif args.command == "stop":
        stop_stack()
    elif args.command == "status":
        show_status()
    elif args.command == "logs":
        show_logs()


if __name__ == "__main__":
    main()
