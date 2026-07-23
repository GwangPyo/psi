from __future__ import annotations

import fcntl
import hashlib
import json
import os
import sys
from datetime import UTC, datetime
from contextlib import contextmanager
from dataclasses import asdict
from pathlib import Path
from typing import Iterator

from .domain import (
    CandidateStatus,
    ContractObject,
    Effect,
    GraphEdge,
    LeanVerificationJob,
    ProjectIdentity,
    ReliabilityCertificate,
    SemanticCandidate,
    SemanticObject,
    SourceSpan,
    VerificationClaim,
    VerificationMode,
    VerificationStatus,
)


class ProjectGraphStore:
    """Durable project graph snapshot and Lean verification outbox."""

    schema_version = 3

    def __init__(self, root: str | Path, project: ProjectIdentity) -> None:
        self.root = Path(root) / project.id
        self.project = project
        self.state_path = self.root / "graph.json"
        self.manifest_path = self.root / "manifest.json"
        self.snapshots_path = self.root / "snapshots"
        self.lock_path = self.root / ".lock"

    @contextmanager
    def locked_state(self) -> Iterator[dict]:
        self.root.mkdir(parents=True, exist_ok=True)
        with self.lock_path.open("a+", encoding="utf-8") as lock:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
            state = self._read()
            yield state
            self._write(state)

    def snapshot(self) -> dict:
        self.root.mkdir(parents=True, exist_ok=True)
        with self.lock_path.open("a+", encoding="utf-8") as lock:
            fcntl.flock(lock.fileno(), fcntl.LOCK_SH)
            return self._read()

    def objects(self, state: dict | None = None) -> dict[str, SemanticObject]:
        value = state if state is not None else self.snapshot()
        return {
            item_id: _semantic_object(item)
            for item_id, item in value["objects"].items()
        }

    def certificates(self, state: dict | None = None) -> dict[str, ReliabilityCertificate]:
        value = state if state is not None else self.snapshot()
        return {
            item_id: _certificate(item)
            for item_id, item in value["certificates"].items()
        }

    def candidates(self, state: dict | None = None) -> dict[str, SemanticCandidate]:
        value = state if state is not None else self.snapshot()
        return {
            item_id: _candidate(item)
            for item_id, item in value["candidates"].items()
        }

    def edges(self, state: dict | None = None) -> dict[str, GraphEdge]:
        value = state if state is not None else self.snapshot()
        return {
            item_id: _edge(item)
            for item_id, item in value["edges"].items()
        }

    def jobs(self, state: dict | None = None) -> dict[str, LeanVerificationJob]:
        value = state if state is not None else self.snapshot()
        return {
            item_id: _job(item)
            for item_id, item in value["jobs"].items()
        }

    def _read(self) -> dict:
        if self.manifest_path.exists():
            return self._read_manifest_snapshot()
        if not self.state_path.exists():
            return {
                "schema_version": self.schema_version,
                "project": _project_dict(self.project),
                "generation": 0,
                "objects": {},
                "edges": {},
                "candidates": {},
                "certificates": {},
                "jobs": {},
            }
        state = json.loads(self.state_path.read_text(encoding="utf-8"))
        return self._migrate_state(state)

    def _migrate_state(self, state: dict) -> dict:
        if state.get("schema_version") == 1:
            state["schema_version"] = 2
            state["candidates"] = {}
        if state.get("schema_version") == 2:
            state["schema_version"] = 3
            state["edges"] = {}
        if state.get("schema_version") != self.schema_version:
            raise ValueError("unsupported project graph schema")
        return state

    def _write(self, state: dict) -> None:
        self.snapshots_path.mkdir(parents=True, exist_ok=True)
        content = json.dumps(
            state,
            ensure_ascii=False,
            sort_keys=True,
            indent=2,
        ).encode("utf-8")
        digest = hashlib.sha256(content).hexdigest()
        snapshot_name = f"graph-{digest}.json"
        snapshot = self.snapshots_path / snapshot_name
        if not snapshot.exists():
            temporary = self.snapshots_path / f".{snapshot_name}.{os.getpid()}.tmp"
            with temporary.open("wb") as stream:
                stream.write(content)
                stream.flush()
                os.fsync(stream.fileno())
            temporary.replace(snapshot)

        previous: list[dict[str, str]] = []
        if self.manifest_path.exists():
            try:
                old = json.loads(self.manifest_path.read_text(encoding="utf-8"))
                previous = [
                    {"file": old["active"], "sha256": old["sha256"]},
                    *old.get("previous", []),
                ][:8]
            except (json.JSONDecodeError, KeyError, OSError):
                previous = []
        manifest = {
            "schema_version": 1,
            "active": snapshot_name,
            "sha256": digest,
            "previous": [item for item in previous if item["file"] != snapshot_name],
        }
        manifest_content = json.dumps(
            manifest,
            ensure_ascii=False,
            sort_keys=True,
            indent=2,
        ).encode("utf-8")
        temporary_manifest = self.root / f".manifest.{os.getpid()}.tmp"
        with temporary_manifest.open("wb") as stream:
            stream.write(manifest_content)
            stream.flush()
            os.fsync(stream.fileno())
        temporary_manifest.replace(self.manifest_path)

    def _read_manifest_snapshot(self) -> dict:
        try:
            manifest = json.loads(self.manifest_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as error:
            raise CorruptGraphStore(f"invalid graph manifest: {error}") from error
        candidates = [
            {"file": manifest.get("active"), "sha256": manifest.get("sha256")},
            *manifest.get("previous", []),
        ]
        failures: list[str] = []
        for candidate in candidates:
            filename = candidate.get("file")
            expected = candidate.get("sha256")
            if not filename or not expected:
                continue
            path = self.snapshots_path / filename
            try:
                content = path.read_bytes()
                if hashlib.sha256(content).hexdigest() != expected:
                    failures.append(f"{filename}: checksum mismatch")
                    continue
                state = json.loads(content)
            except (OSError, json.JSONDecodeError) as error:
                failures.append(f"{filename}: {error}")
                continue
            try:
                return self._migrate_state(state)
            except ValueError as error:
                failures.append(f"{filename}: {error}")
                continue
        raise CorruptGraphStore("no valid graph snapshot: " + "; ".join(failures))

    def archive_corrupt_legacy(self) -> Path:
        """Preserve a damaged legacy graph file before rebuilding from source."""

        if not self.state_path.exists():
            raise FileNotFoundError("legacy graph file is absent")
        archive = self.root / "corrupt"
        archive.mkdir(parents=True, exist_ok=True)
        timestamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%S.%fZ")
        target = archive / f"graph-{timestamp}.json"
        self.state_path.replace(target)
        print(f"archived corrupt project graph at {target}", file=sys.stderr)
        return target


class CorruptGraphStore(RuntimeError):
    pass


def encode(value: object) -> dict:
    return asdict(value)


def _project_dict(project: ProjectIdentity) -> dict:
    value = asdict(project)
    value["root"] = str(project.root)
    return value


def _contract(value: dict | None) -> ContractObject | None:
    if value is None:
        return None
    return ContractObject(
        input_kinds=tuple(value["input_kinds"]),
        output_kind=value["output_kind"],
        behavior=value["behavior"],
        effect=Effect(value["effect"]),
        failure_modes=tuple(value["failure_modes"]),
    )


def _semantic_object(value: dict) -> SemanticObject:
    return SemanticObject(
        id=value["id"],
        project_id=value["project_id"],
        kind=value["kind"],
        qualified_name=value["qualified_name"],
        source=SourceSpan(**value["source"]),
        source_hash=value["source_hash"],
        contract=_contract(value["contract"]),
        extractor=value["extractor"],
        confidence=float(value["confidence"]),
        summary=value.get("summary", ""),
        semantic_tags=tuple(value.get("semantic_tags", [])),
    )


def _edge(value: dict) -> GraphEdge:
    return GraphEdge(
        id=value["id"],
        project_id=value["project_id"],
        source_id=value["source_id"],
        target_id=value["target_id"],
        relation=value["relation"],
        source_type=value["source_type"],
        confidence=float(value["confidence"]),
        properties=tuple(tuple(item) for item in value.get("properties", [])),
    )


def _certificate(value: dict) -> ReliabilityCertificate:
    return ReliabilityCertificate(
        id=value["id"],
        project_id=value["project_id"],
        left_object_id=value["left_object_id"],
        right_object_id=value["right_object_id"],
        claim=VerificationClaim(value["claim"]),
        status=VerificationStatus(value["status"]),
        mode=VerificationMode(value["mode"]),
        source_hashes=tuple(value["source_hashes"]),
        contract_hashes=tuple(value["contract_hashes"]),
        dependencies=tuple(value["dependencies"]),
        lean_version=value["lean_version"],
        proof_hash=value.get("proof_hash"),
        reason=value.get("reason"),
        candidate_id=value.get("candidate_id"),
    )


def _candidate(value: dict) -> SemanticCandidate:
    return SemanticCandidate(
        id=value["id"],
        project_id=value["project_id"],
        graph_generation=int(value["graph_generation"]),
        left_object_id=value["left_object_id"],
        right_object_id=value["right_object_id"],
        relation=VerificationClaim(value["relation"]),
        semantic_score=float(value["semantic_score"]),
        evidence=tuple(value["evidence"]),
        model_revision=value["model_revision"],
        source_hashes=tuple(value["source_hashes"]),
        contract_hashes=tuple(value["contract_hashes"]),
        status=CandidateStatus(value["status"]),
        certificate_id=value.get("certificate_id"),
        reason=value.get("reason"),
    )


def _job(value: dict) -> LeanVerificationJob:
    return LeanVerificationJob(
        id=value["id"],
        project_id=value["project_id"],
        graph_generation=int(value["graph_generation"]),
        left_object_id=value["left_object_id"],
        right_object_id=value["right_object_id"],
        claim=VerificationClaim(value["claim"]),
        mode=VerificationMode(value["mode"]),
        source_hashes=tuple(value["source_hashes"]),
        contract_hashes=tuple(value["contract_hashes"]),
        dependencies=tuple(value["dependencies"]),
        candidate_id=value.get("candidate_id"),
        status=value["status"],
        reason=value.get("reason"),
    )
