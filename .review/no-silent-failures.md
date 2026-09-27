---
id: no-silent-failures
severity: high
priority: 10
---
Silence is a bug. Anything that did not happen must reach `RunResult` and the
run summary: a file that was skipped, a rule that was dropped, a batch that
failed, a judge call that errored, a model that was substituted.

Flag:
- a `catch` block that swallows an error without pushing to `errors`,
  adding a degradation, or rethrowing.
- a code path that returns an empty result where the distinction between
  "nothing to report" and "the stage failed" is lost.
- a `skipped` / `dropped` entry created without a human-readable reason.
- a success status set on a path where a stage failed.

Do not flag:
- `.catch(() => null)` where the null is immediately turned into a recorded
  degradation or a named skip reason by the caller.
- logging at `warn` in addition to recording — that is belt and braces, not
  a substitute for recording.
- test doubles that swallow errors deliberately.

Bad:  } catch { return []; }
Good: } catch (err) { fail('stage', message(err)); return []; }
