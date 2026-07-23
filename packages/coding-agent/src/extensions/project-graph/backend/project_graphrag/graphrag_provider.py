from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Callable

from graphrag_llm.completion import register_completion
from graphrag_llm.embedding import register_embedding
from graphrag_llm.types import (
    LLMChoiceChunk,
    LLMChoiceDelta,
    LLMCompletionChunk,
    LLMEmbedding,
    LLMEmbeddingResponse,
    LLMEmbeddingUsage,
)
from graphrag_llm.utils import create_completion_response, structure_completion_response

from .indexing_model import IndexingModel


@dataclass(frozen=True)
class IndexingModelCall:
    kind: str
    reference: str
    revision: str
    purpose: str


ModelAuthority = Callable[[], IndexingModel]


class ProjectGraphRagCompletion:
    def __init__(
        self,
        *,
        authority: ModelAuthority,
        calls: list[IndexingModelCall],
        tokenizer: Any,
        metrics_store: Any,
        purpose: str = "graph_extraction",
        **unused: Any,
    ) -> None:
        self.authority = authority
        self.calls = calls
        self.graph_tokenizer = tokenizer
        self.graph_metrics_store = metrics_store
        self.purpose = purpose

    def completion(self, /, **kwargs: Any) -> Any:
        response_format = kwargs.get("response_format")
        model = self.authority()
        self.calls.append(IndexingModelCall("completion", model.reference, model.revision, self.purpose))
        value = model.complete(
            messages=_messages(kwargs["messages"]),
            response_schema=response_format.model_json_schema() if response_format else None,
        )
        text = json.dumps(value, ensure_ascii=False) if isinstance(value, dict) else value
        if kwargs.get("stream"):
            return iter([_completion_chunk(text, model.reference)])
        response = create_completion_response(text)
        response.model = model.reference
        if response_format:
            response.formatted_response = (
                response_format.model_validate(value)
                if isinstance(value, dict)
                else structure_completion_response(text, response_format)
            )
        return response

    async def completion_async(self, /, **kwargs: Any) -> Any:
        if kwargs.get("stream"):
            return self.completion_stream(kwargs)
        return self.completion(**kwargs)

    async def completion_stream(self, kwargs: dict[str, Any]):
        response = self.completion(**{**kwargs, "stream": False})
        yield _completion_chunk(response.content, response.model)

    @property
    def metrics_store(self) -> Any:
        return self.graph_metrics_store

    @property
    def tokenizer(self) -> Any:
        return self.graph_tokenizer


class ProjectGraphRagEmbedding:
    def __init__(
        self,
        *,
        authority: ModelAuthority,
        calls: list[IndexingModelCall],
        tokenizer: Any,
        metrics_store: Any,
        purpose: str = "embedding",
        **unused: Any,
    ) -> None:
        self.authority = authority
        self.calls = calls
        self.graph_tokenizer = tokenizer
        self.graph_metrics_store = metrics_store
        self.purpose = purpose

    def embedding(self, /, **kwargs: Any) -> LLMEmbeddingResponse:
        inputs = kwargs["input"]
        model = self.authority()
        self.calls.append(IndexingModelCall("embedding", model.reference, model.revision, self.purpose))
        vectors = model.embed(inputs)
        if len(vectors) != len(inputs):
            raise ValueError("GraphRAG indexing embedding count mismatch")
        return LLMEmbeddingResponse(
            object="list",
            data=[
                LLMEmbedding(object="embedding", embedding=vector, index=index)
                for index, vector in enumerate(vectors)
            ],
            model=model.reference,
            usage=LLMEmbeddingUsage(prompt_tokens=0, total_tokens=0),
        )

    async def embedding_async(self, /, **kwargs: Any) -> LLMEmbeddingResponse:
        return self.embedding(**kwargs)

    @property
    def metrics_store(self) -> Any:
        return self.graph_metrics_store

    @property
    def tokenizer(self) -> Any:
        return self.graph_tokenizer


def register_project_indexing_provider(
    provider_type: str,
    authority: ModelAuthority,
    calls: list[IndexingModelCall],
) -> None:
    register_completion(
        provider_type,
        lambda **kwargs: ProjectGraphRagCompletion(authority=authority, calls=calls, **kwargs),
    )
    register_embedding(
        provider_type,
        lambda **kwargs: ProjectGraphRagEmbedding(authority=authority, calls=calls, **kwargs),
    )


def _messages(value: object) -> list[dict[str, object]]:
    if isinstance(value, str):
        return [{"role": "user", "content": value}]
    messages: list[dict[str, object]] = []
    for message in value:  # type: ignore[union-attr]
        if isinstance(message, dict):
            messages.append(dict(message))
        elif hasattr(message, "model_dump"):
            messages.append(message.model_dump())
        else:
            messages.append(
                {"role": getattr(message, "role"), "content": getattr(message, "content")}
            )
    return messages


def _completion_chunk(content: str, model: str) -> LLMCompletionChunk:
    return LLMCompletionChunk(
        id="project-graphrag-indexing",
        object="chat.completion.chunk",
        created=0,
        model=model,
        choices=[
            LLMChoiceChunk(
                index=0,
                delta=LLMChoiceDelta(content=content),
                finish_reason="stop",
            )
        ],
    )
