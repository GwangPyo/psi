from __future__ import annotations

import json
import sys
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import TextIO

from mcp.shared.version import LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS


JsonObject = dict[str, object]
ToolHandler = Callable[..., JsonObject]


@dataclass(frozen=True)
class StdioServerDefinition:
    name: str
    version: str
    instructions: str
    tools: tuple[JsonObject, ...]
    handlers: Mapping[str, ToolHandler]


def run_stdio_server(
    definition: StdioServerDefinition,
    *,
    input_stream: TextIO = sys.stdin,
    output_stream: TextIO = sys.stdout,
) -> None:
    """Serve MCP JSON-RPC over newline-delimited stdio.

    The Python MCP SDK's AnyIO stdio adapter is not reliable with every AnyIO
    release. This adapter intentionally keeps transport concerns synchronous;
    graph indexing and tool semantics remain in ProjectGraphService.
    """

    for line in input_stream:
        response = _handle_line(line, definition)
        if response is None:
            continue
        output_stream.write(
            json.dumps(response, ensure_ascii=False, separators=(",", ":"), default=str)
            + "\n"
        )
        output_stream.flush()


def _handle_line(line: str, definition: StdioServerDefinition) -> JsonObject | None:
    try:
        message = json.loads(line)
    except json.JSONDecodeError as error:
        return _error(None, -32700, f"Parse error: {error.msg}")

    if not isinstance(message, dict) or message.get("jsonrpc") != "2.0":
        return _error(_request_id(message), -32600, "Invalid Request")

    request_id = message.get("id")
    method = message.get("method")
    if not isinstance(method, str):
        return _error(request_id, -32600, "Invalid Request")

    if "id" not in message:
        return None

    params = message.get("params", {})
    if not isinstance(params, dict):
        return _error(request_id, -32602, "Invalid params")

    if method == "initialize":
        requested = params.get("protocolVersion")
        protocol_version = (
            requested
            if isinstance(requested, str) and requested in SUPPORTED_PROTOCOL_VERSIONS
            else LATEST_PROTOCOL_VERSION
        )
        return _result(
            request_id,
            {
                "protocolVersion": protocol_version,
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {
                    "name": definition.name,
                    "version": definition.version,
                },
                "instructions": definition.instructions,
            },
        )
    if method == "ping":
        return _result(request_id, {})
    if method == "tools/list":
        return _result(request_id, {"tools": list(definition.tools)})
    if method == "tools/call":
        return _call_tool(request_id, params, definition.handlers)
    return _error(request_id, -32601, f"Method not found: {method}")


def _call_tool(
    request_id: object,
    params: JsonObject,
    handlers: Mapping[str, ToolHandler],
) -> JsonObject:
    name = params.get("name")
    arguments = params.get("arguments", {})
    if not isinstance(name, str) or not isinstance(arguments, dict):
        return _error(request_id, -32602, "Invalid tool call params")
    handler = handlers.get(name)
    if handler is None:
        return _tool_result(request_id, {"error": f"Unknown tool: {name}"}, is_error=True)
    try:
        value = handler(**arguments)
    except Exception as error:
        return _tool_result(
            request_id,
            {"error": type(error).__name__, "message": str(error)},
            is_error=True,
        )
    return _tool_result(request_id, value, is_error=False)


def _tool_result(request_id: object, value: JsonObject, *, is_error: bool) -> JsonObject:
    text = json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)
    return _result(
        request_id,
        {
            "content": [{"type": "text", "text": text}],
            "structuredContent": value,
            "isError": is_error,
        },
    )


def _result(request_id: object, result: JsonObject) -> JsonObject:
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def _error(request_id: object, code: int, message: str) -> JsonObject:
    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "error": {"code": code, "message": message},
    }


def _request_id(message: object) -> object:
    return message.get("id") if isinstance(message, dict) else None
