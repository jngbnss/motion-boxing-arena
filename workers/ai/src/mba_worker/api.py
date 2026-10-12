"""내부 워커 API 클라이언트 (`/internal/v1`, 헤더 X-Worker-Secret). 계약: packages/shared/src/api.ts."""

from __future__ import annotations

import logging
import re
from urllib.parse import quote

import httpx

log = logging.getLogger(__name__)

INTERNAL_PREFIX = "/internal/v1"
ARTIFACT_NAME = re.compile(r"^[A-Za-z0-9_.-]+$")


class ApiClient:
    def __init__(self, base_url: str, secret: str, worker_id: str, timeout: float = 30.0) -> None:
        self.base = base_url.rstrip("/")
        self.worker_id = worker_id
        self.http = httpx.Client(timeout=timeout, headers={"X-Worker-Secret": secret})

    def _url(self, path: str) -> str:
        return f"{self.base}{INTERNAL_PREFIX}{path}"

    def _post(self, path: str, body: dict) -> httpx.Response:
        r = self.http.post(self._url(path), json=body)
        if r.status_code >= 400:
            raise httpx.HTTPStatusError(f"{r.status_code} {path}: {r.text[:300]}", request=r.request, response=r)
        return r

    def claim(self) -> dict | None:
        r = self._post("/jobs/claim", {"workerId": self.worker_id})
        if r.status_code == 204 or not r.content:
            return None
        return r.json()["job"]

    def heartbeat(self) -> None:
        self._post("/heartbeat", {"workerId": self.worker_id})

    def progress(self, job_id: str, stage: str, progress: float) -> None:
        self._post(f"/jobs/{quote(job_id)}/progress", {"stage": stage, "progress": max(0.0, min(1.0, progress))})

    def put_artifact(self, job_id: str, name: str, data: bytes) -> str:
        if not ARTIFACT_NAME.match(name):
            raise ValueError(f"잘못된 산출물 이름: {name}")
        r = self.http.put(
            self._url(f"/jobs/{quote(job_id)}/artifacts/{name}"),
            content=data,
            headers={"Content-Type": "application/octet-stream"},
            timeout=120.0,
        )
        if r.status_code >= 400:
            raise httpx.HTTPStatusError(f"{r.status_code} PUT {name}: {r.text[:300]}", request=r.request, response=r)
        return r.json()["url"]

    def complete(self, job_id: str, payload: dict) -> None:
        self._post(f"/jobs/{quote(job_id)}/complete", payload)

    def fail(self, job_id: str, stage: str, code: str, retryable: bool, message: str) -> None:
        self._post(f"/jobs/{quote(job_id)}/fail", {"stage": stage, "code": code[:64], "retryable": retryable, "message": message[:500]})

    def download(self, url: str) -> bytes:
        r = self.http.get(url, timeout=120.0, follow_redirects=True)
        r.raise_for_status()
        return r.content


class RemoteStore:
    """작업 산출물: 이전 시도 산출물은 claim 의 artifacts URL 로 내려받고, 새 산출물은 PUT 으로 올린다."""

    def __init__(self, api: ApiClient, job_id: str, artifacts: dict[str, str]) -> None:
        self.api = api
        self.job_id = job_id
        self.urls = dict(artifacts)
        self.cache: dict[str, bytes] = {}

    def has(self, name: str) -> bool:
        return name in self.cache or name in self.urls

    def get(self, name: str) -> bytes:
        if name not in self.cache:
            self.cache[name] = self.api.download(self.urls[name])
        return self.cache[name]

    def put(self, name: str, data: bytes) -> None:
        self.urls[name] = self.api.put_artifact(self.job_id, name, data)
        self.cache[name] = data
