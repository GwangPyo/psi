from __future__ import annotations

from dataclasses import replace

from .domain import ReliabilityCertificate, VerificationMode, VerificationStatus


class CertificateDependencyError(RuntimeError):
    pass


class CertificateRegistry:
    """Maintain the proof-dependency DAG used by accepted certificates."""

    def __init__(self) -> None:
        self.certificates: dict[str, ReliabilityCertificate] = {}

    def register(
        self,
        certificate: ReliabilityCertificate,
    ) -> ReliabilityCertificate:
        graph = {
            item_id: item.dependencies
            for item_id, item in self.certificates.items()
        }
        graph[certificate.id] = certificate.dependencies
        cycle = _cycle_containing(certificate.id, graph)
        if cycle is None:
            self.certificates[certificate.id] = certificate
            return certificate

        path = " -> ".join(cycle)
        if certificate.mode is VerificationMode.STRICT:
            raise CertificateDependencyError(
                f"circular certificate reasoning is forbidden: {path}"
            )
        cycle_ids = set(cycle)
        for item_id in cycle_ids:
            existing = certificate if item_id == certificate.id else self.certificates.get(item_id)
            if existing is None:
                continue
            self.certificates[item_id] = replace(
                existing,
                status=VerificationStatus.UNKNOWN,
                proof_hash=None,
                reason=f"circular certificate reasoning: {path}",
            )
        downgraded = self.certificates[certificate.id]
        self.certificates[downgraded.id] = downgraded
        return downgraded


def _cycle_containing(
    root: str,
    graph: dict[str, tuple[str, ...]],
) -> tuple[str, ...] | None:
    path: list[str] = []
    positions: dict[str, int] = {}
    visited: set[str] = set()

    def visit(node: str) -> tuple[str, ...] | None:
        if node in positions:
            start = positions[node]
            cycle = tuple([*path[start:], node])
            return cycle if root in cycle else None
        if node in visited:
            return None
        visited.add(node)
        positions[node] = len(path)
        path.append(node)
        for dependency in graph.get(node, ()):
            cycle = visit(dependency)
            if cycle is not None:
                return cycle
        path.pop()
        positions.pop(node, None)
        return None

    return visit(root)
