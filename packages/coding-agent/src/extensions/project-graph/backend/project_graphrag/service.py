from __future__ import annotations

from dataclasses import asdict
from pathlib import Path

from .background_config import load_background_model_config
from .domain import VerificationClaim, VerificationMode
from .graphrag_index import ProjectGraphRagIndexer
from .graphrag_job import GraphRagIndexJobManager
from .indexer import ProjectIndexer
from .lean_verifier import LeanVerifier
from .project import identify_project
from .query import ProjectGraphContext, ProjectGraphQuery
from .store import ProjectGraphStore
from .synchronizer import GraphLeanSynchronizer


class ProjectGraphService:
    def __init__(self, project_root: str | Path, data_root: str | Path) -> None:
        self.project = identify_project(project_root)
        self.store = ProjectGraphStore(data_root, self.project)
        self.verifier = LeanVerifier()
        self.synchronizer = GraphLeanSynchronizer(self.store, self.verifier)
        self.query = ProjectGraphQuery(self.store)
        self.graph_rag_index = ProjectGraphRagIndexer(project_root, data_root)
        self.graph_rag_jobs = GraphRagIndexJobManager(project_root, data_root)

    def status(self) -> dict:
        state = self.store.snapshot()
        background_model = load_background_model_config(self.project.root)
        return {
            "project": asdict(self.project) | {"root": str(self.project.root)},
            "generation": state["generation"],
            "objects": len(state["objects"]),
            "edges": len(state["edges"]),
            "candidates": len(state["candidates"]),
            "certificates": len(state["certificates"]),
            "jobs": len(state["jobs"]),
            "background_model": asdict(background_model),
            "graphrag_index": self.graph_rag_index.status(),
        }

    def start_graphrag_index(self) -> dict:
        return self.graph_rag_jobs.start()

    def graphrag_index_job_status(self, job_id: str | None = None) -> dict:
        return self.graph_rag_jobs.status(job_id)

    def reindex(self, mode: VerificationMode = VerificationMode.SMOOTH) -> dict:
        self.synchronizer.reconcile()
        result = ProjectIndexer(self.synchronizer).index_project(mode)
        certificates = self.synchronizer.synchronize_pending()
        return {
            "generation": result.generation,
            "objects": result.object_count,
            "queued": result.pending_verifications,
            "verified": len(certificates),
            "errors": list(result.errors),
        }

    def search(
        self,
        query: str,
        *,
        max_entry_nodes: int = 8,
        max_hops: int = 2,
    ) -> dict:
        if self.store.snapshot()["generation"] == 0:
            self.reindex()
        return context_result(
            self.query.search(
                query,
                max_entry_nodes=max_entry_nodes,
                max_hops=max_hops,
            )
        )

    def get(self, object_id: str) -> dict:
        state = self.store.snapshot()
        item = self.store.objects(state)[object_id]
        return asdict(item)

    def neighbors(self, object_id: str, max_hops: int = 1) -> dict:
        return context_result(self.query.neighbors(object_id, max_hops=max_hops))

    def verify_candidate(
        self,
        left_object_id: str,
        right_object_id: str,
        *,
        semantic_score: float,
        evidence: tuple[str, ...],
        model_revision: str,
        mode: VerificationMode,
    ) -> dict:
        background_model = load_background_model_config(self.project.root)
        if background_model.state != "ready":
            raise RuntimeError(
                "backgroundAgentDefaultModel must be configured before model-derived candidate verification"
            )
        if model_revision != background_model.revision:
            raise ValueError(
                "semantic candidate model revision does not match backgroundAgentDefaultModel"
            )
        candidate, job = self.synchronizer.propose_candidate(
            left_object_id,
            right_object_id,
            semantic_score=semantic_score,
            evidence=evidence,
            model_revision=model_revision,
            relation=VerificationClaim.EQUIVALENT,
            mode=mode,
        )
        certificate = self.synchronizer.synchronize_job(job.id)
        return {
            "candidate": asdict(candidate),
            "certificate": asdict(certificate) if certificate else None,
        }


def context_result(context: ProjectGraphContext) -> dict:
    return {
        "query": context.query,
        "entry_nodes": [
            {
                "object": asdict(item.object),
                "score": item.score,
                "reasons": list(item.reasons),
            }
            for item in context.entry_nodes
        ],
        "objects": [asdict(item) for item in context.objects],
        "edges": [asdict(item) for item in context.edges],
    }
