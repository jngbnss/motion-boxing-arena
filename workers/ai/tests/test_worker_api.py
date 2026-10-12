"""내부 워커 API 프로토콜 테스트: 계약(packages/shared/src/api.ts)대로 말하는 가짜 서버에 워커를 붙인다."""

import io
import json
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from PIL import Image

from mba_worker.api import ApiClient
from mba_worker.worker import Worker
from test_pipeline import SyntheticBackend

SECRET = "test-secret"
HEX = re.compile(r"^#[0-9a-f]{6}$", re.I)


class FakeServer:
    def __init__(self) -> None:
        self.files: dict[str, bytes] = {}
        self.jobs: list[dict] = []
        self.progress: list[dict] = []
        self.completed: list[tuple[str, dict]] = []
        self.failed: list[tuple[str, dict]] = []
        self.heartbeats = 0
        self.unauthorized = 0
        server = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):  # noqa: D401 - 테스트 소음 제거
                pass

            def _reply(self, code: int, body: dict | None = None) -> None:
                data = json.dumps(body).encode() if body is not None else b""
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def _body(self) -> bytes:
                return self.rfile.read(int(self.headers.get("Content-Length") or 0))

            def _auth(self) -> bool:
                if self.headers.get("X-Worker-Secret") != SECRET:
                    server.unauthorized += 1
                    self._reply(401, {"error": {"code": "UNAUTHORIZED", "message": "", "retryable": False}})
                    return False
                return True

            def do_GET(self):
                key = self.path.removeprefix("/files/")
                if key in server.files:
                    data = server.files[key]
                    self.send_response(200)
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                else:
                    self._reply(404, {"error": {"code": "NOT_FOUND", "message": key, "retryable": False}})

            def do_PUT(self):
                if not self._auth():
                    return
                m = re.fullmatch(r"/internal/v1/jobs/([^/]+)/artifacts/([A-Za-z0-9_.-]+)", self.path)
                assert m and self.headers["Content-Type"] == "application/octet-stream"
                key = f"jobs/{m[1]}/{m[2]}"
                server.files[key] = self._body()
                self._reply(200, {"url": f"{server.base}/files/{key}"})

            def do_POST(self):
                if not self._auth():
                    return
                body = json.loads(self._body() or b"{}")
                if self.path == "/internal/v1/jobs/claim":
                    assert body["workerId"]
                    if server.jobs:
                        self._reply(200, {"job": server.jobs.pop(0)})
                    else:
                        self._reply(204)
                elif self.path == "/internal/v1/heartbeat":
                    server.heartbeats += 1
                    self._reply(200, {"ok": True})
                elif m := re.fullmatch(r"/internal/v1/jobs/([^/]+)/(progress|complete|fail)", self.path):
                    {"progress": lambda: server.progress.append(body), "complete": lambda: server.completed.append((m[1], body)),
                     "fail": lambda: server.failed.append((m[1], body))}[m[2]]()
                    self._reply(200, {"ok": True})
                else:
                    self._reply(404, {"error": {"code": "NOT_FOUND", "message": self.path, "retryable": False}})

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def close(self) -> None:
        self.httpd.shutdown()


@pytest.fixture
def server():
    s = FakeServer()
    yield s
    s.close()


def _worker(server: FakeServer) -> Worker:
    return Worker(ApiClient(server.base, SECRET, "test-worker"), SyntheticBackend(), poll_s=0.01)


def test_resume_from_generating_uploads_and_completes(server):
    img = Image.new("RGBA", (64, 64), (30, 90, 200, 255))
    buf = io.BytesIO()
    img.save(buf, "PNG")
    server.files["jobs/job_1/preprocessed.png"] = buf.getvalue()
    server.files["jobs/job_1/preprocess.json"] = json.dumps({"humanoid": True, "palette": ["#1e5ac8", "#d22525"]}).encode()
    job = {
        "jobId": "job_1", "characterId": "chr_1", "name": "테스트", "attempt": 2, "resumeStage": "GENERATING",
        "imageUrl": f"{server.base}/files/uploads/none.png", "options": {"seed": 7},
        "artifacts": {n: f"{server.base}/files/jobs/job_1/{n}" for n in ("preprocessed.png", "preprocess.json")},
    }
    w = _worker(server)
    assert w.api.claim() is None  # 204 → 대기
    server.jobs.append(job)
    claimed = w.api.claim()
    w.handle(claimed)
    assert not server.failed, server.failed
    assert len(server.completed) == 1
    job_id, c = server.completed[0]
    assert job_id == "job_1"
    # JobCompleteSchema
    assert c["tier"] in ("T1", "T2") and c["rigger"] == {"T1": "rigid", "T2": "smooth"}[c["tier"]]
    assert c["model"] and c["modelVersion"] and c["seed"] == 7
    assert c["glbArtifact"] == "character.glb" and c["thumbnailArtifact"] == "thumbnail.png"
    assert all(HEX.match(p) for p in c["palette"]) and 1 <= len(c["palette"]) <= 8
    meta = c["assetMeta"]
    assert meta["bones"] == 22 and 0 < meta["tris"] <= 20_000
    assert meta["glbBytes"] == len(server.files["jobs/job_1/character.glb"])
    assert server.files["jobs/job_1/thumbnail.png"][:4] == b"\x89PNG"
    # 단계 산출물 업로드 (다음 재시도 입력), 전처리는 다시 하지 않았다
    for name in ("generated.npz", "generate.json", "normalized.npz", "rig.npz", "validation.json", "skin.npz"):
        assert f"jobs/job_1/{name}" in server.files
    stages = [p["stage"] for p in server.progress]
    assert "PREPROCESSING" not in stages and stages[0] == "GENERATING" and stages[-1] == "EXPORTING"
    assert all(0.0 <= p["progress"] <= 1.0 for p in server.progress)
    assert server.unauthorized == 0


def test_image_download_failure_reports_retryable_fail(server):
    job = {
        "jobId": "job_2", "characterId": "chr_2", "name": "x", "attempt": 1, "resumeStage": "PREPROCESSING",
        "imageUrl": f"{server.base}/files/uploads/missing.png", "options": {}, "artifacts": {},
    }
    _worker(server).handle(job)
    assert not server.completed
    assert server.failed == [("job_2", {"stage": "PREPROCESSING", "code": "IMAGE_DOWNLOAD_FAILED", "retryable": True, "message": server.failed[0][1]["message"]})]
    assert len(server.failed[0][1]["message"]) <= 500


def test_wrong_secret_is_rejected(server):
    api = ApiClient(server.base, "wrong", "w")
    with pytest.raises(Exception):
        api.claim()
    assert server.unauthorized == 1
