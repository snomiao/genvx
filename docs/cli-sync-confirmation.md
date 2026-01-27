Plan A: Confirm before any local file scan/copy.
Pros:
- Avoids touching the gitstore on cancel.
Cons:
- Cannot show a meaningful diff before confirmation.
Best for:
- Ultra-safe workflows where any temp change is undesirable.

Plan B: Prepare diff (clean/copy into temp gitstore), list changes, then confirm before commit/push.
Pros:
- Shows an accurate, complete change list before syncing.
- Keeps behavior aligned with existing sync flow.
Cons:
- Touches temp gitstore even if user cancels.
Best for:
- Interactive workflows needing a precise review step.

Decision:
Use Plan B so users see all env file diffs before confirming the sync.
The sync command was later removed from the CLI; confirmation remains only for the internal sync helper.

Output tweak:
- When push/pull/sync detect no env changes, print a single "." to indicate already up-to-date.
