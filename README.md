# aidr — an LLM code reviewer for GitLab and GitHub

Reviews a merge request or pull request with Claude and posts inline comments.
Deterministic code decides what the model sees; the model only judges. Every
finding that gets posted quotes code that exists, at a line that changed.

Built by **Santhosh Rubenraj Solomon**. TypeScript on Bun. MIT.

---

## Why this one

Most LLM reviewers make their guarantees in prose — "evidence must be
verbatim", "we filter low-confidence findings", "every file is reviewed" — and
enforce none of them. The failure is always the same shape: the prose says one
thing, the code does another, and nobody can tell because the tool reports
success either way.

The five rules this codebase is organised around:

1. **Deterministic code decides what the model sees; the model only judges.**
   Diff parsing, file selection, graph walks and budgets are all in code. No
   model picks which files get reviewed or how they are batched.
2. **Every published finding quotes code that exists, at a line that changed.**
   Checked in [`src/review/verify.ts`](src/review/verify.ts) against the file
   at head — in code, before posting. Not with a prompt.
3. **Silence is a bug.** A skipped file, a dropped rule, a failed batch, a
   substituted model — each appears in the run status, the summary comment and
   the exit code.
4. **Re-running converges, not accumulates.** A second run on the same commit
   posts nothing. A run after a push posts what is new and resolves what was
   fixed.
5. **Anything measured improves.** The eval harness shipped before the context
   engine, and the context engine has to beat the baseline to stay.

---

## Quick start

```bash
bun install

# Review your working tree against the merge base, post nothing:
ANTHROPIC_API_KEY=… bun run src/cli.ts review --platform=local --dry-run

# Validate your rules (exits non-zero on error — safe to gate CI on):
bun run src/cli.ts rules check

# Run the eval harness offline, with no API key at all:
bun run evals
```

A single-binary build for CI runners:

```bash
bun run build     # -> dist/aidr
```

---

## How a run works

```
intake ──► rules ──► context ──► cache ──► review ──► verify ──► judge ──► publish
   │          │         │          │          │          │         │          │
  SHA-      target    repo at    content-   batched    code-     model     inline +
 pinned     branch    head SHA   addressed  by real    only      with      one edited
 ChangeSet  only      + graph    per file   tokens     gate      the code  summary
```

| Stage | File | What it guarantees |
|---|---|---|
| intake | [`src/platform/`](src/platform/) | Everything pinned to `base`/`start`/`head` SHAs; forks read from the source project; pagination followed |
| rules | [`src/rules/load.ts`](src/rules/load.ts) | Read from the **target** branch, so an MR cannot rewrite the rules that judge it |
| context | [`src/context/`](src/context/) | Repo cached by SHA; ripple context only for symbols the diff touched |
| cache | [`src/store/db.ts`](src/store/db.ts) | Keyed on content hash + rules hash + prompt version + model — never on path |
| review | [`src/review/run.ts`](src/review/run.ts) | Structured outputs; a schema miss is a failed call, never "zero findings" |
| verify | [`src/review/verify.ts`](src/review/verify.ts) | Path, line-in-hunk, verbatim evidence, praise, confidence, duplicates |
| judge | [`src/review/judge.ts`](src/review/judge.ts) | One finding per call, **with the surrounding code** and any cited rule; Claude or a decision model |
| publish | [`src/publish/comments.ts`](src/publish/comments.ts) | Fingerprinted identity, idempotent posting, one summary edited in place |

### Exit codes

| Status | Exit | Meaning |
|---|---|---|
| `completed` | 0 | Every changed file reviewed, comments posted |
| `partial` | 0, or 1 with `--strict` | Something degraded; what survived was posted |
| `interrupted` | 1 | Model or API failure; results incomplete |
| `failed` | 1 | Precondition or unrecoverable error |

`--fail-on=high` additionally exits 1 when a finding at or above that severity
was posted. Start advisory; turn this on once you have measured precision.

---

## Configuration

Environment only — there is no config file in `$HOME`, so CI and local behave
identically. CLI flags override the environment.

| Variable | Default | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Required for a real review |
| `REVIEWER_PLATFORM` | inferred from CI | `gitlab` \| `github` \| `local` |
| `REVIEWER_TOKEN` | `GITHUB_TOKEN` | Bot token; comment scope only |
| `REVIEWER_PROJECT_ID` | CI variable | Project id, or `owner/repo` |
| `REVIEWER_MR_IID` | CI variable | MR iid / PR number |
| `REVIEWER_REVIEW_MODEL` | `claude-opus-5` | Review pass |
| `REVIEWER_JUDGE_MODEL` | `claude-sonnet-5` | Gate two; `jev-1.13` switches backend (see below) |
| `REVIEWER_JEV_API_KEY` | `TYPESAFE_API_KEY`, `OPENROUTER_API_KEY` | Only when the judge is a Jev model |
| `REVIEWER_JEV_ENDPOINT` | `https://api.typesafe.ai/v1/systemone` | Or OpenRouter / Cloudflare |
| `REVIEWER_FALLBACK_MODEL` | `claude-opus-4-8` | Used only on a refusal; `none` to disable |
| `REVIEWER_REVIEW_EFFORT` | `xhigh` | `low`…`max` |
| `REVIEWER_BUDGET_USD` | `2` | Hard per-run ceiling; posts what it has and marks the run partial |
| `REVIEWER_CONFIDENCE` | `0.6` | Verification threshold; tune on the golden set |
| `REVIEWER_DEADLINE_MS` | `900000` | Whole-run deadline |
| `REVIEWER_CONTEXT` | `full` | `full` \| `diff` \| `off` |
| `REVIEWER_JUDGE` | `on` | `on` \| `off` |

There are deliberately **no `--no-x` flags**. Use `--context=off`, not
`--no-context`: a negation flag that silently becomes a no-op is worse than no
flag at all.

---

## Rules

One markdown file per rule area in `.review/`, read from the target branch:

```markdown
---
id: payments-money-types          # stable; findings cite it
globs: ["src/payments/**/*.ts"]   # omit entirely for a global rule
severity: high
priority: 10                      # decides who survives the byte budget
---
Money is always integer minor units (`amountMinor`).

Flag: floats for money, `parseFloat` on amounts, implicit currency.
Do not flag: `amountMinor` arithmetic without a currency check inside a
single-currency module.
```

- `globs` **omitted** means global. `globs` present but empty or malformed is
  an **error**, not a promotion to global.
- Findings cite `ruleIds`, so you can measure which rules earn their tokens.
- The judge is shown the text of any rule a finding cites, so a rule-backed
  finding cannot be rejected as "generic advice".
- `aidr rules check` exits non-zero on a bad rule, an oversized rule, or a
  scoped rule that matches nothing.

This repository dogfoods its own rules in [`.review/`](.review/).

---

## Gate two can run on a decision model (experimental)

Gate two asks four bounded questions — is this real, is it about the changed
lines, is it specific, is it worth acting on. That is a classification problem,
not a generation problem, so it can run on a *decision model*:
[TypeSafe's Jev](https://openrouter.ai/docs/guides/community/jev) answers all
four in one round trip and returns **calibrated** probabilities.

```bash
REVIEWER_JUDGE_MODEL=jev-1.13 TYPESAFE_API_KEY=… bun run src/cli.ts review
```

| | `claude-sonnet-5` | `jev-1.13` |
|---|---|---|
| Per judged finding | ~$0.006 | ~$0.00004 |
| Latency | seconds | 70–500 ms |
| Output | one prose verdict | four probabilities, calibrated |
| Signal on a drop | a sentence | the failing condition and its value |

Three things this actually buys:

1. **Four signals instead of one.** A drop names the condition that failed —
   `jev: pre-existing rather than introduced here (changed=0.28)` — rather than
   one opaque keep/drop.
2. **Calibrated confidence.** The review model's `confidence` is *self-reported*
   and uncalibrated; a decision model's probability is calibrated by
   construction. Findings carry both, labelled, and the comment footer says
   which is which.
3. **No instruction channel.** The judge receives a state object and picks from
   a fixed schema — there is no prose for text inside a diff to hijack.

What it costs you: **no natural-language rationale**. Synthesising the reason
from the failing condition recovers most of it, but not all.

### Read the claims carefully

Jev is advertised as ~200× faster and ~400× cheaper than frontier models. Both
are true *per classification call*, and neither is what your bill looks like.
The review pass — which Jev structurally **cannot** do, because findings need a
generated title, body and verbatim evidence — dominates the cost:

| | today | with a Jev judge |
|---|---|---|
| Review pass (Opus 5) | $0.40 | $0.40 |
| Judge, 20 findings | $0.12 | $0.0008 |
| **Per merge request** | **~$0.52** | **~$0.40** |

So: about a fifth off the bill, plus ~25 s of wall clock. The real gain is that
verification you could not previously justify becomes free — more conditions per
finding, and an always-on semantic matcher in the evals instead of token overlap.

Also worth keeping straight: "never hallucinates" means **output is always
in-schema** (0% structured-output error), not that answers are correct. A
confidently wrong `drop` silently kills a real bug, which is precisely why this
is off by default and gated on measurement. TypeSafe's own benchmark puts Jev at
67.8% against GPT-5.6 Terra's 67.9% on four workflows — nothing about code-review
judging, and gate two arguably needs System *Two* reasoning.

**So measure it before trusting it.** That is what the harness is for:

```bash
bun run evals --reviewer=model --judge=off
bun run evals --reviewer=model --judge=claude-sonnet-5
bun run evals --reviewer=model --judge=jev-1.13
```

Compare precision and noise/case on the **holdout** half. Adopt only if
precision holds. Same discipline as gating the context engine on measurement.

One thing deliberately *not* built: Jev is a tempting fit for triaging which
files to review, and that is the reference tool's worst bug — an allow-list that
silently drops files and reports them as reviewed. Cheap inference does not fix
that; it just makes a bad idea affordable.

## Evals

The harness ships before the features it measures, and runs entirely on frozen
fixtures — no platform API, nothing posted.

```bash
bun run evals                       # stub reviewer, offline, no API key
bun run evals --reviewer=model      # real review pass
bun run evals --reviewer=model --mode=batch   # Batch API, ~50% cheaper
bun run evals --split=holdout       # report on the held-out half only
```

The set has two halves:

- **Curated cases** in [`evals/cases/`](evals/cases/) — each labelled with
  `expected` (findings a human made or would have made) and `forbidden` (noise
  you never want again).
- **Injected bugs** — 20 single-line mutations generated from clean fixtures by
  [`evals/mutate.ts`](evals/mutate.ts): off-by-one, dropped `await`, swapped
  arguments, inverted guard, wrong unit, removed authorisation, SQL built by
  concatenation, lost update. Recall on these is a number you control.

Reported per variant, split train/holdout:

| Metric | Starting target |
|---|---|
| Recall on injected bugs | ≥ 0.6 |
| Precision (lower bound) | ≥ 0.7 |
| Noise per case | ≤ 1 |
| Cost per case p50/p90 | ≤ $0.50 |
| Latency p90 | ≤ 4 min |

> **The six curated cases are seeds, not a golden set.** They are hand-written
> illustrations. A set that means something is built from your own merge
> requests. `bun run evals/import.ts --platform=github --project=owner/repo
> --pr=412 --split=train` freezes a real MR into a fixture; you then fill in
> `expected` and `forbidden` by hand. Get to 15–20 real cases before trusting a
> precision number, and tune on `train` while reporting on `holdout`.

---

## CI

### GitLab

```yaml
llm-review:
  stage: review
  image: oven/bun:1
  rules:
    - if: $CI_PIPELINE_SOURCE == 'merge_request_event'
  interruptible: true
  allow_failure: true          # advisory until you have measured precision
  script:
    - bunx @santhosh/ai-diff-reviewer review
```

`ANTHROPIC_API_KEY` and `REVIEWER_TOKEN` are masked CI variables; everything
else is read from the standard `CI_*` variables.

### GitHub

See [`.github/workflows/review.yml`](.github/workflows/review.yml).

Roll out in stages: `--dry-run` for a week (findings in the job log only), then
your own MRs, then opt-in repositories, then default on — still advisory.

---

## Security

- Secrets are redacted from diffs and file bodies **before** any model call,
  and the count of redactions is recorded.
- All merge-request content is wrapped in `<untrusted_input>` tags, and the
  system prompt states that nothing inside them is an instruction.
- Rules come from the protected target branch, so the author of a change
  cannot supply the rules that judge it.
- Comment bodies are neutralised: GitLab quick actions at the start of a line
  are escaped and `@mentions` are broken, outside fenced code.
- Raw model output is written to disk only behind `--debug-dir`.
- Run state lives in a project-local SQLite file, not in `os.tmpdir()` keyed by
  MR number where two projects collide.

Use a bot account whose token can comment but cannot approve or merge.

---

## Known limits

- **The context engine is lexical, not a full parse.** `src/context/parse.ts`
  extracts imports, exports and symbol ranges with regexes and brace balancing
  for TypeScript/JavaScript and Python. It is an approximation, it is named in
  every run's degradations (`context-analyzer:lexical-js`), and `Analyzer` is
  an interface so tree-sitter can replace it without touching the pipeline. It
  is deliberately not a native dependency that returns nothing when a grammar
  fails to load.
- **Six curated eval cases, not fifteen.** See the note above.
- **GitHub thread resolution needs GraphQL**, which this uses; a thread whose
  id cannot be resolved gets a reply saying it was fixed and a recorded warning.
- **Model-requested file reads are not implemented.** The path allow-list, the
  deny-list and the repo confinement are in `src/review/secrets.ts` ready for
  it, but the tool feature itself is not wired up.

---

## Development

```bash
bun test              # 101 tests
bunx tsc --noEmit     # strict, no implicit any, no unchecked index access
bun run evals         # offline
bun run src/cli.ts rules check
```
