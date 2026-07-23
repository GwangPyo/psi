from __future__ import annotations

import asyncio
import os
from pathlib import Path

from mcp.server.fastmcp import FastMCP

from .domain import VerificationMode
from .service import ProjectGraphService
from .stdio_protocol import StdioServerDefinition, run_stdio_server


INSTRUCTIONS = (
    "Semantic graph for the active code project. Search existing implementations and "
    "declared libraries before creating new abstractions. Treat Lean certificates as "
    "verified object-level claims and unknown results as non-authoritative. Semantic "
    "candidate model revisions must match project_graph_status.background_model.revision."
)
project_root = Path(os.environ.get("PROJECT_GRAPHRAG_PROJECT_ROOT", Path.cwd()))
data_root = Path(
    os.environ.get(
        "PROJECT_GRAPHRAG_DATA_ROOT",
        project_root / ".project-graphrag-data",
    )
)
service = ProjectGraphService(project_root, data_root)
mcp = FastMCP(
    "project-graph",
    instructions=INSTRUCTIONS,
)


@mcp.tool()
def project_graph_status() -> dict:
    """Return project graph generation, object, edge and certificate counts."""

    return service.status()


@mcp.tool()
def project_graph_reindex(mode: str = "smooth") -> dict:
    """Incrementally rebuild the active project graph and synchronize Lean certificates."""

    return service.reindex(VerificationMode(mode))


@mcp.tool()
def project_graph_start_llm_index() -> dict:
    """Start backgroundAgentDefaultModel as the GraphRAG indexing LLM subprocess."""

    return service.start_graphrag_index()


@mcp.tool()
def project_graph_llm_index_status(job_id: str | None = None) -> dict:
    """Return one GraphRAG indexing subprocess state and active index metadata."""

    return {
        "job": service.graphrag_index_job_status(job_id),
        "index": service.graph_rag_index.status(),
    }


@mcp.tool()
def project_graph_search(
    query: str,
    max_entry_nodes: int = 8,
    max_hops: int = 2,
) -> dict:
    """Find semantic entry objects and traverse their cycle-safe project subgraph."""

    return service.search(
        query,
        max_entry_nodes=max_entry_nodes,
        max_hops=max_hops,
    )


@mcp.tool()
def project_graph_get(object_id: str) -> dict:
    """Get one project graph object by its stable ID."""

    return service.get(object_id)


@mcp.tool()
def project_graph_neighbors(object_id: str, max_hops: int = 1) -> dict:
    """Traverse the graph from an exact object using a visited set."""

    return service.neighbors(object_id, max_hops=max_hops)


@mcp.tool()
def project_graph_verify_candidate(
    left_object_id: str,
    right_object_id: str,
    semantic_score: float,
    evidence: list[str],
    model_revision: str,
    mode: str = "smooth",
) -> dict:
    """Persist a semantic duplicate candidate and synchronize its Lean certificate."""

    return service.verify_candidate(
        left_object_id,
        right_object_id,
        semantic_score=semantic_score,
        evidence=tuple(evidence),
        model_revision=model_revision,
        mode=VerificationMode(mode),
    )


def main() -> None:
    with asyncio.Runner() as runner:
        tools = tuple(
            tool.model_dump(by_alias=True, exclude_none=True)
            for tool in runner.run(mcp.list_tools())
        )
    run_stdio_server(
        StdioServerDefinition(
            name="project-graph",
            version="0.1.0",
            instructions=INSTRUCTIONS,
            tools=tools,
            handlers={
                "project_graph_status": project_graph_status,
                "project_graph_reindex": project_graph_reindex,
                "project_graph_start_llm_index": project_graph_start_llm_index,
                "project_graph_llm_index_status": project_graph_llm_index_status,
                "project_graph_search": project_graph_search,
                "project_graph_get": project_graph_get,
                "project_graph_neighbors": project_graph_neighbors,
                "project_graph_verify_candidate": project_graph_verify_candidate,
            },
        )
    )


if __name__ == "__main__":
    main()
