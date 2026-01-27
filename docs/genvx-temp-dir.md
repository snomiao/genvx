Plan A: Always use `./node_modules/.genvx`.
Pros:
- Keeps temp artifacts under dependency tree.
- Avoids cluttering project root.
Cons:
- Fails when `node_modules` does not exist (fresh repo, non-js project, CI).
- Requires extra setup when dependencies are not installed.
Best for:
- JS projects with committed or reliably present `node_modules`.

Plan B: Always use `./.genvx` in project root.
Pros:
- Works in any repo regardless of dependencies.
- Predictable location for tooling and cleanup.
Cons:
- Adds temp directory to project root.
- Requires ignoring in VCS if not already.
Best for:
- Polyglot repos or environments without `node_modules`.

Plan C (Chosen): Prefer `./node_modules/.genvx` when `node_modules` exists; otherwise use `./.genvx`.
Pros:
- Preserves current behavior for JS repos with dependencies.
- Works out of the box when `node_modules` is absent.
- Minimal change and no extra flags.
Cons:
- Temp location can change based on environment state.
Best for:
- Mixed environments (local dev vs CI), and repos that sometimes lack `node_modules`.

Decision:
Use Plan C to keep compatibility while ensuring a safe fallback.
