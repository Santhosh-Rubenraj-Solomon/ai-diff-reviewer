---
id: no-hand-rolled-matching
globs: ["src/**/*.ts"]
severity: high
priority: 5
---
Globs go through `picomatch`, YAML through `yaml`, and token counts through
`messages.countTokens`. Hand-rolled versions of these fail quietly: a
glob-to-regex converter where `*` cannot cross `/` produces rules that match
nothing and say nothing, and a `chars / 4` token estimate produces budgets that
do not hold.

Flag:
- a new glob-to-`RegExp` conversion, or `String.prototype.includes` used as a
  path matcher where a glob is meant.
- a token count derived from string length for anything that feeds a budget or
  a batching decision.
- hand-written YAML or unified-diff parsing outside `src/diff/parse.ts`.

Do not flag:
- `src/diff/parse.ts` itself; the diff parser is deliberately ours and is
  covered by tests.
- length-based heuristics used only for logging, display, or a pre-filter that
  a real count later confirms.
- the lexical analyzer in `src/context/parse.ts`, which is a documented
  approximation with a named fallback.
