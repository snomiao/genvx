Plan A: Keep sync and add smarter conflict detection.
Pros:
- Retains a single "do everything" command.
- Potentially reduces user steps.
Cons:
- Requires heuristics that can still be wrong.
- Higher risk of overwriting intentional deletions.
Best for:
- Teams willing to accept auto-merge behavior.

Plan B: Remove sync and keep explicit push/pull.
Pros:
- Clear intent: user chooses direction.
- Avoids ambiguous delete/remote-add conflicts.
- Simpler mental model and safer default.
Cons:
- Requires an explicit choice each time.
Best for:
- Users who need deterministic behavior.

Plan C: Keep sync as an advanced/hidden flag.
Pros:
- Power users still have access.
Cons:
- Adds maintenance burden and ambiguity.
- Still leaves a footgun in the CLI.
Best for:
- Backward compatibility with legacy workflows.

Decision:
Initially chose Plan B, then added `sync` back as an explicit pull-then-push convenience command.
