from __future__ import annotations

from collections import Counter
from dataclasses import dataclass

import pandas as pd
from graphrag.index.operations.cluster_graph import cluster_graph

from .domain import GraphEdge, ProjectIdentity, SemanticObject, SourceSpan, stable_id


@dataclass(frozen=True)
class CommunitySlice:
    objects: tuple[SemanticObject, ...]
    edges: tuple[GraphEdge, ...]


def build_hierarchical_communities(
    project: ProjectIdentity,
    objects: list[SemanticObject],
    edges: list[GraphEdge],
    *,
    max_cluster_size: int = 64,
) -> CommunitySlice:
    """Build deterministic hierarchical Leiden community nodes from graph edges."""

    object_by_id = {item.id: item for item in objects}
    relationships = [
        {
            "source": edge.source_id,
            "target": edge.target_id,
            "weight": max(0.001, edge.confidence),
        }
        for edge in edges
        if edge.source_id != edge.target_id
        and edge.source_id in object_by_id
        and edge.target_id in object_by_id
    ]
    if not relationships:
        return CommunitySlice((), ())

    clusters = cluster_graph(
        pd.DataFrame(relationships),
        max_cluster_size=max_cluster_size,
        use_lcc=False,
        seed=0,
    )
    community_objects: list[SemanticObject] = []
    community_edges: list[GraphEdge] = []
    cluster_objects: dict[int, SemanticObject] = {}
    parents: dict[int, int] = {}

    for level, cluster_id, parent_id, member_ids in sorted(clusters):
        members = [object_by_id[item_id] for item_id in sorted(member_ids) if item_id in object_by_id]
        if not members:
            continue
        member_names = [item.qualified_name for item in members]
        community_id = stable_id(
            "community",
            project.id,
            str(level),
            *(item.id for item in members),
        )
        tags = _community_tags(members)
        summary = _community_summary(member_names)
        community = SemanticObject(
            id=community_id,
            project_id=project.id,
            kind="community",
            qualified_name=f"community:level-{level}:cluster-{cluster_id}",
            source=SourceSpan(".project-graphrag/community", 1, 1),
            source_hash=stable_id("community-source", community_id, summary, *tags),
            contract=None,
            extractor="hierarchical-leiden-v1",
            confidence=1.0,
            summary=summary,
            semantic_tags=tags,
        )
        community_objects.append(community)
        cluster_objects[cluster_id] = community
        parents[cluster_id] = parent_id
        for member in members:
            community_edges.append(
                GraphEdge(
                    id=stable_id("edge", member.id, "MEMBER_OF_COMMUNITY", community.id),
                    project_id=project.id,
                    source_id=member.id,
                    target_id=community.id,
                    relation="MEMBER_OF_COMMUNITY",
                    source_type="hierarchical-leiden-v1",
                    confidence=1.0,
                    properties=(("level", str(level)), ("cluster", str(cluster_id))),
                )
            )

    for cluster_id, parent_id in sorted(parents.items()):
        child = cluster_objects.get(cluster_id)
        parent = cluster_objects.get(parent_id)
        if child is None or parent is None:
            continue
        community_edges.append(
            GraphEdge(
                id=stable_id("edge", child.id, "PARENT_COMMUNITY", parent.id),
                project_id=project.id,
                source_id=child.id,
                target_id=parent.id,
                relation="PARENT_COMMUNITY",
                source_type="hierarchical-leiden-v1",
                confidence=1.0,
            )
        )

    return CommunitySlice(tuple(community_objects), tuple(community_edges))


def _community_summary(names: list[str]) -> str:
    shown = sorted(names, key=str.casefold)[:24]
    suffix = f"; {len(names) - len(shown)} more" if len(names) > len(shown) else ""
    return "Related project objects: " + ", ".join(shown) + suffix


def _community_tags(members: list[SemanticObject]) -> tuple[str, ...]:
    counts: Counter[str] = Counter()
    for member in members:
        counts[member.kind] += 1
        for value in (member.qualified_name, member.summary, *member.semantic_tags):
            counts.update(_terms(value))
    return tuple(
        term
        for term, _ in sorted(counts.items(), key=lambda item: (-item[1], item[0]))
        if len(term) > 1
    )[:32]


def _terms(value: str) -> list[str]:
    terms: list[str] = []
    current: list[str] = []
    previous_lower = False
    for character in value:
        if character.isalnum():
            if character.isupper() and previous_lower and current:
                terms.append("".join(current).casefold())
                current = []
            current.append(character)
            previous_lower = character.islower()
        else:
            if current:
                terms.append("".join(current).casefold())
                current = []
            previous_lower = False
    if current:
        terms.append("".join(current).casefold())
    return terms
