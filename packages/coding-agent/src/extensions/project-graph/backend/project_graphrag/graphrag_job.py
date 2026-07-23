from __future__ import annotations

import argparse
import asyncio
import fcntl
import json
import os
import subprocess
import sys
import uuid
from datetime import UTC, datetime
from pathlib import Path

from .background_config import load_background_model_config
from .graphrag_index import ProjectGraphRagIndexer
from .project import identify_project
from .store import ProjectGraphStore


_BACKGROUND_PROCESSES: dict[int, subprocess.Popen] = {}


class GraphRagIndexJobManager:
    def __init__(self, project_root: str | Path, data_root: str | Path) -> None:
        self.project = identify_project(project_root)
        self.data_root = Path(data_root).resolve()
        self.store = ProjectGraphStore(self.data_root, self.project)
        self.jobs_root = self.store.root / "graphrag" / "jobs"

    def start(self) -> dict:
        config = load_background_model_config(self.project.root)
        if config.state != "ready" or config.model_reference is None:
            raise RuntimeError("backgroundAgentDefaultModel must be configured for GraphRAG indexing")
        active = self._active_job()
        if active is not None:
            return active
        job_id = uuid.uuid4().hex
        created_at = _now()
        job = {
            "schema_version": 1,
            "job_id": job_id,
            "state": "queued",
            "project_root": str(self.project.root),
            "model_reference": config.model_reference,
            "model_revision": config.revision,
            "created_at": created_at,
            "updated_at": created_at,
            "worker_lease": f"{job_id}.lease",
            "progress": {
                "phase": "queued",
                "message": "Waiting for the background GraphRAG worker",
            },
        }
        self._write(job_id, job)
        self.jobs_root.mkdir(parents=True, exist_ok=True)
        log_path = self.jobs_root / f"{job_id}.log"
        lease_path = self.jobs_root / job["worker_lease"]
        environment = dict(os.environ)
        module_root = str(Path(__file__).resolve().parents[1])
        python_path = environment.get("PYTHONPATH", "")
        environment["PYTHONPATH"] = (
            module_root if not python_path else module_root + os.pathsep + python_path
        )
        environment.setdefault("LITELLM_LOCAL_MODEL_COST_MAP", "true")
        with log_path.open("ab") as log, lease_path.open("a+") as lease:
            fcntl.flock(lease.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            process = subprocess.Popen(
                [
                    sys.executable,
                    "-m",
                    "project_graphrag.graphrag_job",
                    "--project-root",
                    str(self.project.root),
                    "--data-root",
                    str(self.data_root),
                    "--job-id",
                    job_id,
                ],
                cwd=self.project.root,
                env=environment,
                stdin=subprocess.DEVNULL,
                stdout=log,
                stderr=log,
                start_new_session=True,
                pass_fds=(lease.fileno(),),
            )
        _BACKGROUND_PROCESSES[process.pid] = process
        latest = self.status(job_id)
        if latest.get("state") == "queued":
            latest["pid"] = process.pid
            latest["worker_identity"] = _process_identity(process.pid)
            self._write(job_id, latest)
        return latest

    def status(self, job_id: str | None = None) -> dict:
        if job_id is None:
            jobs = sorted(self.jobs_root.glob("*.json"), key=lambda path: path.stat().st_mtime)
            if not jobs:
                return {"state": "absent"}
            path = jobs[-1]
        else:
            path = self.jobs_root / f"{job_id}.json"
        if not path.exists():
            raise KeyError(f"unknown GraphRAG indexing job: {job_id}")
        job = json.loads(path.read_text(encoding="utf-8"))
        if job.get("state") in {"queued", "running"} and isinstance(job.get("pid"), int):
            if not _worker_alive(job, self.jobs_root):
                # Re-read before writing so a worker that committed its terminal state
                # between the first read and the liveness check is never overwritten.
                latest = json.loads(path.read_text(encoding="utf-8"))
                if (
                    latest.get("state") in {"queued", "running"}
                    and latest.get("pid") == job["pid"]
                    and latest.get("worker_identity") == job.get("worker_identity")
                    and not _worker_alive(latest, self.jobs_root)
                ):
                    completed_at = _now()
                    latest["state"] = "error"
                    latest["failure_kind"] = "worker_exited"
                    latest["error"] = "GraphRAG worker exited before reporting completion"
                    latest["updated_at"] = completed_at
                    latest["completed_at"] = completed_at
                    latest["progress"] = {
                        "phase": "error",
                        "message": latest["error"],
                    }
                    self._write(str(latest["job_id"]), latest)
                job = latest
        if job.get("state") in {"complete", "error"} and isinstance(job.get("pid"), int):
            process = _BACKGROUND_PROCESSES.get(job["pid"])
            if process is not None:
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    pass
                else:
                    _BACKGROUND_PROCESSES.pop(job["pid"], None)
        return job

    def _active_job(self) -> dict | None:
        if not self.jobs_root.exists():
            return None
        for path in sorted(self.jobs_root.glob("*.json"), reverse=True):
            job = self.status(path.stem)
            if job.get("state") not in {"queued", "running"}:
                continue
            return job
        return None

    def _write(self, job_id: str, value: dict) -> None:
        self.jobs_root.mkdir(parents=True, exist_ok=True)
        target = self.jobs_root / f"{job_id}.json"
        temporary = self.jobs_root / f".{job_id}.{os.getpid()}.tmp"
        temporary.write_text(
            json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2),
            encoding="utf-8",
        )
        temporary.replace(target)


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _process_identity(pid: int) -> dict[str, int | str] | None:
    """Identify one OS process instance without using elapsed-time heuristics."""

    try:
        session_id = os.getsid(pid)
    except (ProcessLookupError, PermissionError):
        return None
    identity: dict[str, int | str] = {"session_id": session_id}
    try:
        stat = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8")
    except OSError:
        return identity
    closing_parenthesis = stat.rfind(")")
    fields = stat[closing_parenthesis + 2 :].split()
    if closing_parenthesis >= 0 and len(fields) > 19:
        identity["start_time_ticks"] = fields[19]
    return identity


def _worker_alive(job: dict, jobs_root: Path) -> bool:
    lease_name = job.get("worker_lease")
    if isinstance(lease_name, str):
        if Path(lease_name).name != lease_name:
            return False
        return _lease_held(jobs_root / lease_name)

    pid = job.get("pid")
    if not isinstance(pid, int) or not _pid_alive(pid):
        return False

    expected_identity = job.get("worker_identity")
    current_identity = _process_identity(pid)
    if isinstance(expected_identity, dict):
        return current_identity == expected_identity

    # Legacy jobs predate worker_identity. On procfs systems, bind the live PID
    # to this exact job ID so PID reuse cannot keep an orphan marked running.
    try:
        command = Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0")
    except OSError:
        return current_identity is not None
    encoded_job_id = str(job.get("job_id", "")).encode("utf-8")
    return (
        b"project_graphrag.graphrag_job" in command
        and b"--job-id" in command
        and encoded_job_id in command
    )


def _lease_held(path: Path) -> bool:
    if not path.exists():
        return False
    with path.open("r+") as lease:
        try:
            fcntl.flock(lease.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return True
        fcntl.flock(lease.fileno(), fcntl.LOCK_UN)
    return False


async def _run(project_root: Path, data_root: Path, job_id: str) -> None:
    manager = GraphRagIndexJobManager(project_root, data_root)
    job = manager.status(job_id)
    job["state"] = "running"
    job["pid"] = os.getpid()
    job["worker_identity"] = _process_identity(os.getpid())
    job["started_at"] = _now()
    job["updated_at"] = _now()
    job["progress"] = {
        "phase": "starting",
        "message": "Starting the background GraphRAG worker",
    }
    manager._write(job_id, job)

    def report_progress(progress: dict[str, object]) -> None:
        latest = manager.status(job_id)
        latest["state"] = "running"
        latest["updated_at"] = _now()
        previous = latest.get("progress", {})
        carried = {
            key: previous[key]
            for key in (
                "documents_total",
                "objects_indexed",
                "workflows_completed",
                "workflows_total",
            )
            if isinstance(previous, dict) and key in previous
        }
        latest["progress"] = {**carried, **progress}
        manager._write(job_id, latest)

    try:
        manifest = await ProjectGraphRagIndexer(
            project_root,
            data_root,
            progress_callback=report_progress,
        ).build(build_id=job_id)
    except Exception as error:
        job = manager.status(job_id)
        job["state"] = "error"
        job["error"] = f"{type(error).__name__}: {error}"
        job["updated_at"] = _now()
        job["completed_at"] = _now()
        job["progress"] = {
            "phase": "error",
            "message": job["error"],
        }
        manager._write(job_id, job)
        raise
    job = manager.status(job_id)
    job["state"] = "complete"
    job["result"] = manifest
    job["updated_at"] = _now()
    job["completed_at"] = _now()
    job["progress"] = {
        **{
            key: job["progress"][key]
            for key in (
                "documents_total",
                "objects_indexed",
                "workflows_completed",
                "workflows_total",
            )
            if isinstance(job.get("progress"), dict) and key in job["progress"]
        },
        "phase": "complete",
        "message": "GraphRAG index is ready",
        "documents_total": manifest.get("document_count", 0),
    }
    manager._write(job_id, job)


def _now() -> str:
    return datetime.now(UTC).isoformat()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project-root", required=True)
    parser.add_argument("--data-root", required=True)
    parser.add_argument("--job-id", required=True)
    arguments = parser.parse_args()
    with asyncio.Runner() as runner:
        runner.run(
            _run(
                Path(arguments.project_root),
                Path(arguments.data_root),
                arguments.job_id,
            )
        )


if __name__ == "__main__":
    main()
