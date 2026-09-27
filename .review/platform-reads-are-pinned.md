---
id: platform-reads-are-pinned
globs: ["src/platform/**/*.ts"]
severity: critical
priority: 15
---
Every read from a hosted platform is pinned to an explicit SHA, and fork merge
requests read from the source project. Reading by branch name mixes commits
when someone pushes mid-review; reading from the target project on a fork
reviews code that is not in the change.

Flag:
- a content or archive fetch whose `ref` is a branch name when a SHA is
  available on the ChangeSet.
- a fetch of the merge request or pull request inside a per-file loop (the
  N+1); it is fetched once and passed down.
- a list endpoint consumed without following its pagination cursor.
- a post failure that returns a falsy value instead of throwing or recording.

Do not flag:
- `fetchFileFromTargetBranch` and `listTargetBranchTree` reading by branch:
  rules deliberately come from the protected target branch, not from a SHA in
  the merge request.
- the local adapter reading from the working tree; that is its contract.
