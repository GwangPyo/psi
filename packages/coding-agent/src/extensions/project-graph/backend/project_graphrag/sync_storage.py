from __future__ import annotations

import re
import shutil
from collections.abc import Iterator
from datetime import datetime
from pathlib import Path
from typing import Any

from graphrag_storage import Storage, register_storage
from graphrag_storage.storage import get_timestamp_formatted_with_local_tz


STORAGE_TYPE = "project_sync_file"


class SynchronousFileStorage(Storage):
    """GraphRAG file storage without aiofiles/thread-pool dependency."""

    def __init__(
        self,
        base_dir: str,
        encoding: str | None = "utf-8",
        **unused: Any,
    ) -> None:
        self.base_dir = Path(base_dir).resolve()
        self.encoding = encoding or "utf-8"
        self.base_dir.mkdir(parents=True, exist_ok=True)

    def find(self, file_pattern: re.Pattern[str]) -> Iterator[str]:
        for path in sorted(self.base_dir.rglob("*")):
            if path.is_file() and file_pattern.search(str(path)):
                yield path.relative_to(self.base_dir).as_posix()

    async def get(
        self,
        key: str,
        as_bytes: bool | None = False,
        encoding: str | None = None,
    ) -> Any:
        path = self.get_path(key)
        if not path.exists():
            return None
        return path.read_bytes() if as_bytes else path.read_text(encoding=encoding or self.encoding)

    async def set(self, key: str, value: Any, encoding: str | None = None) -> None:
        path = self.get_path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(value, bytes):
            path.write_bytes(value)
        else:
            path.write_text(str(value), encoding=encoding or self.encoding)

    async def has(self, key: str) -> bool:
        return self.get_path(key).exists()

    async def delete(self, key: str) -> None:
        path = self.get_path(key)
        if path.exists():
            path.unlink()

    async def clear(self) -> None:
        for path in self.base_dir.iterdir():
            if path.is_dir():
                shutil.rmtree(path)
            else:
                path.unlink()

    def child(self, name: str | None) -> "Storage":
        return self if name is None else SynchronousFileStorage(str(self.base_dir / name), self.encoding)

    def keys(self) -> list[str]:
        return [path.name for path in self.base_dir.iterdir() if path.is_file()]

    async def get_creation_date(self, key: str) -> str:
        timestamp = datetime.fromtimestamp(self.get_path(key).stat().st_ctime).astimezone()
        return get_timestamp_formatted_with_local_tz(timestamp)

    def get_path(self, key: str) -> Path:
        path = (self.base_dir / key).resolve()
        if self.base_dir not in path.parents and path != self.base_dir:
            raise ValueError("GraphRAG storage key escapes its base directory")
        return path


def register_synchronous_file_storage() -> None:
    register_storage(STORAGE_TYPE, SynchronousFileStorage)
