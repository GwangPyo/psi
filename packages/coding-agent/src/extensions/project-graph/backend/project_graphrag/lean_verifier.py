from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

from .domain import (
    ContractObject,
    ProjectIdentity,
    ReliabilityCertificate,
    SemanticObject,
    VerificationClaim,
    VerificationMode,
    VerificationStatus,
    stable_id,
)


class VerificationError(RuntimeError):
    pass


@dataclass(frozen=True)
class LeanRun:
    succeeded: bool
    version: str
    source: str
    diagnostics: tuple[str, ...]


class LeanVerifier:
    """Verify small semantic-object claims with the Lean 4 kernel."""

    def __init__(
        self,
        executable: str = "lean",
        timeout_seconds: int = 10,
        memory_megabytes: int = 256,
    ) -> None:
        resolved = shutil.which(executable)
        if resolved is None:
            raise FileNotFoundError(f"Lean executable is unavailable: {executable}")
        self.executable = resolved
        self.timeout_seconds = timeout_seconds
        self.memory_megabytes = memory_megabytes
        self.version = self._version()

    def verify(
        self,
        project: ProjectIdentity,
        left: SemanticObject,
        right: SemanticObject,
        *,
        claim: VerificationClaim = VerificationClaim.EQUIVALENT,
        mode: VerificationMode = VerificationMode.SMOOTH,
        dependencies: tuple[str, ...] = (),
    ) -> ReliabilityCertificate:
        if left.contract is None or right.contract is None:
            return self._unavailable_certificate(
                project,
                left,
                right,
                claim,
                mode,
                dependencies,
                "semantic contract is unavailable",
            )

        run = self.run_claim(left.contract, right.contract, claim)
        certificate_id = stable_id(
            "certificate",
            project.id,
            left.id,
            right.id,
            claim.value,
            left.contract.hash,
            right.contract.hash,
            *dependencies,
        )
        if not run.succeeded:
            reason = "; ".join(run.diagnostics) or "Lean rejected the generated claim"
            if mode is VerificationMode.STRICT:
                raise VerificationError(reason)
            return ReliabilityCertificate(
                id=certificate_id,
                project_id=project.id,
                left_object_id=left.id,
                right_object_id=right.id,
                claim=claim,
                status=VerificationStatus.UNKNOWN,
                mode=mode,
                source_hashes=(left.source_hash, right.source_hash),
                contract_hashes=(left.contract.hash, right.contract.hash),
                dependencies=dependencies,
                lean_version=run.version,
                reason=reason,
            )

        return ReliabilityCertificate(
            id=certificate_id,
            project_id=project.id,
            left_object_id=left.id,
            right_object_id=right.id,
            claim=claim,
            status=VerificationStatus.VERIFIED,
            mode=mode,
            source_hashes=(left.source_hash, right.source_hash),
            contract_hashes=(left.contract.hash, right.contract.hash),
            dependencies=dependencies,
            lean_version=run.version,
            proof_hash=hashlib.sha256(run.source.encode("utf-8")).hexdigest(),
        )

    def run_claim(
        self,
        left: ContractObject,
        right: ContractObject,
        claim: VerificationClaim,
    ) -> LeanRun:
        source = _lean_source(left, right, claim)
        with tempfile.TemporaryDirectory(prefix="project-graphrag-lean-") as temporary:
            path = Path(temporary) / "Certificate.lean"
            path.write_text(source, encoding="utf-8")
            try:
                process = subprocess.run(
                    [
                        self.executable,
                        "--trust=0",
                        "--json",
                        f"--memory={self.memory_megabytes}",
                        str(path),
                    ],
                    check=False,
                    capture_output=True,
                    text=True,
                    timeout=self.timeout_seconds,
                    cwd=temporary,
                )
            except subprocess.TimeoutExpired:
                return LeanRun(False, self.version, source, ("Lean verification timed out",))

        diagnostics, has_error = _lean_diagnostics(process.stdout, process.stderr)
        return LeanRun(
            process.returncode == 0 and not has_error,
            self.version,
            source,
            diagnostics,
        )

    def _unavailable_certificate(
        self,
        project: ProjectIdentity,
        left: SemanticObject,
        right: SemanticObject,
        claim: VerificationClaim,
        mode: VerificationMode,
        dependencies: tuple[str, ...],
        reason: str,
    ) -> ReliabilityCertificate:
        if mode is VerificationMode.STRICT:
            raise VerificationError(reason)
        return ReliabilityCertificate(
            id=stable_id("certificate", project.id, left.id, right.id, claim.value),
            project_id=project.id,
            left_object_id=left.id,
            right_object_id=right.id,
            claim=claim,
            status=VerificationStatus.UNKNOWN,
            mode=mode,
            source_hashes=(left.source_hash, right.source_hash),
            contract_hashes=(
                left.contract.hash if left.contract else "missing",
                right.contract.hash if right.contract else "missing",
            ),
            dependencies=dependencies,
            lean_version=self.version,
            reason=reason,
        )

    def _version(self) -> str:
        result = subprocess.run(
            [self.executable, "--version"],
            check=True,
            capture_output=True,
            text=True,
            timeout=5,
        )
        return result.stdout.strip()


def _lean_source(
    left: ContractObject,
    right: ContractObject,
    claim: VerificationClaim,
) -> str:
    expected = "true" if claim is VerificationClaim.EQUIVALENT else "false"
    return "\n".join(
        (
            "inductive Effect where",
            "  | pure",
            "  | state",
            "  | io",
            "  | unknown",
            "deriving DecidableEq",
            "",
            "structure ContractObject where",
            "  inputKinds : List String",
            "  outputKind : String",
            "  behavior : String",
            "  effect : Effect",
            "  failureModes : List String",
            "deriving DecidableEq",
            "",
            "def equivalentContract (left right : ContractObject) : Bool :=",
            "  decide (left = right)",
            "",
            f"def leftContract : ContractObject := {_contract_literal(left)}",
            f"def rightContract : ContractObject := {_contract_literal(right)}",
            "",
            "theorem certificate :",
            f"    equivalentContract leftContract rightContract = {expected} := by",
            "  native_decide",
            "",
        )
    )


def _contract_literal(contract: ContractObject) -> str:
    inputs = ", ".join(_lean_string(value) for value in contract.input_kinds)
    failures = ", ".join(_lean_string(value) for value in contract.failure_modes)
    return " ".join(
        (
            "{",
            f"inputKinds := [{inputs}]",
            f", outputKind := {_lean_string(contract.output_kind)}",
            f", behavior := {_lean_string(contract.behavior)}",
            f", effect := .{contract.effect.value}",
            f", failureModes := [{failures}]",
            "}",
        )
    )


def _lean_string(value: str) -> str:
    escaped: list[str] = ['"']
    for character in value:
        codepoint = ord(character)
        if character == '"':
            escaped.append('\\"')
        elif character == "\\":
            escaped.append("\\\\")
        elif character == "\n":
            escaped.append("\\n")
        elif character == "\r":
            escaped.append("\\r")
        elif character == "\t":
            escaped.append("\\t")
        elif codepoint >= 0x20:
            escaped.append(character)
        else:
            escaped.append(f"\\u{codepoint:04x}")
    escaped.append('"')
    return "".join(escaped)


def _lean_diagnostics(stdout: str, stderr: str) -> tuple[tuple[str, ...], bool]:
    messages: list[str] = []
    has_error = False
    for line in stdout.splitlines():
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            if line.strip():
                messages.append(line.strip())
            continue
        severity = str(item.get("severity", ""))
        kind = str(item.get("kind", ""))
        data = str(item.get("data", ""))
        if severity == "error" or kind == "hasSorry":
            has_error = True
        if data:
            messages.append(data)
    if stderr.strip():
        messages.append(stderr.strip())
        has_error = True
    return tuple(messages), has_error
