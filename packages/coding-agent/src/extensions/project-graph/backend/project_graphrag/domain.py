from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass
from enum import StrEnum
from pathlib import Path


class Effect(StrEnum):
    PURE = "pure"
    STATE = "state"
    IO = "io"
    UNKNOWN = "unknown"


class VerificationMode(StrEnum):
    STRICT = "strict"
    SMOOTH = "smooth"


class VerificationStatus(StrEnum):
    VERIFIED = "verified"
    UNKNOWN = "unknown"
    ERROR = "error"
    STALE = "stale"


class VerificationClaim(StrEnum):
    EQUIVALENT = "equivalent"
    DIFFERENT = "different"


class CandidateStatus(StrEnum):
    PENDING = "pending"
    CONFIRMED = "confirmed"
    UNKNOWN = "unknown"
    ERROR = "error"
    STALE = "stale"


@dataclass(frozen=True)
class ProjectIdentity:
    id: str
    root: Path
    git_remote: str | None
    git_head: str | None
    git_branch: str | None
    worktree_revision: str


@dataclass(frozen=True)
class SourceSpan:
    path: str
    start_line: int
    end_line: int


@dataclass(frozen=True)
class ContractObject:
    input_kinds: tuple[str, ...]
    output_kind: str
    behavior: str
    effect: Effect
    failure_modes: tuple[str, ...] = ()

    @property
    def hash(self) -> str:
        return _digest(asdict(self))


@dataclass(frozen=True)
class SemanticObject:
    id: str
    project_id: str
    kind: str
    qualified_name: str
    source: SourceSpan
    source_hash: str
    contract: ContractObject | None
    extractor: str
    confidence: float
    summary: str = ""
    semantic_tags: tuple[str, ...] = ()


@dataclass(frozen=True)
class GraphEdge:
    id: str
    project_id: str
    source_id: str
    target_id: str
    relation: str
    source_type: str
    confidence: float
    properties: tuple[tuple[str, str], ...] = ()


@dataclass(frozen=True)
class ReliabilityCertificate:
    id: str
    project_id: str
    left_object_id: str
    right_object_id: str
    claim: VerificationClaim
    status: VerificationStatus
    mode: VerificationMode
    source_hashes: tuple[str, str]
    contract_hashes: tuple[str, str]
    dependencies: tuple[str, ...]
    lean_version: str
    proof_hash: str | None = None
    reason: str | None = None
    candidate_id: str | None = None


@dataclass(frozen=True)
class SemanticCandidate:
    id: str
    project_id: str
    graph_generation: int
    left_object_id: str
    right_object_id: str
    relation: VerificationClaim
    semantic_score: float
    evidence: tuple[str, ...]
    model_revision: str
    source_hashes: tuple[str, str]
    contract_hashes: tuple[str, str]
    status: CandidateStatus = CandidateStatus.PENDING
    certificate_id: str | None = None
    reason: str | None = None


@dataclass(frozen=True)
class LeanVerificationJob:
    id: str
    project_id: str
    graph_generation: int
    left_object_id: str
    right_object_id: str
    claim: VerificationClaim
    mode: VerificationMode
    source_hashes: tuple[str, str]
    contract_hashes: tuple[str, str]
    dependencies: tuple[str, ...]
    candidate_id: str | None = None
    status: str = "pending"
    reason: str | None = None


def stable_id(namespace: str, *values: str) -> str:
    return f"{namespace}:" + _digest(values)[:32]


def _digest(value: object) -> str:
    encoded = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()
