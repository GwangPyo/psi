from __future__ import annotations

import argparse
import json
import os
from dataclasses import asdict
from pathlib import Path

from .domain import VerificationMode
from .indexer import ProjectIndexer
from .lean_verifier import LeanVerifier
from .project import identify_project
from .query import ProjectGraphQuery
from .store import CorruptGraphStore, ProjectGraphStore
from .synchronizer import GraphLeanSynchronizer


def main() -> None:
    parser = argparse.ArgumentParser(prog="project-graphrag")
    parser.add_argument(
        "--data-root",
        default=os.environ.get(
            "PROJECT_GRAPHRAG_DATA_ROOT",
            str(Path.home() / ".project-graphrag"),
        ),
    )
    subcommands = parser.add_subparsers(dest="command", required=True)

    index = subcommands.add_parser("index")
    index.add_argument("project", nargs="?", default=".")
    index.add_argument(
        "--mode",
        choices=[item.value for item in VerificationMode],
        default=VerificationMode.SMOOTH.value,
    )
    index.add_argument("--skip-lean", action="store_true")

    status = subcommands.add_parser("status")
    status.add_argument("project", nargs="?", default=".")

    search = subcommands.add_parser("search")
    search.add_argument("project")
    search.add_argument("query")
    search.add_argument("--hops", type=int, default=2)
    search.add_argument("--limit", type=int, default=8)

    arguments = parser.parse_args()
    project = identify_project(arguments.project)
    store = ProjectGraphStore(arguments.data_root, project)

    if arguments.command == "status":
        state = store.snapshot()
        print(
            json.dumps(
                {
                    "project": asdict(project) | {"root": str(project.root)},
                    "generation": state["generation"],
                    "objects": len(state["objects"]),
                    "candidates": len(state["candidates"]),
                    "edges": len(state["edges"]),
                    "certificates": len(state["certificates"]),
                    "jobs": len(state["jobs"]),
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return

    if arguments.command == "search":
        context = ProjectGraphQuery(store).search(
            arguments.query,
            max_entry_nodes=arguments.limit,
            max_hops=arguments.hops,
        )
        print(
            json.dumps(
                {
                    "query": context.query,
                    "entry_nodes": [
                        {
                            "id": item.object.id,
                            "kind": item.object.kind,
                            "name": item.object.qualified_name,
                            "score": item.score,
                            "reasons": item.reasons,
                        }
                        for item in context.entry_nodes
                    ],
                    "objects": [
                        {
                            "id": item.id,
                            "kind": item.kind,
                            "name": item.qualified_name,
                            "summary": item.summary,
                            "source": asdict(item.source),
                        }
                        for item in context.objects
                    ],
                    "edges": [asdict(item) for item in context.edges],
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return

    try:
        store.snapshot()
    except CorruptGraphStore:
        store.archive_corrupt_legacy()
    except json.JSONDecodeError:
        store.archive_corrupt_legacy()

    verifier = LeanVerifier()
    synchronizer = GraphLeanSynchronizer(store, verifier)
    synchronizer.reconcile()
    result = ProjectIndexer(synchronizer).index_project(VerificationMode(arguments.mode))
    certificates = [] if arguments.skip_lean else synchronizer.synchronize_pending()
    print(
        json.dumps(
            {
                "project": project.id,
                "root": str(project.root),
                "generation": result.generation,
                "objects": result.object_count,
                "queued": result.pending_verifications,
                "verified": len(certificates),
                "errors": result.errors,
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
