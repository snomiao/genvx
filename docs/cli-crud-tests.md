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
- Easier to assert push/pull outcomes in gitstore and local.
- Faster and less flaky in CI.
Cons:
- Exposes internal helpers as exports.
Best for:
- Focused behavior verification for temp dir selection and file transfer.

Matrix extension:
- Axis 1: temp dir selection (with vs without `node_modules`).
- Axis 2: command intent (push vs pull vs sync).
- Expectation: push/pull are one-way, and sync is pull then push.

Plan C: Mixed approach with a small CLI smoke test plus helper-level tests.
Pros:
- Covers both top-level CLI wiring and internal behavior.
Cons:
- More setup and longer test runtime.
Best for:
- Mature test suite with both unit and integration layers.

Decision:
Use Plan B to cover CRUD scenarios in both temp directory locations while keeping tests reliable and fast.
