# PlanFSM Mode Extension

Read-only exploration mode that produces and executes a validated finite-state-machine plan. The example delegates to the built-in plan extension.

## Features

- Built-in edit/write tools are disabled during exploration.
- Bash commands pass through a read-only allowlist.
- `guide_plan` incrementally retains sequence, parallel, choice, revision, and final topology, then compiles and validates the graph on finalization.
- `plan_transition` advances active states with an explicit event and acceptance evidence.
- Fork and join hyper-transitions support parallel DAG branches.
- Every submission includes a dependency analysis and explicit independent state groups. Declared groups require a matching multi-target fork.
- Guarded transitions and visit limits support bounded loops.
- The machine definition, runtime snapshot, transition history, and evidence persist in the session.

## Commands

- `/plan` toggles PlanFSM mode.
- `/todos` shows the current machine and runtime state.
- `Ctrl+Alt+P` toggles PlanFSM mode.

## Flow

1. Enable plan mode with `/plan` or the `--plan` flag.
2. The agent explores with read-only tools.
3. The agent grows the retained frontier with `guide_plan` topology operations and finalizes it without serializing a complete PlanFSM.
4. Choose **Execute the plan**, **Stay in plan mode**, or **Refine the plan**.
5. During execution, the harness keeps driving the ready frontier until terminal status; the agent calls `plan_transition` with the exact enabled event and concrete evidence.
6. Execution ends when the active states reach success, failure, or blocked final outcomes.

Each action state declares its role, abstraction level, acceptance criteria, and error policy. The policy records failure visibility, suppression permission, and observable signals. Parallel groups are created by topology operations rather than manually maintained metadata. Structural fork and join transitions settle automatically, while action transitions require evidence.

## Command Allowlist

Allowed commands cover file inspection, search, directory listing, Git reads, package information, and system information. File modification, Git writes, package installation, privilege escalation, process control, and interactive editors are blocked during plan mode.
