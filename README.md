# aidr — AI diff reviewer

Reviews your local git diff with Gemini, from the terminal. Two things make it
different from the rest of the category:

**It reads the repository's memory, not just the diff.** Every AI reviewer feeds
the model the changed lines. The expensive ones also feed repo-wide semantic
context. None of them feed the history of *the exact lines you touched*. `git log`
and `git blame -L` on those line ranges give churn, prior fixes, and reverts —
signal that is local, free, instant, and sitting unused in every repository.

**Every comment has to survive an argument against itself.** Published benchmarks
put the leading tools at roughly half precision: about one comment in two is
wrong. Self-reported confidence scores don't fix that — they cluster tightly and
barely discriminate. So each candidate finding is sent back to the model with
instructions to refute it. What can't defend itself never reaches you. There is
no comment cap; the count varies with the diff, and **zero findings is a valid
and meaningful result.**

And it has **no infrastructure**. No Docker, no database, no webhook server, no
hosted account, no GitHub API, no OAuth. It reads local git and calls one HTTP
endpoint.

Because it reads git rather than a pull-request API, it isn't tied to pull
requests at all. A PR diff is just one of four sources — and the useful ones are
the two you can run *before* you push.

## Install

Requires [Bun](https://bun.sh) and a [Gemini API key](https://aistudio.google.com/apikey).

```bash
git clone https://github.com/Santhosh-Rubenraj-Solomon/ai-diff-reviewer.git
cd ai-diff-reviewer
bun install
export GEMINI_API_KEY=...
```

Run it from inside any git repository:

```bash
bun run /path/to/ai-diff-reviewer/src/cli.ts
```

Or compile a standalone binary and drop it on your `PATH`:

```bash
bun run build     # -> dist/aidr
```

## Use

```bash
aidr                    # infers what you meant from git state
aidr --staged           # git diff --cached
aidr --working          # git diff
aidr --branch main      # git diff main...HEAD
aidr --commit HEAD~1    # git show HEAD~1
aidr --verbose          # also show what verification threw out, and why
```

With no target, it infers one — staged changes, else a dirty working tree, else
this branch against its base — presents it pre-selected, and accepts on Enter.
`--yes` skips the prompt, and so does any non-TTY context, so it drops into
hooks and CI unchanged.

```
$ aidr --working --yes
Reviewing working tree — 1 file

src/paging.ts
  bug  :8  totalPages returns Infinity or NaN for invalid `size`.
       The removal of the `if (size <= 0) return 0;` check reintroduces a
       divide-by-zero error. If `size` is 0 or negative, `count / size` will
       result in `Infinity` or `NaN`, which `Math.ceil` will propagate.
       │ -  if (size <= 0) return 0;
       history: fix: off-by-one in pageSlice offset and divide-by-zero in totalPages

────────────────────────────────────────────────────────────
1 bug · 1 chunk(s) reviewed · 1 discarded by verification · 3 verification call(s)
```

That `history:` line is the differentiator doing its job: blame on the deleted
line pointed at the commit that added the guard, so the model could say this
change re-opens a bug someone already closed. The `1 discarded` is the precision
mechanism doing its job — a third finding was raised, argued against, and lost.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | No surviving bug-severity findings |
| `1` | At least one surviving bug-severity finding |
| `2` | The tool could not run |

Which makes it a pre-commit hook in one line:

```bash
# .git/hooks/pre-commit
aidr --staged --yes || exit 1
```

## How it works

```
target ─→ diff ─→ filter ─→ chunk ─→ history ─→ review ─→ verify ─→ render
```

1. **Target** — infer from git state (staged › working tree › branch vs base), confirm, or take an explicit flag.
2. **Diff** — one git command per target. That's the only difference between them.
3. **Filter** — drop binary files, lockfiles, vendored and generated paths, and any single file over the size ceiling. Excluded paths are *reported*, never silently dropped.
4. **Chunk** — one file per chunk; a large file is split along hunk boundaries so each chunk is still a valid standalone diff.
5. **History** — `git log` on the file, `git blame -L` on the touched line ranges. New files degrade to an explicit "no history available" marker that the prompt states plainly, rather than an empty section the model would fill with guesses.
6. **Review** — one Gemini call per chunk, bounded concurrency, structured JSON out. Unparseable output is retried once, then that chunk is skipped with a recorded warning.
7. **Verify** — one call per finding, instructed to argue the finding is wrong. Survivors are kept; the rest are discarded with a reason (`--verbose` shows them).
8. **Render** — grouped by file, ordered by severity, with the history basis shown where one exists.

### Design notes

**A threshold, not a cap.** An earlier design capped output at five comments. A
diff with twelve real bugs would have seven silently dropped — the same failure
mode as a reviewer who stops reading. Filtering on *survival* produces a count
that scales with the diff.

**The verification ceiling doesn't drop findings.** There is a ceiling on total
verification calls, purely so a pathological diff can't spend unbounded API
calls. Findings past it are shown flagged `[unverified]`, never hidden — and the
ceiling is spent highest-severity-first so it never runs out on nits.

**Two model settings that default to the same model.** The two-tier idea (cheap
model reads, strong model judges) is economically right, but the recall ceiling
is set entirely by the reading pass, since verification can only remove. Picking
tiers without real output to judge would be guesswork, so `--model` and
`--verify-model` are separate values that default to the same string. The option
costs nothing until there's evidence to spend it on.

**Local git over the GitHub API.** Dropping the GitHub integration removed
OAuth, token scopes, rate limits and the comment-posting path — the largest
block of work in the original concept — while making the history differentiator
*stronger*, not weaker. The reviewer/renderer seam is where a GitHub renderer
would attach later, without touching anything upstream of it.

## Configuration

Every flag has an environment variable. See [`src/config.ts`](src/config.ts).

| Variable | Default | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | — | Required |
| `AIDR_REVIEW_MODEL` | `gemini-2.5-flash` | Model for the review pass |
| `AIDR_VERIFY_MODEL` | `gemini-2.5-flash` | Model for the verify pass |
| `AIDR_CONCURRENCY` | `4` | Parallel model calls |
| `AIDR_MAX_VERIFY_CALLS` | `40` | Verification call ceiling |
| `AIDR_MAX_FILE_DIFF_BYTES` | `60000` | Above this, a file is excluded |
| `AIDR_MAX_CHUNK_BYTES` | `20000` | Above this, a file is split by hunk |
| `AIDR_LOG_DEPTH` | `20` | Commits of file history to read |
| `AIDR_CHURN_WINDOW_DAYS` | `90` | Window for the recent-churn signal |

## Development

```bash
bun test          # 38 tests over diff parsing, history parsing, ceilings, rendering
bun run typecheck # tsc --noEmit, strict
```

The model-calling paths are deliberately not mocked into the test suite; the
pure logic around them — diff parsing, chunk splitting, blame parsing, the
verification ceiling, render ordering — is covered directly.

## Not in v1

GitHub API integration, posting comments to pull requests, review caching,
incremental review from the last-reviewed commit, npm publishing, config files,
providers other than Gemini, inline line-anchored comments.

## License

MIT
