from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class BackgroundModelConfigure:
    state: str
    model_reference: str | None
    revision: str
    source_paths: tuple[str, ...]
    effective_scope: str | None


def load_background_model_config(
    project_root: str | Path,
    *,
    global_settings: str | Path | None = None,
) -> BackgroundModelConfigure:
    project_root = Path(project_root).resolve()
    global_path = Path(
        global_settings
        or os.environ.get("PI_AGENT_SETTINGS", Path.home() / ".pi" / "agent" / "settings.json")
    )
    project_path = project_root / ".pi" / "settings.json"
    sources: list[tuple[Path, dict]] = []
    for path in (global_path, project_path):
        if not path.exists():
            continue
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as error:
            return BackgroundModelConfigure(
                state="model_config_error",
                model_reference=None,
                revision=_revision([(path, f"error:{error}")]),
                source_paths=tuple(str(item[0]) for item in sources) + (str(path),),
                effective_scope=None,
            )
        if not isinstance(value, dict):
            return BackgroundModelConfigure(
                state="model_config_error",
                model_reference=None,
                revision=_revision([(path, "error:settings must be an object")]),
                source_paths=tuple(str(item[0]) for item in sources) + (str(path),),
                effective_scope=None,
            )
        sources.append((path, value))

    reference: str | None = None
    effective_scope: str | None = None
    for path, settings in sources:
        candidate = settings.get("backgroundAgentDefaultModel")
        if candidate is None:
            continue
        if not isinstance(candidate, str) or not candidate.strip() or "/" not in candidate:
            return BackgroundModelConfigure(
                state="model_config_error",
                model_reference=None,
                revision=_revision(
                    [
                        (item_path, item.get("backgroundAgentDefaultModel"))
                        for item_path, item in sources
                    ]
                ),
                source_paths=tuple(str(item[0]) for item in sources),
                effective_scope="project" if path == project_path else "global",
            )
        reference = candidate.strip()
        effective_scope = "project" if path == project_path else "global"

    revision = _revision(
        [(path, value.get("backgroundAgentDefaultModel")) for path, value in sources]
    )
    return BackgroundModelConfigure(
        state="ready" if reference else "model_config_missing",
        model_reference=reference,
        revision=revision,
        source_paths=tuple(str(path) for path, _ in sources),
        effective_scope=effective_scope,
    )


def _revision(values: list[tuple[Path, object]]) -> str:
    payload = [
        {"path": str(path.resolve()), "value": value}
        for path, value in values
    ]
    return hashlib.sha256(
        json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")
    ).hexdigest()
