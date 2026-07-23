from __future__ import annotations

import ast
import hashlib
from pathlib import Path

from .domain import (
    ContractObject,
    Effect,
    ProjectIdentity,
    SemanticObject,
    SourceSpan,
    stable_id,
)


class PythonSemanticExtractor:
    """Extract small, high-confidence behavioral contracts from Python source."""

    version = "python-ast-contract-v1"

    def extract_file(
        self,
        project: ProjectIdentity,
        path: Path,
    ) -> list[SemanticObject]:
        source = path.read_text(encoding="utf-8")
        tree = ast.parse(source, filename=str(path))
        relative_path = str(path.resolve().relative_to(project.root))
        objects: list[SemanticObject] = []
        for qualified_name, node in _functions(tree):
            segment = ast.get_source_segment(source, node) or ""
            contract = _contract(node)
            objects.append(
                SemanticObject(
                    id=stable_id(
                        "object",
                        project.id,
                        relative_path,
                        qualified_name,
                    ),
                    project_id=project.id,
                    kind="python-function",
                    qualified_name=qualified_name,
                    source=SourceSpan(
                        path=relative_path,
                        start_line=node.lineno,
                        end_line=node.end_lineno or node.lineno,
                    ),
                    source_hash=hashlib.sha256(segment.encode("utf-8")).hexdigest(),
                    contract=contract,
                    extractor=self.version,
                    confidence=1.0 if contract is not None else 0.0,
                )
            )
        return objects


def _functions(tree: ast.Module) -> list[tuple[str, ast.FunctionDef | ast.AsyncFunctionDef]]:
    found: list[tuple[str, ast.FunctionDef | ast.AsyncFunctionDef]] = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            found.append((node.name, node))
        elif isinstance(node, ast.ClassDef):
            for child in node.body:
                if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    found.append((f"{node.name}.{child.name}", child))
    return found


def _contract(node: ast.FunctionDef | ast.AsyncFunctionDef) -> ContractObject | None:
    body = list(node.body)
    if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant):
        if isinstance(body[0].value.value, str):
            body = body[1:]
    if len(body) != 1 or not isinstance(body[0], ast.Return) or body[0].value is None:
        return None
    if isinstance(node, ast.AsyncFunctionDef):
        return None

    arguments = [*node.args.posonlyargs, *node.args.args]
    argument_names = {argument.arg: index for index, argument in enumerate(arguments)}
    input_kinds = tuple(_annotation(argument.annotation) for argument in arguments)
    output_kind = _annotation(node.returns)
    numeric = bool(input_kinds) and all(
        value in {"Int", "Float"} for value in (*input_kinds, output_kind)
    )
    behavior = _expression(body[0].value, argument_names, numeric)
    if behavior is None:
        return None
    return ContractObject(
        input_kinds=input_kinds,
        output_kind=output_kind,
        behavior=behavior,
        effect=Effect.PURE,
    )


def _annotation(node: ast.expr | None) -> str:
    if node is None:
        return "Unknown"
    if isinstance(node, ast.Name):
        return {"int": "Int", "float": "Float", "bool": "Bool", "str": "String"}.get(
            node.id,
            node.id,
        )
    return ast.unparse(node)


def _expression(
    node: ast.expr,
    arguments: dict[str, int],
    numeric: bool,
) -> str | None:
    if isinstance(node, ast.Name) and node.id in arguments:
        return f"arg:{arguments[node.id]}"
    if isinstance(node, ast.Constant) and isinstance(node.value, (str, int, float, bool, type(None))):
        return f"const:{node.value!r}"
    if isinstance(node, ast.UnaryOp):
        operand = _expression(node.operand, arguments, numeric)
        if operand is None:
            return None
        operator = {ast.USub: "neg", ast.UAdd: "pos", ast.Not: "not"}.get(type(node.op))
        return f"{operator}({operand})" if operator else None
    if isinstance(node, ast.BinOp):
        left = _expression(node.left, arguments, numeric)
        right = _expression(node.right, arguments, numeric)
        if left is None or right is None:
            return None
        operator = {
            ast.Add: "add",
            ast.Sub: "sub",
            ast.Mult: "mul",
            ast.FloorDiv: "floordiv",
            ast.Mod: "mod",
        }.get(type(node.op))
        if operator is None:
            return None
        operands = sorted((left, right)) if numeric and operator in {"add", "mul"} else (left, right)
        return f"{operator}({operands[0]},{operands[1]})"
    if isinstance(node, ast.IfExp):
        condition = _expression(node.test, arguments, numeric)
        positive = _expression(node.body, arguments, numeric)
        negative = _expression(node.orelse, arguments, numeric)
        if None in {condition, positive, negative}:
            return None
        return f"if({condition},{positive},{negative})"
    if isinstance(node, ast.Compare) and len(node.ops) == 1 and len(node.comparators) == 1:
        left = _expression(node.left, arguments, numeric)
        right = _expression(node.comparators[0], arguments, numeric)
        operator = {
            ast.Eq: "eq",
            ast.NotEq: "ne",
            ast.Lt: "lt",
            ast.LtE: "le",
            ast.Gt: "gt",
            ast.GtE: "ge",
        }.get(type(node.ops[0]))
        if left is None or right is None or operator is None:
            return None
        return f"{operator}({left},{right})"
    return None
