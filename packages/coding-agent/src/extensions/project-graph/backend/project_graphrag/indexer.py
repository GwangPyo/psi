from __future__ import annotations

import os
import subprocess
from dataclasses import dataclass
from pathlib import Path

from .community import build_hierarchical_communities
from .domain import GraphEdge, SemanticObject, SourceSpan, VerificationMode, stable_id
from .package_semantic import PackageSemanticExtractor
from .python_semantic import PythonSemanticExtractor
from .synchronizer import GraphLeanSynchronizer
from .typescript_semantic import TypeScriptSemanticExtractor, TypeScriptUnavailable


EXCLUDED_DIRECTORIES = {
    ".git",
    ".hg",
    ".svn",
    ".venv",
    ".memory-data",
    ".project-graphrag-data",
    "node_modules",
    "site-packages",
    "venv",
    "dist",
    "build",
    "__pycache__",
}


@dataclass(frozen=True)
class IndexResult:
    generation: int
    object_count: int
    pending_verifications: int
    errors: tuple[str, ...]


class ProjectIndexer:
    def __init__(self, synchronizer: GraphLeanSynchronizer) -> None:
        self.synchronizer = synchronizer
        self.python = PythonSemanticExtractor()
        self.typescript = TypeScriptSemanticExtractor()
        self.packages = PackageSemanticExtractor()

    def index_project(self, mode: VerificationMode) -> IndexResult:
        project = self.synchronizer.store.project
        objects: list[SemanticObject] = []
        errors: list[str] = []
        for path in _python_files(project.root):
            try:
                objects.extend(self.python.extract_file(project, path))
            except (OSError, SyntaxError, UnicodeError) as error:
                errors.append(f"{path}: {error}")
        try:
            typescript_objects = self.typescript.extract_project(project)
        except TypeScriptUnavailable:
            typescript_objects = []
        except (OSError, subprocess.SubprocessError, ValueError, RuntimeError) as error:
            typescript_objects = []
            errors.append(f"TypeScript extraction: {error}")
        objects.extend(typescript_objects)
        package_slice = self.packages.extract_project(project)
        objects.extend(package_slice.objects)
        edges = list(package_slice.edges)
        contract_objects: dict[str, SemanticObject] = {}
        for item in objects:
            if item.contract is None or not item.kind.endswith("-function"):
                continue
            contract_id = stable_id("object", project.id, "semantic-contract", item.contract.hash)
            contract_objects.setdefault(
                contract_id,
                SemanticObject(
                    id=contract_id,
                    project_id=project.id,
                    kind="semantic-contract",
                    qualified_name=f"contract:{item.contract.hash}",
                    source=SourceSpan(item.source.path, item.source.start_line, item.source.end_line),
                    source_hash=item.contract.hash,
                    contract=item.contract,
                    extractor="semantic-contract-node-v1",
                    confidence=item.confidence,
                    summary=item.contract.behavior,
                    semantic_tags=(
                        *item.contract.input_kinds,
                        item.contract.output_kind,
                        item.contract.effect.value,
                    ),
                ),
            )
            edges.append(
                GraphEdge(
                    id=stable_id("edge", item.id, "IMPLEMENTS_CONTRACT", contract_id),
                    project_id=project.id,
                    source_id=item.id,
                    target_id=contract_id,
                    relation="IMPLEMENTS_CONTRACT",
                    source_type="semantic-contract-node-v1",
                    confidence=item.confidence,
                )
            )
        objects.extend(contract_objects.values())
        community_slice = build_hierarchical_communities(project, objects, edges)
        objects.extend(community_slice.objects)
        edges.extend(community_slice.edges)
        generation = self.synchronizer.replace_objects(
            objects,
            kind_prefixes=(
                "python-",
                "typescript-",
                "package",
                "library",
                "semantic-contract",
                "community",
            ),
            edges=edges,
            edge_source_types=(
                "package-capability-",
                "semantic-contract-node-",
                "hierarchical-leiden-",
            ),
        )
        jobs = self.synchronizer.enqueue_exact_contract_candidates(mode)
        pending_jobs = [job for job in jobs if job.status == "pending"]
        return IndexResult(generation, len(objects), len(pending_jobs), tuple(errors))


def _python_files(root: Path):
    for directory, names, files in os.walk(root):
        names[:] = sorted(
            name
            for name in names
            if name not in EXCLUDED_DIRECTORIES and not name.endswith("-venv")
        )
        base = Path(directory)
        for name in sorted(files):
            if name.endswith(".py"):
                yield base / name
