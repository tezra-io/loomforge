# <Feature Title>

## Purpose

What someone can do after this change that they could not do before. 2-3
sentences, user/operator perspective. No jargon without definition.

## Architecture

ASCII diagram of the system or feature. Show components, data flow direction,
and boundaries. Keep it rough — clarity over beauty.

Label every box and arrow. If a component is new, mark it. If a component
exists, name the file or module path.

## Components

For each box in the diagram, one paragraph:
- What it does (responsibility)
- What it talks to (interfaces in/out)
- Where it lives (file paths if existing, proposed paths if new)

## Data Flow

Walk through the primary scenario step by step. Number each step. Name the
exact interface or function at each boundary.

## Scope

**In scope:**
- (what this design covers)

**Out of scope:**
- (what this design explicitly does not cover, and why)

## Constraints

Hard constraints that shape the design. Technical limits, security
requirements, performance budgets, compatibility needs. One bullet per
constraint with a short "why."

## Interfaces

Key types, function signatures, or API contracts that must exist. Use the
project's language. Keep to public boundaries only — internal implementation
is not design.

## Security and Privacy (optional)

Trust model, authentication, authorization, and data handling. What is
allowed, what is blocked, and how it is enforced. Include secrets management,
input validation boundaries, and any compliance requirements. Skip for
local-only or internal tooling where security is not a design concern.

## Edge Cases and Failure Modes

For each failure scenario:
- What triggers it
- What the system does (not "handle gracefully" — be specific)
- What the user/operator sees

## Open Questions

Unresolved decisions that need human input before implementation starts.
Number them. Remove resolved questions and move the decision to the relevant
section above.

## Implementation Order

Ordered list of shippable units. Each becomes a Linear issue. Include
estimated scope (S/M/L) and dependencies.
