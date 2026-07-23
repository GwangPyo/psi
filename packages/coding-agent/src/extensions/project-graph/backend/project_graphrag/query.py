from __future__ import annotations

from dataclasses import dataclass

from .domain import GraphEdge, SemanticObject, VerificationStatus, stable_id
from .store import ProjectGraphStore


@dataclass(frozen=True)
class RankedObject:
    object: SemanticObject
    score: float
    reasons: tuple[str, ...]


@dataclass(frozen=True)
class ProjectGraphContext:
    query: str
    entry_nodes: tuple[RankedObject, ...]
    objects: tuple[SemanticObject, ...]
    edges: tuple[GraphEdge, ...]


class ProjectGraphQuery:
    """Hybrid lexical/contract entry search followed by cycle-safe graph traversal."""

    def __init__(self, store: ProjectGraphStore) -> None:
        self.store = store

    def search(
        self,
        query: str,
        *,
        max_entry_nodes: int = 8,
        max_hops: int = 2,
        max_objects: int = 64,
    ) -> ProjectGraphContext:
        if max_hops < 0 or max_hops > 4:
            raise ValueError("max_hops must be between 0 and 4")
        state = self.store.snapshot()
        objects = self.store.objects(state)
        edges = self._all_edges(state)
        ranked = sorted(
            (
                result
                for item in objects.values()
                if (result := _rank(query, item)).score > 0
            ),
            key=lambda result: (-result.score, result.object.id),
        )[:max_entry_nodes]

        selected_objects, selected_edges = self._traverse(
            objects,
            edges,
            [entry.object.id for entry in ranked],
            max_hops,
            max_objects,
        )
        return ProjectGraphContext(
            query=query,
            entry_nodes=tuple(ranked),
            objects=selected_objects,
            edges=selected_edges,
        )

    def neighbors(self, object_id: str, *, max_hops: int = 1) -> ProjectGraphContext:
        state = self.store.snapshot()
        objects = self.store.objects(state)
        item = objects[object_id]
        selected_objects, selected_edges = self._traverse(
            objects,
            self._all_edges(state),
            [object_id],
            max_hops,
            64,
        )
        return ProjectGraphContext(
            query=f"neighbors:{object_id}",
            entry_nodes=(RankedObject(item, 1.0, ("exact object ID",)),),
            objects=selected_objects,
            edges=selected_edges,
        )

    @staticmethod
    def _traverse(
        objects: dict[str, SemanticObject],
        edges: dict[str, GraphEdge],
        entry_ids: list[str],
        max_hops: int,
        max_objects: int,
    ) -> tuple[tuple[SemanticObject, ...], tuple[GraphEdge, ...]]:

        adjacency: dict[str, list[GraphEdge]] = {}
        for edge in edges.values():
            adjacency.setdefault(edge.source_id, []).append(edge)
            adjacency.setdefault(edge.target_id, []).append(edge)

        visited: set[str] = set()
        selected_edges: dict[str, GraphEdge] = {}
        frontier = [(item_id, 0) for item_id in entry_ids]
        while frontier and len(visited) < max_objects:
            object_id, depth = frontier.pop(0)
            if object_id in visited:
                continue
            visited.add(object_id)
            if depth >= max_hops:
                continue
            for edge in adjacency.get(object_id, []):
                selected_edges[edge.id] = edge
                neighbor = edge.target_id if edge.source_id == object_id else edge.source_id
                if neighbor not in visited:
                    frontier.append((neighbor, depth + 1))

        return tuple(
            objects[item_id]
            for item_id in sorted(visited)
            if item_id in objects
        ), tuple(selected_edges[item_id] for item_id in sorted(selected_edges))

    def _all_edges(self, state: dict) -> dict[str, GraphEdge]:
        edges = self.store.edges(state)
        for candidate in self.store.candidates(state).values():
            edge = GraphEdge(
                id=stable_id("edge", "candidate", candidate.id),
                project_id=candidate.project_id,
                source_id=candidate.left_object_id,
                target_id=candidate.right_object_id,
                relation=(
                    "CONFIRMED_EQUIVALENT_CANDIDATE"
                    if candidate.status.value == "confirmed"
                    else "POSSIBLY_EQUIVALENT"
                ),
                source_type="semantic-candidate",
                confidence=candidate.semantic_score,
                properties=(
                    ("candidate_id", candidate.id),
                    ("status", candidate.status.value),
                    ("model_revision", candidate.model_revision),
                ),
            )
            edges[edge.id] = edge
        for certificate in self.store.certificates(state).values():
            relation = (
                "PROVEN_EQUIVALENT"
                if certificate.status is VerificationStatus.VERIFIED
                else "UNVERIFIED_EQUIVALENCE"
            )
            edge = GraphEdge(
                id=stable_id("edge", "certificate", certificate.id),
                project_id=certificate.project_id,
                source_id=certificate.left_object_id,
                target_id=certificate.right_object_id,
                relation=relation,
                source_type="lean-certificate",
                confidence=1.0 if certificate.status is VerificationStatus.VERIFIED else 0.0,
                properties=(
                    ("certificate_id", certificate.id),
                    ("status", certificate.status.value),
                    ("lean_version", certificate.lean_version),
                ),
            )
            edges[edge.id] = edge
        return edges


def _rank(query: str, item: SemanticObject) -> RankedObject:
    terms = set(_terms(query))
    name_terms = set(_terms(item.qualified_name))
    summary_terms = set(_terms(item.summary))
    tag_terms = {term for tag in item.semantic_tags for term in _terms(tag)}
    contract_terms: set[str] = set()
    if item.contract is not None:
        contract_terms.update(_terms(item.contract.behavior))
        contract_terms.update(_terms(item.contract.output_kind))
        for value in (*item.contract.input_kinds, *item.contract.failure_modes):
            contract_terms.update(_terms(value))

    reasons: list[str] = []
    score = 0.0
    for label, values, weight in (
        ("name", name_terms, 4.0),
        ("contract", contract_terms, 3.0),
        ("capability", tag_terms, 2.5),
        ("summary", summary_terms, 2.0),
    ):
        overlap = terms & values
        if overlap:
            score += len(overlap) * weight
            reasons.append(f"{label}: {', '.join(sorted(overlap))}")
    folded_query = query.casefold().strip()
    if folded_query and folded_query in item.qualified_name.casefold():
        score += 6.0
        reasons.append("qualified-name substring")
    return RankedObject(item, score, tuple(reasons))


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
            continue
        if current:
            terms.append("".join(current).casefold())
            current = []
        previous_lower = False
    if current:
        terms.append("".join(current).casefold())
    return [term for term in terms if term]
