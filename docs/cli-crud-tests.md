Plan A: CLI black-box tests using `bun cli.ts`.
Pros:
- Verifies full CLI behavior and argument parsing.
- No need to export internal helpers.
Cons:
- Harder to assert internal file layout without extra parsing.
- Requires subprocess management and longer runtime.
Best for:
- End-to-end confidence and regression tests.

Plan B: Directly test helper functions by exporting them.
Pros:
- Deterministic control of temp paths and repo state.
- Easier to assert CRUD outcomes in gitstore and local.
- Faster and less flaky in CI.
Cons:
- Exposes internal helpers as exports.
Best for:
- Focused behavior verification for temp dir selection and file sync.

Matrix extension:
- Direction axis: local-origin vs remote-origin changes.
- CRUD axis: create/read/update/delete applied at the source.
- Expectation: `sync` always converges gitstore to local state, so remote-origin changes are overwritten.

Plan C: Mixed approach with a small CLI smoke test plus helper-level tests.
Pros:
- Covers both top-level CLI wiring and internal behavior.
Cons:
- More setup and longer test runtime.
Best for:
- Mature test suite with both unit and integration layers.

Decision:
Use Plan B to cover CRUD scenarios in both temp directory locations while keeping tests reliable and fast.
