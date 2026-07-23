from __future__ import annotations

import hashlib
import subprocess
from pathlib import Path

from .domain import ProjectIdentity, stable_id


def identify_project(start: str | Path) -> ProjectIdentity:
    candidate = Path(start).resolve()
    root_value = _git(candidate, "rev-parse", "--show-toplevel")
    root = Path(root_value).resolve() if root_value else candidate
    remote = _git(root, "config", "--get", "remote.origin.url")
    head = _git(root, "rev-parse", "HEAD")
    branch = _git(root, "branch", "--show-current")
    status = _git(root, "status", "--porcelain=v1", "-z") or ""
    worktree_revision = hashlib.sha256(status.encode("utf-8")).hexdigest()
    project_id = stable_id("project", str(root), remote or "")
    return ProjectIdentity(
        id=project_id,
        root=root,
        git_remote=remote,
        git_head=head,
        git_branch=branch,
        worktree_revision=worktree_revision,
    )


def _git(cwd: Path, *arguments: str) -> str | None:
    try:
        result = subprocess.run(
            ["git", "-C", str(cwd), *arguments],
            check=False,
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0:
        return None
    return result.stdout.strip("\0\n")
