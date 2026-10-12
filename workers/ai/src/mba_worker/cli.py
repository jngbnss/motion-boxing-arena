"""`mba-worker` CLI.

  uv run mba-worker --api http://localhost:2567 --secret dev-worker-secret   # 폴링 루프
  uv run mba-worker once --image char.png --out out.glb                    # 서버 없이 1회 실행
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import socket
import sys
import time
import uuid
from pathlib import Path


def _configure_logging(verbose: bool) -> None:
    # Windows 파이프/콘솔 기본 인코딩(cp949 등)에서도 한글 로그가 깨지지 않게
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    for noisy in ("httpx", "httpcore", "urllib3", "PIL"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


def _cmd_loop(args: argparse.Namespace) -> int:
    from .api import ApiClient
    from .generate import TripoSRBackend
    from .worker import Worker

    worker_id = args.worker_id or f"{socket.gethostname()}-{uuid.uuid4().hex[:6]}"
    api = ApiClient(args.api, args.secret, worker_id)
    worker = Worker(api, TripoSRBackend(args.device), poll_s=args.poll)
    try:
        worker.run_forever()
    except KeyboardInterrupt:
        worker.stop.set()
    return 0


def _cmd_once(args: argparse.Namespace) -> int:
    from .errors import StageError
    from .generate import TripoSRBackend
    from .pipeline import GLB_ARTIFACT, JobSpec, LocalStore, Pipeline
    from .preprocess import warmup

    image = Path(args.image)
    out = Path(args.out)
    work = Path(args.work_dir) if args.work_dir else out.with_suffix("").parent / f"{out.stem}.artifacts"
    store = LocalStore(work)
    backend = TripoSRBackend(args.device)
    t0 = time.perf_counter()
    backend.load()  # 모델 로드(첫 실행 시 다운로드)는 단계 타임아웃에 넣지 않는다
    warmup()
    load_s = time.perf_counter() - t0
    spec = JobSpec(
        job_id="local",
        load_image=image.read_bytes,
        resume_stage=args.resume,
        seed=args.seed,
        prefer_tier=args.prefer_tier,
    )
    try:
        result = Pipeline(backend).run(spec, store)
    except StageError as e:
        print(json.dumps({"ok": False, "stage": e.stage, "code": e.code, "retryable": e.retryable, "message": e.message}, ensure_ascii=False, indent=1))
        return 2
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(store.get(GLB_ARTIFACT))
    metrics = {k: v for k, v in result.metrics.items() if k != "EXPORTING"}  # EXPORTING 지표 = complete 와 동일
    summary = {"ok": True, "glb": str(out), "artifacts": str(work), "modelLoadS": round(load_s, 2), "timings": result.timings, "complete": result.complete, "metrics": metrics}
    print(json.dumps(summary, ensure_ascii=False, indent=1, default=str))
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="mba-worker", description="Motion Boxing Arena AI 생성 워커")
    p.add_argument("--api", default=os.environ.get("MBA_API_URL", "http://localhost:2567"), help="API 서버 (기본 $MBA_API_URL 또는 http://localhost:2567)")
    p.add_argument("--secret", default=os.environ.get("WORKER_SECRET", "dev-worker-secret"), help="X-Worker-Secret (기본 $WORKER_SECRET)")
    p.add_argument("--worker-id", default=os.environ.get("WORKER_ID"))
    p.add_argument("--poll", type=float, default=2.0, help="claim 폴링 간격(초)")
    p.add_argument("--device", default=None, help="cuda | cpu (기본: CUDA 있으면 cuda)")
    p.add_argument("-v", "--verbose", action="store_true")
    sub = p.add_subparsers(dest="cmd")
    once = sub.add_parser("once", help="서버 없이 이미지 1장 → GLB")
    once.add_argument("--image", required=True)
    once.add_argument("--out", required=True)
    once.add_argument("--work-dir", help="단계 산출물 디렉터리 (기본: <out>.artifacts)")
    once.add_argument("--seed", type=int, default=None)
    once.add_argument("--prefer-tier", choices=["T2", "T1", "T0"], default=None)
    once.add_argument("--resume", default="PREPROCESSING", choices=["PREPROCESSING", "GENERATING", "POSTPROCESSING", "RIGGING", "VALIDATING", "EXPORTING"], help="work-dir 의 산출물로 이 단계부터 재개")
    args = p.parse_args(argv)
    _configure_logging(args.verbose)
    return _cmd_once(args) if args.cmd == "once" else _cmd_loop(args)


if __name__ == "__main__":
    sys.exit(main())
