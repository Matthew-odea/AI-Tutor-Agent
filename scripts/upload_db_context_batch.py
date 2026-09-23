#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

import requests
from PyPDF2 import PdfReader

SUPPORTED_EXTENSIONS = {".py", ".txt", ".tex", ".csv", ".ipynb", ".pdf", ".md"}


@dataclass
class UploadResult:
    path: Path
    status: str
    detail: str


def normalize_scope(value: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9]+", "_", value.strip().lower()).strip("_")
    return cleaned or "default"


def infer_artifact_type(path: Path) -> str:
    ext = path.suffix.lower()
    if ext == ".py":
        return "code"
    if ext == ".ipynb":
        return "notebook"
    if ext == ".pdf":
        return "pdf"
    if ext in {".md"}:
        return "markdown"
    return "text"


def extract_pdf_text(path: Path) -> str:
    reader = PdfReader(str(path))
    return "\n\n".join((page.extract_text() or "").strip() for page in reader.pages).strip()


def extract_notebook_text(path: Path) -> str:
    raw = json.loads(path.read_text(encoding="utf-8", errors="ignore"))
    cells = raw.get("cells", [])
    chunks: list[str] = []
    for index, cell in enumerate(cells, start=1):
        cell_type = str(cell.get("cell_type", "")).strip().lower() or "unknown"
        source = cell.get("source", [])
        if isinstance(source, list):
            body = "".join(str(part) for part in source)
        else:
            body = str(source)
        body = body.strip()
        if not body:
            continue
        chunks.append(f"## Cell {index} ({cell_type})\n{body}")
    return "\n\n".join(chunks).strip()


def extract_text(path: Path) -> str:
    ext = path.suffix.lower()
    if ext == ".pdf":
        return extract_pdf_text(path)
    if ext == ".ipynb":
        return extract_notebook_text(path)
    return path.read_text(encoding="utf-8", errors="ignore").strip()


def iter_supported_files(root: Path) -> Iterable[Path]:
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        if path.name.startswith("."):
            continue
        if path.suffix.lower() not in SUPPORTED_EXTENSIONS:
            continue
        yield path


def build_payload(
    path: Path,
    root: Path,
    scope_mode: str,
    forced_scope: str | None,
    course_code: str | None,
    course_term: str | None,
    course_year: int | None,
) -> dict:
    relative = path.relative_to(root)
    artifact_type = infer_artifact_type(path)

    if forced_scope:
        scope = normalize_scope(forced_scope)
    elif scope_mode == "top-level" and len(relative.parts) >= 2:
        scope = normalize_scope(relative.parts[0])
    elif scope_mode == "folder" and len(relative.parts) >= 2:
        scope = normalize_scope(relative.parts[0] + "_" + relative.parts[1])
    else:
        scope = "default"

    text = extract_text(path)
    if not text:
        raise ValueError("No extractable text")

    document_name = normalize_scope(str(relative.with_suffix("")))
    description = f"{relative.parts[0]} / {path.name}" if relative.parts else path.name

    return {
        "DocumentName": document_name,
        "Description": description,
        "Text": text,
        "Scope": scope,
        "ArtifactType": artifact_type,
        "SourcePath": str(relative),
        "CourseCode": course_code,
        "CourseTerm": course_term,
        "CourseYear": course_year,
    }


def auth_header() -> dict:
    """
    /internal/context/upload requires an instructor or admin bearer token.
    Read it from the environment so it never lands in shell history or argv.
    """
    token = os.environ.get("AI_TUTOR_TOKEN", "").strip()
    if not token:
        raise SystemExit(
            "AI_TUTOR_TOKEN is not set. Obtain an instructor token and export it:\n"
            "  export AI_TUTOR_TOKEN=\"$(your-login-command)\""
        )
    return {"Authorization": f"Bearer {token}"}


def upload_file(base_url: str, payload: dict, timeout: int, headers: dict) -> requests.Response:
    return requests.post(
        f"{base_url.rstrip('/')}/internal/context/upload",
        json=payload,
        headers=headers,
        timeout=timeout,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Batch upload db_context files to /internal/context/upload")
    parser.add_argument("--root", default="db_context", help="Root folder to ingest")
    parser.add_argument("--base-url", default="http://localhost:8000", help="Backend base URL")
    parser.add_argument("--scope", default=None, help="Force one scope for all files")
    parser.add_argument(
        "--scope-mode",
        choices=["top-level", "folder", "default"],
        default="top-level",
        help="How scope is inferred when --scope is not set",
    )
    parser.add_argument("--limit", type=int, default=0, help="Max files to upload (0 = no limit)")
    parser.add_argument("--timeout", type=int, default=120, help="HTTP timeout seconds")
    parser.add_argument("--dry-run", action="store_true", help="Print planned uploads without sending")
    parser.add_argument("--course-code", default=None, help="Optional course code override (default from backend config)")
    parser.add_argument("--course-term", default=None, help="Optional course term override (e.g. T1/T2/T3)")
    parser.add_argument("--course-year", type=int, default=None, help="Optional course year override")
    args = parser.parse_args()
    headers = auth_header()

    root = Path(args.root).resolve()
    if not root.exists() or not root.is_dir():
        print(f"[error] root folder not found: {root}")
        return 1

    files = list(iter_supported_files(root))
    if args.limit > 0:
        files = files[: args.limit]

    if not files:
        print("[info] no supported files found")
        return 0

    results: list[UploadResult] = []
    print(f"[info] found {len(files)} supported files under {root}")

    for path in files:
        try:
            payload = build_payload(
                path,
                root,
                args.scope_mode,
                args.scope,
                args.course_code,
                args.course_term,
                args.course_year,
            )
            if args.dry_run:
                print(
                    f"[dry-run] {path.relative_to(root)} -> scope={payload['Scope']} "
                    f"artifact={payload['ArtifactType']} module={payload['SourcePath']} chars={len(payload['Text'])}"
                )
                results.append(UploadResult(path=path, status="dry-run", detail="planned"))
                continue

            response = upload_file(args.base_url, payload, timeout=args.timeout, headers=headers)
            if response.status_code in (200, 201):
                detail = response.json().get("document_id", "ok") if response.headers.get("content-type", "").startswith("application/json") else "ok"
                print(f"[ok] {path.relative_to(root)} -> {detail}")
                results.append(UploadResult(path=path, status="ok", detail=str(detail)))
            else:
                detail = response.text[:300]
                print(f"[fail] {path.relative_to(root)} -> HTTP {response.status_code}: {detail}")
                results.append(UploadResult(path=path, status="fail", detail=f"HTTP {response.status_code}"))
        except Exception as error:
            print(f"[skip] {path.relative_to(root)} -> {error}")
            results.append(UploadResult(path=path, status="skip", detail=str(error)))

    ok_count = sum(1 for r in results if r.status == "ok")
    fail_count = sum(1 for r in results if r.status == "fail")
    skip_count = sum(1 for r in results if r.status == "skip")
    dry_count = sum(1 for r in results if r.status == "dry-run")

    print("\n=== Summary ===")
    print(f"total={len(results)} ok={ok_count} fail={fail_count} skip={skip_count} dry_run={dry_count}")

    if fail_count > 0:
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
