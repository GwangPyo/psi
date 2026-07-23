from __future__ import annotations

from dataclasses import replace
from itertools import combinations

from .certificates import CertificateDependencyError, CertificateRegistry
from .domain import (
    CandidateStatus,
    GraphEdge,
    LeanVerificationJob,
    ReliabilityCertificate,
    SemanticCandidate,
    SemanticObject,
    VerificationClaim,
    VerificationMode,
    VerificationStatus,
    stable_id,
)
from .lean_verifier import LeanVerifier, VerificationError
from .store import ProjectGraphStore, encode


class GraphLeanSynchronizer:
    """Synchronize semantic graph generations with Lean certificate edges."""

    def __init__(self, store: ProjectGraphStore, verifier: LeanVerifier) -> None:
        self.store = store
        self.verifier = verifier

    def replace_objects(
        self,
        objects: list[SemanticObject],
        *,
        kind_prefixes: tuple[str, ...],
        edges: list[GraphEdge] | None = None,
        edge_source_types: tuple[str, ...] = (),
    ) -> int:
        incoming = {item.id: item for item in objects}
        with self.store.locked_state() as state:
            current = self.store.objects(state)
            retained = {
                item_id: item
                for item_id, item in current.items()
                if not item.kind.startswith(kind_prefixes)
            }
            replacement = {**retained, **incoming}
            current_edges = self.store.edges(state)
            incoming_edges = {item.id: item for item in (edges or [])}
            retained_edges = {
                item_id: item
                for item_id, item in current_edges.items()
                if not item.source_type.startswith(edge_source_types)
            }
            replacement_edges = {**retained_edges, **incoming_edges}
            changed_ids = {
                item_id
                for item_id in current.keys() | replacement.keys()
                if current.get(item_id) != replacement.get(item_id)
            }
            edges_changed = current_edges != replacement_edges
            if not changed_ids and not edges_changed:
                return int(state["generation"])

            state["generation"] = int(state["generation"]) + 1
            state["objects"] = {
                item_id: encode(item)
                for item_id, item in replacement.items()
            }
            state["edges"] = {
                item_id: encode(item)
                for item_id, item in replacement_edges.items()
            }
            self._invalidate_changed(state, changed_ids)
            return int(state["generation"])

    def enqueue_exact_contract_candidates(
        self,
        mode: VerificationMode,
    ) -> list[LeanVerificationJob]:
        snapshot = self.store.snapshot()
        objects = self.store.objects(snapshot)
        groups: dict[str, list[SemanticObject]] = {}
        for item in objects.values():
            if item.contract is not None and item.kind.endswith("-function"):
                groups.setdefault(item.contract.hash, []).append(item)
        jobs: list[LeanVerificationJob] = []
        for group in groups.values():
            for left, right in combinations(sorted(group, key=lambda item: item.id), 2):
                _, job = self.propose_candidate(
                    left.id,
                    right.id,
                    semantic_score=1.0,
                    evidence=("identical normalized semantic contract",),
                    model_revision="deterministic-contract-v1",
                    mode=mode,
                )
                jobs.append(job)
        return jobs

    def propose_candidate(
        self,
        left_object_id: str,
        right_object_id: str,
        *,
        semantic_score: float,
        evidence: tuple[str, ...],
        model_revision: str,
        relation: VerificationClaim = VerificationClaim.EQUIVALENT,
        mode: VerificationMode = VerificationMode.SMOOTH,
        dependencies: tuple[str, ...] = (),
    ) -> tuple[SemanticCandidate, LeanVerificationJob]:
        if not 0.0 <= semantic_score <= 1.0:
            raise ValueError("semantic score must be between 0 and 1")
        with self.store.locked_state() as state:
            objects = self.store.objects(state)
            left = objects[left_object_id]
            right = objects[right_object_id]
            contract_hashes = (
                left.contract.hash if left.contract else "missing",
                right.contract.hash if right.contract else "missing",
            )
            candidate = SemanticCandidate(
                id=stable_id(
                    "semantic-candidate",
                    self.store.project.id,
                    left.id,
                    right.id,
                    relation.value,
                    left.source_hash,
                    right.source_hash,
                    *contract_hashes,
                    model_revision,
                ),
                project_id=self.store.project.id,
                graph_generation=int(state["generation"]),
                left_object_id=left.id,
                right_object_id=right.id,
                relation=relation,
                semantic_score=semantic_score,
                evidence=evidence,
                model_revision=model_revision,
                source_hashes=(left.source_hash, right.source_hash),
                contract_hashes=contract_hashes,
            )
            job = self._job(
                state,
                left,
                right,
                claim=relation,
                mode=mode,
                dependencies=dependencies,
                candidate_id=candidate.id,
            )
            existing = state["jobs"].get(job.id)
            if existing and existing.get("status") == "complete":
                job = self.store.jobs(state)[job.id]
                existing_candidate = self.store.candidates(state).get(candidate.id)
                if existing_candidate is not None:
                    candidate = existing_candidate
            else:
                state["candidates"][candidate.id] = encode(candidate)
                state["jobs"][job.id] = encode(job)
            return candidate, job

    def enqueue(
        self,
        left_object_id: str,
        right_object_id: str,
        *,
        claim: VerificationClaim = VerificationClaim.EQUIVALENT,
        mode: VerificationMode = VerificationMode.SMOOTH,
        dependencies: tuple[str, ...] = (),
        candidate_id: str | None = None,
    ) -> LeanVerificationJob:
        with self.store.locked_state() as state:
            objects = self.store.objects(state)
            left = objects[left_object_id]
            right = objects[right_object_id]
            job = self._job(
                state,
                left,
                right,
                claim=claim,
                mode=mode,
                dependencies=dependencies,
                candidate_id=candidate_id,
            )
            existing = state["jobs"].get(job.id)
            if existing and existing.get("status") == "complete":
                return self.store.jobs(state)[job.id]
            state["jobs"][job.id] = encode(job)
            return job

    def synchronize_pending(self) -> list[ReliabilityCertificate]:
        completed: list[ReliabilityCertificate] = []
        while True:
            pending = next(
                (
                    job
                    for job in self.store.jobs().values()
                    if job.status == "pending"
                ),
                None,
            )
            if pending is None:
                return completed
            certificate = self.synchronize_job(pending.id)
            if certificate is not None:
                completed.append(certificate)

    def synchronize_job(self, job_id: str) -> ReliabilityCertificate | None:
        snapshot = self.store.snapshot()
        job = self.store.jobs(snapshot)[job_id]
        objects = self.store.objects(snapshot)
        if not self._job_matches(job, objects):
            self._mark_job(job.id, "stale", "graph object changed before verification")
            return None

        left = objects[job.left_object_id]
        right = objects[job.right_object_id]
        try:
            certificate = self.verifier.verify(
                self.store.project,
                left,
                right,
                claim=job.claim,
                mode=job.mode,
                dependencies=job.dependencies,
            )
        except VerificationError as error:
            self._mark_job(job.id, "error", str(error))
            self._mark_candidate(job.candidate_id, CandidateStatus.ERROR, str(error))
            raise

        try:
            with self.store.locked_state() as state:
                current_objects = self.store.objects(state)
                if not self._job_matches(job, current_objects):
                    state["jobs"][job.id] = encode(
                        replace(
                            job,
                            status="stale",
                            reason="graph object changed while Lean was verifying",
                        )
                    )
                    return None

                registry = CertificateRegistry()
                registry.certificates.update(self.store.certificates(state))
                accepted = registry.register(
                    replace(certificate, candidate_id=job.candidate_id)
                )
                state["certificates"] = {
                    item_id: encode(item)
                    for item_id, item in registry.certificates.items()
                }
                state["jobs"][job.id] = encode(replace(job, status="complete"))
                if job.candidate_id is not None:
                    candidate = self.store.candidates(state)[job.candidate_id]
                    candidate_status = (
                        CandidateStatus.CONFIRMED
                        if accepted.status is VerificationStatus.VERIFIED
                        else CandidateStatus.UNKNOWN
                    )
                    state["candidates"][candidate.id] = encode(
                        replace(
                            candidate,
                            status=candidate_status,
                            certificate_id=accepted.id,
                            reason=accepted.reason,
                        )
                    )
                return accepted
        except CertificateDependencyError as error:
            self._mark_job(job.id, "error", str(error))
            self._mark_candidate(job.candidate_id, CandidateStatus.ERROR, str(error))
            raise

    def reconcile(self) -> int:
        """Invalidate certificates whose source or contract hashes no longer match."""

        with self.store.locked_state() as state:
            objects = self.store.objects(state)
            changed = 0
            for item_id, certificate in self.store.certificates(state).items():
                if certificate.status is VerificationStatus.STALE:
                    continue
                left = objects.get(certificate.left_object_id)
                right = objects.get(certificate.right_object_id)
                if left is None or right is None or not _certificate_matches(
                    certificate,
                    left,
                    right,
                ):
                    state["certificates"][item_id] = encode(
                        replace(
                            certificate,
                            status=VerificationStatus.STALE,
                            proof_hash=None,
                            reason="source or contract hash no longer matches the graph",
                        )
                    )
                    changed += 1
            if changed:
                self._invalidate_certificate_dependents(state)
            return changed

    def _invalidate_changed(self, state: dict, changed_ids: set[str]) -> None:
        for item_id, certificate in self.store.certificates(state).items():
            if {
                certificate.left_object_id,
                certificate.right_object_id,
            } & changed_ids:
                state["certificates"][item_id] = encode(
                    replace(
                        certificate,
                        status=VerificationStatus.STALE,
                        proof_hash=None,
                        reason="semantic graph object changed",
                    )
                )
        for item_id, job in self.store.jobs(state).items():
            if {job.left_object_id, job.right_object_id} & changed_ids:
                state["jobs"][item_id] = encode(
                    replace(job, status="stale", reason="semantic graph object changed")
                )
        for item_id, candidate in self.store.candidates(state).items():
            if {candidate.left_object_id, candidate.right_object_id} & changed_ids:
                state["candidates"][item_id] = encode(
                    replace(
                        candidate,
                        status=CandidateStatus.STALE,
                        certificate_id=None,
                        reason="semantic graph object changed",
                    )
                )
        self._invalidate_certificate_dependents(state)

    def _invalidate_certificate_dependents(self, state: dict) -> None:
        certificates = self.store.certificates(state)
        stale = {
            item_id
            for item_id, item in certificates.items()
            if item.status is VerificationStatus.STALE
        }
        changed = True
        while changed:
            changed = False
            for item_id, certificate in certificates.items():
                if item_id in stale or not (set(certificate.dependencies) & stale):
                    continue
                stale.add(item_id)
                changed = True
        for item_id in stale:
            certificate = certificates[item_id]
            if certificate.status is not VerificationStatus.STALE:
                state["certificates"][item_id] = encode(
                    replace(
                        certificate,
                        status=VerificationStatus.STALE,
                        proof_hash=None,
                        reason="proof dependency became stale",
                    )
                )

    def _mark_job(self, job_id: str, status: str, reason: str) -> None:
        with self.store.locked_state() as state:
            job = self.store.jobs(state)[job_id]
            state["jobs"][job_id] = encode(replace(job, status=status, reason=reason))

    def _mark_candidate(
        self,
        candidate_id: str | None,
        status: CandidateStatus,
        reason: str,
    ) -> None:
        if candidate_id is None:
            return
        with self.store.locked_state() as state:
            candidate = self.store.candidates(state)[candidate_id]
            state["candidates"][candidate_id] = encode(
                replace(candidate, status=status, reason=reason)
            )

    def _job(
        self,
        state: dict,
        left: SemanticObject,
        right: SemanticObject,
        *,
        claim: VerificationClaim,
        mode: VerificationMode,
        dependencies: tuple[str, ...],
        candidate_id: str | None,
    ) -> LeanVerificationJob:
        contract_hashes = (
            left.contract.hash if left.contract else "missing",
            right.contract.hash if right.contract else "missing",
        )
        return LeanVerificationJob(
            id=stable_id(
                "lean-job",
                self.store.project.id,
                left.id,
                right.id,
                claim.value,
                mode.value,
                left.source_hash,
                right.source_hash,
                *contract_hashes,
                *(dependencies or (candidate_id or "direct",)),
            ),
            project_id=self.store.project.id,
            graph_generation=int(state["generation"]),
            left_object_id=left.id,
            right_object_id=right.id,
            claim=claim,
            mode=mode,
            source_hashes=(left.source_hash, right.source_hash),
            contract_hashes=contract_hashes,
            dependencies=dependencies,
            candidate_id=candidate_id,
        )

    @staticmethod
    def _job_matches(
        job: LeanVerificationJob,
        objects: dict[str, SemanticObject],
    ) -> bool:
        left = objects.get(job.left_object_id)
        right = objects.get(job.right_object_id)
        if left is None or right is None:
            return False
        contract_hashes = (
            left.contract.hash if left.contract else "missing",
            right.contract.hash if right.contract else "missing",
        )
        return (
            (left.source_hash, right.source_hash) == job.source_hashes
            and contract_hashes == job.contract_hashes
        )


def _certificate_matches(
    certificate: ReliabilityCertificate,
    left: SemanticObject,
    right: SemanticObject,
) -> bool:
    return certificate.source_hashes == (left.source_hash, right.source_hash) and (
        certificate.contract_hashes
        == (
            left.contract.hash if left.contract else "missing",
            right.contract.hash if right.contract else "missing",
        )
    )
