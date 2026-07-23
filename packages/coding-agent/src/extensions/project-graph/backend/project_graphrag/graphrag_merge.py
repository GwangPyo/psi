from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pandas as pd

from .domain import GraphEdge, SemanticObject, SourceSpan, stable_id
from .lean_verifier import LeanVerifier
from .store import ProjectGraphStore
from .synchronizer import GraphLeanSynchronizer


def merge_graphrag_output(
    store: ProjectGraphStore,
    output: Path,
    *,
    build_id: str,
    model_revision: str,
) -> dict:
    """Replace the active LLM-derived graph slice from GraphRAG parquet tables."""

    entities = pd.read_parquet(output / "entities.parquet")
    relationships = pd.read_parquet(output / "relationships.parquet")
    communities = pd.read_parquet(output / "communities.parquet")
    reports = pd.read_parquet(output / "community_reports.parquet")
    project = store.project
    objects: list[SemanticObject] = []
    edges: list[GraphEdge] = []
    entity_ids: dict[str, str] = {}

    for _, row in entities.iterrows():
        raw_id = _text(row, "id") or stable_id("raw-entity", _text(row, "title"))
        title = _text(row, "title") or raw_id
        object_id = stable_id("object", project.id, "graphrag-entity", raw_id)
        entity_ids[raw_id] = object_id
        entity_ids[title.casefold()] = object_id
        entity_type = _text(row, "type") or "entity"
        description = _text(row, "description")
        objects.append(
            SemanticObject(
                id=object_id,
                project_id=project.id,
                kind="graphrag-entity",
                qualified_name=title,
                source=SourceSpan(".project-graphrag/llm/entities", 1, 1),
                source_hash=_row_hash(row),
                contract=None,
                extractor="backgroundAgentDefaultModel:graphrag-v1",
                confidence=1.0,
                summary=description[:8000],
                semantic_tags=(entity_type, "llm-indexed", "graphrag"),
            )
        )

    common_properties = (("build_id", build_id), ("model_revision", model_revision))
    for _, row in relationships.iterrows():
        source_raw = _text(row, "source")
        target_raw = _text(row, "target")
        source_id = entity_ids.get(source_raw) or entity_ids.get(source_raw.casefold())
        target_id = entity_ids.get(target_raw) or entity_ids.get(target_raw.casefold())
        if source_id is None or target_id is None:
            continue
        description = _text(row, "description")
        weight = _number(row, "weight", 1.0)
        edges.append(
            GraphEdge(
                id=stable_id(
                    "edge",
                    project.id,
                    "graphrag-relationship",
                    source_id,
                    target_id,
                    description,
                ),
                project_id=project.id,
                source_id=source_id,
                target_id=target_id,
                relation="SEMANTIC_RELATION",
                source_type="graphrag-index-v1",
                confidence=min(1.0, max(0.0, weight / max(1.0, weight))),
                properties=(*common_properties, ("description", description[:2000])),
            )
        )

    report_ids: dict[str, str] = {}
    for _, row in reports.iterrows():
        community_key = _text(row, "community") or _text(row, "id")
        report_id = stable_id("object", project.id, "graphrag-community", community_key)
        report_ids[community_key] = report_id
        title = _text(row, "title") or f"GraphRAG community {community_key}"
        summary = _text(row, "full_content") or _text(row, "summary")
        level = _text(row, "level") or "0"
        objects.append(
            SemanticObject(
                id=report_id,
                project_id=project.id,
                kind="graphrag-community",
                qualified_name=title,
                source=SourceSpan(".project-graphrag/llm/community-reports", 1, 1),
                source_hash=_row_hash(row),
                contract=None,
                extractor="backgroundAgentDefaultModel:community-report-v1",
                confidence=1.0,
                summary=summary[:12000],
                semantic_tags=("community-report", f"level-{level}", "llm-indexed"),
            )
        )

    community_rows = {
        _text(row, "community") or _text(row, "id"): row
        for _, row in communities.iterrows()
    }
    for community_key, row in community_rows.items():
        report_id = report_ids.get(community_key)
        if report_id is None:
            continue
        for raw_entity_id in _string_list(row.get("entity_ids")):
            entity_id = entity_ids.get(raw_entity_id) or entity_ids.get(raw_entity_id.casefold())
            if entity_id is None:
                continue
            edges.append(
                GraphEdge(
                    id=stable_id("edge", entity_id, "MEMBER_OF_LLM_COMMUNITY", report_id),
                    project_id=project.id,
                    source_id=entity_id,
                    target_id=report_id,
                    relation="MEMBER_OF_LLM_COMMUNITY",
                    source_type="graphrag-index-v1",
                    confidence=1.0,
                    properties=common_properties,
                )
            )
        parent_key = _text(row, "parent")
        parent_id = report_ids.get(parent_key)
        if parent_id is not None and parent_id != report_id:
            edges.append(
                GraphEdge(
                    id=stable_id("edge", report_id, "PARENT_LLM_COMMUNITY", parent_id),
                    project_id=project.id,
                    source_id=report_id,
                    target_id=parent_id,
                    relation="PARENT_LLM_COMMUNITY",
                    source_type="graphrag-index-v1",
                    confidence=1.0,
                    properties=common_properties,
                )
            )

    static_objects = store.objects()
    exact_names: dict[str, list[SemanticObject]] = {}
    for item in static_objects.values():
        if item.kind.startswith("graphrag-") or item.kind == "community":
            continue
        exact_names.setdefault(item.qualified_name.casefold(), []).append(item)
    for entity in objects:
        if entity.kind != "graphrag-entity":
            continue
        for target in exact_names.get(entity.qualified_name.casefold(), []):
            edges.append(
                GraphEdge(
                    id=stable_id("edge", entity.id, "REPRESENTS_PROJECT_OBJECT", target.id),
                    project_id=project.id,
                    source_id=entity.id,
                    target_id=target.id,
                    relation="REPRESENTS_PROJECT_OBJECT",
                    source_type="graphrag-index-v1",
                    confidence=1.0,
                    properties=common_properties,
                )
            )

    generation = GraphLeanSynchronizer(store, LeanVerifier()).replace_objects(
        objects,
        kind_prefixes=("graphrag-",),
        edges=edges,
        edge_source_types=("graphrag-index-",),
    )
    return {"generation": generation, "objects": len(objects), "edges": len(edges)}


def _text(row: pd.Series, name: str) -> str:
    value = row.get(name)
    if value is None or _is_missing(value):
        return ""
    return str(value)


def _number(row: pd.Series, name: str, default: float) -> float:
    value = row.get(name)
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _string_list(value: object) -> list[str]:
    if value is None or _is_missing(value):
        return []
    if isinstance(value, (list, tuple)):
        return [str(item) for item in value]
    if hasattr(value, "tolist"):
        result = value.tolist()
        return [str(item) for item in result] if isinstance(result, list) else []
    return []


def _is_missing(value: object) -> bool:
    try:
        result = pd.isna(value)
    except (TypeError, ValueError):
        return False
    return bool(result) if isinstance(result, bool) else False


def _row_hash(row: pd.Series) -> str:
    value = {name: _json_value(item) for name, item in row.items()}
    return hashlib.sha256(
        json.dumps(value, ensure_ascii=False, sort_keys=True, default=str).encode("utf-8")
    ).hexdigest()


def _json_value(value: object) -> object:
    if hasattr(value, "tolist"):
        return value.tolist()
    return value
