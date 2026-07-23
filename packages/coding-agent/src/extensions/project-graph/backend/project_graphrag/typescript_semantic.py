from __future__ import annotations

import json
import subprocess
from collections import Counter
from pathlib import Path

from .domain import (
    ContractObject,
    Effect,
    ProjectIdentity,
    SemanticObject,
    SourceSpan,
    stable_id,
)


class TypeScriptUnavailable(RuntimeError):
    pass


class TypeScriptSemanticExtractor:
    def __init__(
        self,
        node_executable: str = "node",
        typescript_module: Path | None = None,
    ) -> None:
        self.node_executable = node_executable
        self.typescript_module = typescript_module
        self.helper = Path(__file__).with_name("typescript_extractor.mjs")

    def extract_project(self, project: ProjectIdentity) -> list[SemanticObject]:
        module = self.typescript_module or _typescript_module(project.root)
        if module is None:
            raise TypeScriptUnavailable("TypeScript compiler API was not found in the project")
        process = subprocess.run(
            [
                self.node_executable,
                str(self.helper),
                str(module),
                str(project.root),
            ],
            check=False,
            capture_output=True,
            text=True,
            timeout=120,
        )
        if process.returncode != 0:
            raise RuntimeError(process.stderr.strip() or "TypeScript semantic extraction failed")
        result = json.loads(process.stdout)
        extractor = f"typescript-compiler-contract-v1/{result['typescript_version']}"
        identities = Counter(
            (item["path"], item["qualified_name"])
            for item in result["objects"]
        )
        objects: list[SemanticObject] = []
        for item in result["objects"]:
            qualified_name = item["qualified_name"]
            if identities[(item["path"], qualified_name)] > 1:
                qualified_name = f"{qualified_name}@{item['start_line']}"
            contract_value = item["contract"]
            contract = (
                ContractObject(
                    input_kinds=tuple(contract_value["input_kinds"]),
                    output_kind=contract_value["output_kind"],
                    behavior=contract_value["behavior"],
                    effect=Effect(contract_value["effect"]),
                    failure_modes=tuple(contract_value["failure_modes"]),
                )
                if contract_value is not None
                else None
            )
            objects.append(
                SemanticObject(
                    id=stable_id(
                        "object",
                        project.id,
                        item["path"],
                        qualified_name,
                    ),
                    project_id=project.id,
                    kind="typescript-function",
                    qualified_name=qualified_name,
                    source=SourceSpan(
                        path=item["path"],
                        start_line=int(item["start_line"]),
                        end_line=int(item["end_line"]),
                    ),
                    source_hash=item["source_hash"],
                    contract=contract,
                    extractor=extractor,
                    confidence=1.0 if contract else 0.0,
                )
            )
        return objects


def _typescript_module(root: Path) -> Path | None:
    direct = root / "node_modules" / "typescript" / "lib" / "typescript.js"
    if direct.exists():
        return direct
    matches = sorted(
        root.glob("*/node_modules/typescript/lib/typescript.js"),
        key=lambda path: (len(path.parts), str(path)),
    )
    return matches[0] if matches else None
