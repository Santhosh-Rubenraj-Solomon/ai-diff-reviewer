/**
 * Loads `.review/**\/*.md` rules from the *target* branch.
 *
 * Three failure modes this refuses to have:
 *   - a malformed `globs:` line quietly becoming "applies everywhere";
 *   - an oversized rule file vanishing without a word;
 *   - directory order deciding which rules survive the byte budget.
 */

import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { Rule, RuleLoadResult, Severity } from '../types.ts';
import type { Platform } from '../platform/types.ts';
import { sha256 } from '../publish/fingerprint.ts';

const FrontmatterSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'must be lowercase kebab-case'),
  globs: z.array(z.string().min(1)).min(1).optional(),
  severity: z.enum(['critical', 'high', 'medium', 'low']).optional(),
  priority: z.number().int().optional(),
});

export interface ParsedRuleFile {
  frontmatter: unknown;
  body: string;
  /** True when the document had no `---` frontmatter block at all. */
  missingFrontmatter: boolean;
  /** True when the frontmatter explicitly contained a `globs` key. */
  declaredGlobs: boolean;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseRuleFile(text: string): ParsedRuleFile {
  const match = FRONTMATTER.exec(text);
  if (!match) {
    return { frontmatter: null, body: text.trim(), missingFrontmatter: true, declaredGlobs: false };
  }
  const yamlText = match[1]!;
  const frontmatter = parseYaml(yamlText) as unknown;
  const declaredGlobs =
    typeof frontmatter === 'object' && frontmatter !== null && 'globs' in frontmatter;
  return {
    frontmatter,
    body: text.slice(match[0].length).trim(),
    missingFrontmatter: false,
    declaredGlobs,
  };
}

export interface LoadOptions {
  rulesDir: string;
  fileMaxBytes: number;
  totalMaxBytes: number;
}

export async function loadRules(platform: Platform, opts: LoadOptions): Promise<RuleLoadResult> {
  const errors: RuleLoadResult['errors'] = [];
  const dropped: RuleLoadResult['dropped'] = [];

  const prefix = opts.rulesDir.replace(/\/$/, '');
  const paths = (await platform.listTargetBranchTree(prefix))
    .filter((path) => path.endsWith('.md'))
    .sort();

  const candidates: Rule[] = [];
  const seen = new Map<string, string>();

  for (const path of paths) {
    const text = await platform.fetchFileFromTargetBranch(path);
    if (text === null) {
      errors.push({ sourcePath: path, message: 'could not be read from the target branch' });
      continue;
    }

    let parsed: ParsedRuleFile;
    try {
      parsed = parseRuleFile(text);
    } catch (err) {
      errors.push({
        sourcePath: path,
        message: `frontmatter is not valid YAML: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    if (parsed.missingFrontmatter) {
      errors.push({ sourcePath: path, message: 'missing `---` frontmatter block' });
      continue;
    }

    const result = FrontmatterSchema.safeParse(parsed.frontmatter);
    if (!result.success) {
      const detail = result.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      // A rule whose scope failed to parse is rejected, never promoted to global.
      errors.push({ sourcePath: path, message: `invalid frontmatter — ${detail}` });
      continue;
    }

    const fm = result.data;
    if (parsed.declaredGlobs && !fm.globs) {
      errors.push({
        sourcePath: path,
        message: '`globs` was declared but is empty or malformed; refusing to treat it as global',
      });
      continue;
    }
    if (parsed.body.length === 0) {
      errors.push({ sourcePath: path, message: 'rule body is empty' });
      continue;
    }

    const previous = seen.get(fm.id);
    if (previous) {
      errors.push({ sourcePath: path, message: `duplicate rule id \`${fm.id}\` (also in ${previous})` });
      continue;
    }
    seen.set(fm.id, path);

    const bytes = Buffer.byteLength(parsed.body, 'utf8');
    if (bytes > opts.fileMaxBytes) {
      dropped.push({
        id: fm.id,
        sourcePath: path,
        reason: `rule is ${bytes} bytes, over the ${opts.fileMaxBytes} byte per-file limit`,
      });
      continue;
    }

    candidates.push({
      id: fm.id,
      globs: fm.globs ?? [],
      global: !parsed.declaredGlobs,
      severity: (fm.severity ?? 'medium') as Severity,
      priority: fm.priority ?? 0,
      body: parsed.body,
      sourcePath: path,
      bytes,
    });
  }

  // Deterministic order: declared priority first, then id. Never directory order.
  candidates.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));

  const rules: Rule[] = [];
  let total = 0;
  for (const rule of candidates) {
    if (total + rule.bytes > opts.totalMaxBytes) {
      dropped.push({
        id: rule.id,
        sourcePath: rule.sourcePath,
        reason: `total rule budget of ${opts.totalMaxBytes} bytes exhausted`,
      });
      continue;
    }
    total += rule.bytes;
    rules.push(rule);
  }

  const rulesHash = sha256(
    [...rules]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((rule) => `${rule.id}:${sha256(rule.body)}`)
      .join('\n'),
  );

  return { rules, errors, dropped, rulesHash };
}
