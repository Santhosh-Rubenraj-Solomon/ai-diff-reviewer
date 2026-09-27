---
id: verification-stays-deterministic
globs: ["src/review/verify.ts", "src/publish/**/*.ts"]
severity: critical
priority: 20
---
`verify.ts` is the only gate that decides whether a finding is real enough to
post, and it must stay free of model calls. Every published finding quotes code
that exists at a line that changed, and that is checked here in code — never by
a prompt and never by a second model.

Flag:
- any import of an SDK client, `ReviewRunner`, or a prompt module into
  `verify.ts`.
- a check that is described in a comment or prompt but not actually performed
  (evidence matching, line-in-hunk, confidence threshold, duplicate detection).
- a drop that does not record a reason on the finding.
- fingerprinting on a title, a title prefix, or a lowercased substring rather
  than on path + normalised evidence + category.

Do not flag:
- whitespace normalisation of evidence before comparison; that is intended.
- correcting a line number when the evidence is found elsewhere in the file
  and the corrected line is inside a hunk.
- the judge in `judge.ts` calling a model — that is gate two, by design.
