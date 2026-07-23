from __future__ import annotations

import hashlib
import json
import os
import uuid
import warnings
from collections import defaultdict
from pathlib import Path
from typing import TYPE_CHECKING, Awaitable, Callable

import pandas as pd
from graphrag.index.typing.pipeline_run_result import PipelineRunResult
from graphrag.logger.progress import Progress

from .background_config import BackgroundModelConfigure, load_background_model_config
from .domain import VerificationMode
from .indexer import ProjectIndexer
from .indexing_model import IndexingModel, PiIndexingModel
from .graphrag_merge import merge_graphrag_output
from .lean_verifier import LeanVerifier
from .project import identify_project
from .store import ProjectGraphStore
from .synchronizer import GraphLeanSynchronizer


SOURCE_EXTENSIONS = {
    ".c",
    ".cc",
    ".cpp",
    ".go",
    ".h",
    ".hpp",
    ".java",
    ".js",
    ".json",
    ".jsx",
    ".md",
    ".py",
    ".rs",
    ".toml",
    ".ts",
    ".tsx",
    ".yaml",
    ".yml",
}
EXCLUDED_DIRECTORIES = {
    ".git",
    ".hg",
    ".memory-data",
    ".project-graphrag-data",
    ".svn",
    ".venv",
    "__pycache__",
    "build",
    "dist",
    "node_modules",
    "site-packages",
    "venv",
}
DEFAULT_CONCURRENT_REQUESTS = 10


if TYPE_CHECKING:
    from graphrag.config.models.graph_rag_config import GraphRagConfig


BuildIndex = Callable[..., Awaitable[list]]
ModelAuthority = Callable[[], IndexingModel]
ProgressCallback = Callable[[dict[str, object]], None]


class StaleIndexingModel(RuntimeError):
    pass


class GraphRagWorkflowProgress:
    """Forward GraphRAG's real workflow and item counters to the job record."""

    def __init__(self, report: ProgressCallback) -> None:
        self.report = report
        self.workflow_names: list[str] = []
        self.completed_workflows = 0
        self.current_workflow: str | None = None

    def pipeline_start(self, names: list[str]) -> None:
        self.workflow_names = list(names)
        self.completed_workflows = 0
        self.report(self._payload(message="GraphRAG workflow pipeline started"))

    def workflow_start(self, name: str, instance: object) -> None:
        del instance
        self.current_workflow = name
        self.report(self._payload(message=f"Running workflow {name}"))

    def workflow_end(self, name: str, instance: object) -> None:
        del instance
        self.completed_workflows += 1
        self.current_workflow = name
        self.report(self._payload(message=f"Completed workflow {name}"))

    def progress(self, progress: Progress) -> None:
        payload = self._payload(message=progress.description or "GraphRAG operation in progress")
        if progress.description:
            payload["operation"] = progress.description.strip()
        if progress.completed_items is not None:
            payload["items_completed"] = progress.completed_items
        if progress.total_items is not None:
            payload["items_total"] = progress.total_items
        self.report(payload)

    def pipeline_end(self, results: list[PipelineRunResult]) -> None:
        self.completed_workflows = len(results)
        self.report(self._payload(message="GraphRAG workflow pipeline completed"))

    def pipeline_error(self, error: BaseException) -> None:
        self.report(self._payload(message=f"GraphRAG workflow failed: {error}"))

    def _payload(self, *, message: str) -> dict[str, object]:
        return {
            "phase": "graphrag_workflows",
            "workflow": self.current_workflow,
            "workflows_completed": self.completed_workflows,
            "workflows_total": len(self.workflow_names),
            "message": message,
        }


class ProjectGraphRagIndexer:
    """Build an atomic Microsoft GraphRAG index for one active code project."""

    def __init__(
        self,
        project_root: str | Path,
        data_root: str | Path,
        *,
        model_authority: ModelAuthority | None = None,
        build_index_fn: BuildIndex | None = None,
        require_model_calls: bool = True,
        progress_callback: ProgressCallback | None = None,
    ) -> None:
        self.project = identify_project(project_root)
        self.store = ProjectGraphStore(data_root, self.project)
        self.root = self.store.root / "graphrag"
        self.builds_root = self.root / "builds"
        self.manifest_path = self.root / "manifest.json"
        self.model_authority = model_authority or self._configured_model
        self.build_index_fn = build_index_fn
        self.require_model_calls = require_model_calls
        self.progress_callback = progress_callback

    async def build(self, *, build_id: str | None = None) -> dict:
        snapshot = load_background_model_config(self.project.root)
        if snapshot.state != "ready" or snapshot.model_reference is None:
            raise RuntimeError("backgroundAgentDefaultModel must be configured for GraphRAG indexing")
        model = self.model_authority()
        if (model.reference, model.revision) != (snapshot.model_reference, snapshot.revision):
            raise StaleIndexingModel("indexing model authority does not match backgroundAgentDefaultModel")

        self._report_progress(
            "static_graph",
            "Refreshing deterministic symbols, dependencies, and contracts",
        )
        synchronizer = GraphLeanSynchronizer(self.store, LeanVerifier())
        synchronizer.reconcile()
        static_index = ProjectIndexer(synchronizer).index_project(VerificationMode.SMOOTH)
        self._report_progress(
            "collecting_documents",
            "Collecting source documents for semantic indexing",
            objects_indexed=static_index.object_count,
        )
        documents = project_documents(self.project.root, self.store)
        if documents.empty:
            raise RuntimeError("current project has no indexable source documents")
        source_digest = _documents_digest(documents)
        identifier = build_id or uuid.uuid4().hex
        build_root = self.builds_root / identifier
        provider_type = f"project-graphrag-{os.getpid()}-{identifier}"
        calls = []
        if self.build_index_fn is None:
            from .graphrag_provider import register_project_indexing_provider

            register_project_indexing_provider(provider_type, self.model_authority, calls)
        config = project_graph_config(build_root, model, provider_type)
        build_index_fn = self.build_index_fn
        callbacks: list[GraphRagWorkflowProgress] | None = None
        if build_index_fn is None:
            os.environ.setdefault("LITELLM_LOCAL_MODEL_COST_MAP", "true")
            warnings.filterwarnings("ignore", message="Can't initialize NVML")
            import graphrag.index.workflows  # noqa: F401
            from graphrag.api.index import build_index
            from .runtime_cleanup import register_graphrag_runtime_cleanup
            from .sync_storage import register_synchronous_file_storage

            register_graphrag_runtime_cleanup()
            register_synchronous_file_storage()
            build_index_fn = build_index
            if self.progress_callback is not None:
                callbacks = [GraphRagWorkflowProgress(self.progress_callback)]
        self._report_progress(
            "graphrag_workflows",
            f"Extracting entities, relationships, and communities from {len(documents)} documents",
            documents_total=len(documents),
        )
        if callbacks is None:
            results = await build_index_fn(config=config, input_documents=documents)
        else:
            results = await build_index_fn(
                config=config,
                input_documents=documents,
                callbacks=callbacks,
            )
        failures = [result for result in results if getattr(result, "error", None)]
        if failures:
            failure = failures[0]
            raise RuntimeError(f"GraphRAG workflow {failure.workflow!r} failed") from failure.error

        current = load_background_model_config(self.project.root)
        if (current.model_reference, current.revision) != (snapshot.model_reference, snapshot.revision):
            raise StaleIndexingModel("backgroundAgentDefaultModel changed during GraphRAG indexing")
        if any(
            (call.reference, call.revision) != (snapshot.model_reference, snapshot.revision)
            for call in calls
        ):
            raise StaleIndexingModel("GraphRAG indexing crossed model revisions")
        if self.require_model_calls and not any(call.kind == "completion" for call in calls):
            raise RuntimeError("GraphRAG indexing completed without using backgroundAgentDefaultModel")

        self._report_progress(
            "validating_output",
            "Validating GraphRAG tables and model revision",
        )
        output = build_root / "output"
        required = (
            "entities.parquet",
            "relationships.parquet",
            "communities.parquet",
            "community_reports.parquet",
        )
        missing = [name for name in required if not (output / name).exists()]
        if missing:
            raise RuntimeError("GraphRAG output is incomplete: " + ", ".join(missing))
        current_project = identify_project(self.project.root)
        if current_project.worktree_revision != self.project.worktree_revision:
            raise StaleIndexingModel("project source changed during GraphRAG indexing")
        self._report_progress(
            "merging_graph",
            "Merging semantic entities and communities into the project graph",
        )
        merged = merge_graphrag_output(
            self.store,
            output,
            build_id=identifier,
            model_revision=snapshot.revision,
        )
        manifest = {
            "schema_version": 1,
            "project_id": self.project.id,
            "build_id": identifier,
            "model_reference": snapshot.model_reference,
            "model_revision": snapshot.revision,
            "worktree_revision": self.project.worktree_revision,
            "source_digest": source_digest,
            "document_count": len(documents),
            "static_graph_generation": static_index.generation,
            "completion_calls": sum(call.kind == "completion" for call in calls),
            "embedding_calls": sum(call.kind == "embedding" for call in calls),
            "output": str(output.relative_to(self.root)),
            "tables": {
                name.removesuffix(".parquet"): len(pd.read_parquet(output / name))
                for name in required
            },
            "merged_graph": merged,
        }
        self._report_progress(
            "activating_index",
            "Activating the completed GraphRAG index",
        )
        self._activate(manifest)
        return manifest

    def status(self) -> dict:
        config = load_background_model_config(self.project.root)
        if not self.manifest_path.exists():
            return {
                "state": "absent",
                "background_model": {
                    "state": config.state,
                    "reference": config.model_reference,
                    "revision": config.revision,
                },
            }
        manifest = json.loads(self.manifest_path.read_text(encoding="utf-8"))
        output = self.root / manifest["output"]
        current_project = identify_project(self.project.root)
        state = "ready"
        if manifest.get("model_revision") != config.revision:
            state = "stale_model"
        elif manifest.get("worktree_revision") != current_project.worktree_revision:
            state = "stale_source"
        elif not output.exists():
            state = "missing_output"
        return {"state": state, **manifest}

    def _configured_model(self) -> IndexingModel:
        return PiIndexingModel(load_background_model_config(self.project.root))

    def _activate(self, manifest: dict) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        temporary = self.root / f".manifest.{os.getpid()}.tmp"
        temporary.write_text(
            json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2),
            encoding="utf-8",
        )
        temporary.replace(self.manifest_path)

    def _report_progress(self, phase: str, message: str, **counts: int) -> None:
        if self.progress_callback is None:
            return
        self.progress_callback(
            {
                "phase": phase,
                "message": message,
                **counts,
            }
        )


def project_graph_config(
    root: Path,
    model: IndexingModel,
    provider_type: str,
) -> "GraphRagConfig":
    from graphrag.config.models.graph_rag_config import GraphRagConfig
    from graphrag_llm.config import ModelConfig
    extraction = ModelConfig(
        type=provider_type,
        model_provider="pi-background-agent",
        model=model.reference,
        metrics=None,
        purpose="graph_extraction",
    )
    community = ModelConfig(
        type=provider_type,
        model_provider="pi-background-agent",
        model=model.reference,
        metrics=None,
        purpose="community_report",
    )
    embedding = ModelConfig(
        type=provider_type,
        model_provider="local-feature-hash",
        model=f"feature-hash:{model.embedding_dimensions}",
        metrics=None,
        purpose="embedding",
    )
    configured_concurrency = os.environ.get("PROJECT_GRAPHRAG_CONCURRENT_REQUESTS")
    try:
        concurrent_requests = (
            int(configured_concurrency)
            if configured_concurrency is not None
            else DEFAULT_CONCURRENT_REQUESTS
        )
    except ValueError as error:
        raise ValueError(
            "PROJECT_GRAPHRAG_CONCURRENT_REQUESTS must be a positive integer"
        ) from error
    if concurrent_requests < 1:
        raise ValueError("PROJECT_GRAPHRAG_CONCURRENT_REQUESTS must be a positive integer")
    return GraphRagConfig(
        completion_models={
            "default_completion_model": extraction,
            "community_completion_model": community,
        },
        embedding_models={"default_embedding_model": embedding},
        async_mode="asyncio",
        concurrent_requests=concurrent_requests,
        input_storage={"type": "project_sync_file", "base_dir": str(root / "input")},
        output_storage={"type": "project_sync_file", "base_dir": str(root / "output")},
        update_output_storage={"type": "project_sync_file", "base_dir": str(root / "update_output")},
        cache={"type": "none"},
        reporting={"type": "file", "base_dir": str(root / "logs")},
        vector_store={
            "type": "lancedb",
            "db_uri": str(root / "lancedb"),
            "vector_size": model.embedding_dimensions,
        },
        chunking={
            "type": "tokens",
            "size": 4096,
            "overlap": 256,
            "encoding_model": "o200k_base",
            "prepend_metadata": ["path", "language"],
        },
        extract_graph={
            "entity_types": [
                "file",
                "module",
                "function",
                "class",
                "interface",
                "contract",
                "library",
                "package",
                "configuration",
                "requirement",
                "error",
                "test",
            ],
            "max_gleanings": 1,
        },
        community_reports={
            "completion_model_id": "community_completion_model",
            "max_length": 1800,
            "max_input_length": 10000,
        },
        cluster_graph={"use_lcc": False},
        workflows=[
            "create_base_text_units",
            "create_final_documents",
            "extract_graph",
            "finalize_graph",
            "create_communities",
            "create_community_reports",
            "create_final_text_units",
        ],
    )


def project_documents(project_root: Path, store: ProjectGraphStore) -> pd.DataFrame:
    symbols_by_path: dict[str, list[str]] = defaultdict(list)
    for item in store.objects().values():
        if item.kind in {"community", "semantic-contract"}:
            continue
        contract = f" contract={item.contract.behavior}" if item.contract is not None else ""
        symbols_by_path[item.source.path].append(
            f"{item.kind} {item.qualified_name}{contract}"
        )

    rows: list[dict[str, object]] = []
    maximum_size = 256 * 1024
    for directory, names, files in os.walk(project_root):
        names[:] = sorted(
            name for name in names if name not in EXCLUDED_DIRECTORIES and not name.endswith("-venv")
        )
        base = Path(directory)
        for name in sorted(files):
            path = base / name
            if path.suffix.casefold() not in SOURCE_EXTENSIONS:
                continue
            try:
                if path.stat().st_size > maximum_size:
                    continue
                content = path.read_text(encoding="utf-8")
            except (OSError, UnicodeError):
                continue
            relative = path.relative_to(project_root).as_posix()
            known = symbols_by_path.get(relative, [])
            ground_truth = "\n".join(known[:200])
            text = (
                f"PROJECT PATH: {relative}\n"
                f"STATIC SYMBOLS AND CONTRACTS:\n{ground_truth or '(none extracted)'}\n"
                "SOURCE CONTENT:\n"
                f"{content}"
            )
            rows.append(
                {
                    "id": hashlib.sha256(relative.encode("utf-8")).hexdigest(),
                    "human_readable_id": len(rows),
                    "title": relative,
                    "text": text,
                    "creation_date": None,
                    "raw_data": {
                        "path": relative,
                        "language": path.suffix.lstrip(".").casefold(),
                    },
                }
            )
    return pd.DataFrame(rows)


def _documents_digest(documents: pd.DataFrame) -> str:
    digest = hashlib.sha256()
    for row in documents.sort_values("id").itertuples():
        digest.update(str(row.id).encode("utf-8"))
        digest.update(b"\0")
        digest.update(str(row.text).encode("utf-8"))
        digest.update(b"\0")
    return digest.hexdigest()
