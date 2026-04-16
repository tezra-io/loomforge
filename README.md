# Loom

Loom is a slim local workflow engine for agentic software delivery.

Goal: keep the parts Sujeeth actually needs from Paperclip, ditch the org-chart/platform overhead, and make design -> build -> review -> ship reliable.

## Current Runnable Shell

The daemon shell is runnable with stub workflow dependencies. It exercises the
HTTP API, CLI, workflow engine, SQLite store, queue drain, and handoff path, but
it does not yet call real Linear, git worktrees, Codex, or Claude.

Create a project registry:

```yaml
runtime:
  dataRoot: .loom-data
projects:
  - slug: loom
    repoRoot: /Users/sujshe/projects/loom
    defaultBranch: main
    verification:
      commands:
        - name: test
          command: pnpm test
```

Start the local daemon:

```sh
pnpm run dev -- start --config ./loom.yaml --port 3777
```

Use the CLI from another shell:

```sh
pnpm run dev -- status
pnpm run dev -- submit loom TEZ-1
pnpm run dev -- queue
```

The next implementation phases replace the stubs with the real verification
runner, worktree manager, Linear client, MCP adapter, and Codex/Claude runners.

## System Architecture

```mermaid
graph TB
    subgraph OpenClaw ["OpenClaw (Front Door & Planner)"]
        Chat["Chat with User"]
        Plan["Design / Planning"]
        Merge["Merge dev → main"]
    end

    subgraph Linear ["Linear"]
        Issues["Issues"]
    end

    subgraph Loom ["Loom (Local Daemon — loomd)"]
        MCP["MCP Server"]
        API["HTTP API (Fastify)"]
        CLI["CLI (Commander)"]
        LC["Linear Client"]
        WF["Workflow Engine"]
        Queue["Durable Ready Queue"]
        DB["SQLite State Store"]
        WT["Worktree Manager"]
        Art["Artifact Store (~/.loom/)"]

        subgraph Runners
            Codex["Codex Builder Runner\n(full-auto)"]
            Claude["Claude Reviewer Runner\n(skip-permissions)"]
        end
    end

    subgraph ProjectConfig ["Project Config (YAML files)"]
        Reg["Project Registry"]
        Verify["Verification Commands"]
    end

    subgraph Git ["Git"]
        Repo["Local Repo"]
        DevWT["dev branch worktree"]
    end

    Chat -->|selects issues| Plan
    Plan -->|"issue ID + project slug"| MCP
    MCP --> API
    CLI -->|operator access| API
    API --> WF
    WF --> LC
    LC -->|fetch issue details| Issues
    LC -->|"update status → Done"| Issues
    WF --> Queue
    WF --> DB
    WF --> WT
    WF --> Codex
    WF --> Claude
    WF --> Art
    Codex -->|"build + commit + push"| DevWT
    Claude -->|reviews diff| DevWT
    WT -->|"rebase dev on main"| DevWT
    DevWT --> Repo
    WF -->|"shipped notification"| Merge
    ProjectConfig --> WF
```

## Workflow State Machine

```mermaid
stateDiagram-v2
    [*] --> queued : OpenClaw submits issue ID

    queued --> preparing_workspace : dequeue (FIFO)
    preparing_workspace --> building : rebase dev on main + workspace ready
    preparing_workspace --> blocked : dirty workspace / rebase conflict

    building --> verifying : Codex completes
    building --> failed : runner error / timeout

    verifying --> reviewing : checks pass
    verifying --> revising : checks fail (budget remaining)
    verifying --> failed : checks fail (budget exhausted)
    verifying --> blocked : environmental failure

    reviewing --> ready_for_ship : review passes
    reviewing --> revising : P0/P1 findings (budget remaining)
    reviewing --> blocked : unresolved P0 (budget exhausted)
    reviewing --> failed : runner error / timeout

    revising --> building : feed findings back to Codex

    ready_for_ship --> shipped : push dev + Linear Done
    shipped --> [*]

    queued --> cancelled : operator / shutdown
    preparing_workspace --> cancelled : operator / shutdown
    building --> cancelled : operator / shutdown
    verifying --> cancelled : operator / shutdown
    reviewing --> cancelled : operator / shutdown
    revising --> cancelled : operator / shutdown

    note right of revising
        Max 3 revision loops (default).
        Single revisionCount incremented
        on each return to building.
    end note
```

## Build → Verify → Review Loop

```mermaid
sequenceDiagram
    participant OC as OpenClaw
    participant API as Loom API
    participant WF as Workflow Engine
    participant WT as Worktree Manager
    participant CX as Codex Builder
    participant VR as Verification
    participant CR as Claude Reviewer
    participant Art as Artifact Store

    participant LN as Linear

    OC->>API: loom_submit_run (project + issue ID)
    API->>WF: create run (queued)
    WF->>LN: fetch issue (title, description, criteria)
    LN-->>WF: issue snapshot
    WF->>LN: update status → In Progress
    WF->>WT: prepare worktree (rebase dev on main)
    WT-->>WF: worktree path (dev branch)

    loop Up to 3 revision cycles
        WF->>CX: build in worktree
        Note over CX: Codex implements + git commit (handles pre-commit hooks)
        CX-->>Art: builder.log, changed files
        CX-->>WF: BuilderResult (with commitSha)

        WF->>VR: run verification commands (against committed code)
        VR-->>Art: verify.log
        VR-->>WF: pass / fail

        alt Verification fails & budget remaining
            WF->>WF: revise (feed failure back)
        else Verification passes
            WF->>CR: review diff + evidence (against committed code)
            CR-->>Art: review.log, findings
            CR-->>WF: ReviewResult

            alt Review passes (ready_for_ship)
                WF->>CX: push dev to remote (handles pre-push hooks)
                CX-->>WF: push confirmed (shipped)
                WF->>LN: update status → Done
                WF->>Art: write handoff.json
                WF-->>OC: shipped (notification)
            else Review has findings & budget remaining
                WF->>WF: revise (feed findings back)
            end
        end
    end

    alt Budget exhausted with P0s
        WF-->>OC: blocked
    else Unrecoverable error
        WF-->>OC: failed
    end
```

## Data Model

```mermaid
erDiagram
    projects ||--o{ runs : "has"
    runs ||--o{ run_attempts : "contains"
    runs ||--o{ events : "emits"
    runs ||--|| workspaces : "uses"
    run_attempts ||--o{ verifications : "produces"
    run_attempts ||--o{ reviews : "produces"
    reviews ||--o{ review_findings : "contains"
    runs ||--o{ artifacts : "stores"

    projects {
        string slug PK
        string repo_root
        string default_branch
        string worktree_root
    }

    runs {
        string id PK
        string project_slug FK
        string issue_id
        string state
        string failure_reason
        int revision_count
        timestamp created_at
        timestamp updated_at
    }

    run_attempts {
        string id PK
        string run_id FK
        int attempt_number
        string outcome
    }

    workspaces {
        string id PK
        string run_id FK
        string worktree_path
        string branch_name
    }

    reviews {
        string id PK
        string attempt_id FK
        string outcome
    }

    review_findings {
        string id PK
        string review_id FK
        string severity
        string title
        string detail
    }

    events {
        string id PK
        string run_id FK
        string type
        timestamp created_at
    }
```

## Runtime Layout

```mermaid
graph LR
    subgraph "~/.loom/"
        subgraph data ["data/"]
            db["loom.db"]
            subgraph runs ["runs/<run-id>/"]
                bp["builder-prompt.md"]
                bl["builder.log"]
                vl["verify.log"]
                rp["review-prompt.md"]
                rl["review.log"]
                hj["handoff.json"]
            end
        end
        subgraph wt ["worktrees/"]
            pw["<project>/dev/"]
        end
    end
```

## Module Map

| Module | Path | Responsibility |
|--------|------|---------------|
| API | `src/api/` | Local HTTP endpoints for OpenClaw and operator access |
| App | `src/app/` | Daemon bootstrap, launchd lifecycle, service composition |
| CLI | `src/cli/` | Thin operator-facing wrapper over the API |
| Config | `src/config/` | Project registry, YAML config loading, zod validation |
| DB | `src/db/` | SQLite schema, migrations, repositories, event log |
| Linear | `src/linear/` | Linear API client — issue fetching and status sync |
| MCP | `src/mcp/` | MCP server adapter — primary OpenClaw integration |
| Workflow | `src/workflow/` | Run state machine, queue drain, retry/recovery |
| Runners | `src/runners/` | Codex builder (full-auto) + Claude reviewer (skip-permissions) |
| Worktrees | `src/worktrees/` | Single `dev` branch worktree per project, rebase, cleanup |
| Artifacts | `src/artifacts/` | Prompt/log/result persistence |

## V1 Stack

TypeScript · Node 22+ · Fastify · Commander · MCP SDK · @linear/sdk · SQLite · zod · execa · pino
