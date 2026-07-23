from __future__ import annotations

import json
import os
from dataclasses import dataclass
from importlib import metadata
from pathlib import Path

from .domain import GraphEdge, ProjectIdentity, SemanticObject, SourceSpan, stable_id


EXCLUDED = {
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
class PackageGraphSlice:
    objects: tuple[SemanticObject, ...]
    edges: tuple[GraphEdge, ...]


class PackageSemanticExtractor:
    version = "package-capability-v1"

    def extract_project(self, project: ProjectIdentity) -> PackageGraphSlice:
        objects: dict[str, SemanticObject] = {}
        edges: dict[str, GraphEdge] = {}
        for path in _manifest_files(project.root):
            if path.name == "package.json":
                self._npm_manifest(project, path, objects, edges)
            elif path.name == "requirements.txt":
                self._requirements(project, path, objects, edges)
        return PackageGraphSlice(tuple(objects.values()), tuple(edges.values()))

    def _npm_manifest(
        self,
        project: ProjectIdentity,
        path: Path,
        objects: dict[str, SemanticObject],
        edges: dict[str, GraphEdge],
    ) -> None:
        value = json.loads(path.read_text(encoding="utf-8"))
        relative = str(path.relative_to(project.root))
        package_name = str(value.get("name") or path.parent.name)
        package = _object(
            project,
            "package",
            f"npm:{package_name}",
            relative,
            str(value.get("description") or ""),
            ("npm", "package", package_name),
            self.version,
        )
        objects[package.id] = package
        dependency_groups = (
            ("runtime", value.get("dependencies", {})),
            ("development", value.get("devDependencies", {})),
            ("peer", value.get("peerDependencies", {})),
            ("optional", value.get("optionalDependencies", {})),
        )
        for scope, dependencies in dependency_groups:
            if not isinstance(dependencies, dict):
                continue
            for name, requested in sorted(dependencies.items()):
                installed = _installed_npm_metadata(path.parent, name)
                summary = str(installed.get("description") or "")
                keywords = installed.get("keywords", [])
                if isinstance(keywords, str):
                    keywords = [keywords]
                library = _object(
                    project,
                    "library",
                    f"npm:{name}",
                    relative,
                    summary,
                    tuple(["npm", "library", name, *map(str, keywords)]),
                    self.version,
                )
                objects[library.id] = library
                edge = GraphEdge(
                    id=stable_id("edge", package.id, "DECLARES_DEPENDENCY", library.id, scope),
                    project_id=project.id,
                    source_id=package.id,
                    target_id=library.id,
                    relation="DECLARES_DEPENDENCY",
                    source_type=self.version,
                    confidence=1.0,
                    properties=(
                        ("ecosystem", "npm"),
                        ("requested", str(requested)),
                        ("scope", scope),
                        ("manifest", relative),
                        ("installed", str(installed.get("version") or "")),
                    ),
                )
                edges[edge.id] = edge

    def _requirements(
        self,
        project: ProjectIdentity,
        path: Path,
        objects: dict[str, SemanticObject],
        edges: dict[str, GraphEdge],
    ) -> None:
        relative = str(path.relative_to(project.root))
        package = _object(
            project,
            "package",
            f"python:{path.parent.name}",
            relative,
            "Python package requirements",
            ("python", "package", path.parent.name),
            self.version,
        )
        objects[package.id] = package
        for line in path.read_text(encoding="utf-8").splitlines():
            requirement = line.strip()
            if not requirement or requirement.startswith("#") or requirement.startswith("-"):
                continue
            name = _requirement_name(requirement)
            try:
                installed = metadata.metadata(name)
                summary = installed.get("Summary", "")
                version = metadata.version(name)
            except metadata.PackageNotFoundError:
                summary = ""
                version = ""
            library = _object(
                project,
                "library",
                f"python:{name}",
                relative,
                summary,
                ("python", "library", name),
                self.version,
            )
            objects[library.id] = library
            edge = GraphEdge(
                id=stable_id("edge", package.id, "DECLARES_DEPENDENCY", library.id),
                project_id=project.id,
                source_id=package.id,
                target_id=library.id,
                relation="DECLARES_DEPENDENCY",
                source_type=self.version,
                confidence=1.0,
                properties=(
                    ("ecosystem", "python"),
                    ("requested", requirement),
                    ("scope", "runtime"),
                    ("manifest", relative),
                    ("installed", version),
                ),
            )
            edges[edge.id] = edge


def _manifest_files(root: Path):
    for directory, names, files in os.walk(root):
        names[:] = sorted(
            name
            for name in names
            if name not in EXCLUDED and not name.endswith("-venv")
        )
        base = Path(directory)
        for name in sorted(files):
            if name in {"package.json", "requirements.txt"}:
                yield base / name


def _object(
    project: ProjectIdentity,
    kind: str,
    qualified_name: str,
    manifest: str,
    summary: str,
    tags: tuple[str, ...],
    extractor: str,
) -> SemanticObject:
    return SemanticObject(
        id=stable_id(
            "object",
            project.id,
            kind,
            qualified_name,
            manifest if kind == "package" else "canonical",
        ),
        project_id=project.id,
        kind=kind,
        qualified_name=qualified_name,
        source=SourceSpan(manifest, 1, 1),
        source_hash=stable_id("manifest-object", qualified_name, summary, *tags),
        contract=None,
        extractor=extractor,
        confidence=1.0,
        summary=summary,
        semantic_tags=tags,
    )


def _installed_npm_metadata(start: Path, package_name: str) -> dict:
    relative = Path(*package_name.split("/")) / "package.json"
    for parent in (start, *start.parents):
        candidate = parent / "node_modules" / relative
        if candidate.exists():
            try:
                return json.loads(candidate.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                return {}
    return {}


def _requirement_name(requirement: str) -> str:
    stop = len(requirement)
    for marker in "<>=!~[; ":
        position = requirement.find(marker)
        if position >= 0:
            stop = min(stop, position)
    return requirement[:stop]
