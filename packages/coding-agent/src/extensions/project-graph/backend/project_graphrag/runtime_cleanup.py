from __future__ import annotations

import atexit
import sys


_registered = False


def register_graphrag_runtime_cleanup() -> None:
    """Close optional LanceDB globals imported by GraphRAG workflow registration."""

    global _registered
    if _registered:
        return
    _registered = True
    atexit.register(_cleanup_lancedb)


def _cleanup_lancedb() -> None:
    module = sys.modules.get("lancedb.background_loop")
    if module is None:
        return
    background = getattr(module, "LOOP", None)
    loop = getattr(background, "loop", None)
    thread = getattr(background, "thread", None)
    if loop is not None and loop.is_running():
        loop.call_soon_threadsafe(loop.stop)
    if thread is not None and thread.is_alive():
        thread.join(timeout=2)
    if loop is not None and not loop.is_running() and not loop.is_closed():
        loop.close()
    executor = getattr(module, "_EMBEDDING_EXECUTOR", None)
    if executor is not None:
        executor.shutdown(wait=False, cancel_futures=True)
