/**
 * Injected bugs — the half of the golden set where recall is a number you control.
 *
 * Each mutation is a single-line edit to a clean fixture, so the expected line
 * is known exactly rather than guessed at. Twenty of them give a recall figure
 * that actually moves when the prompt or the context engine changes.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EvalCase } from './case.ts';

export interface Mutation {
  id: string;
  fixture: string;
  /** Destination path inside the synthetic change set. */
  path: string;
  kind: string;
  find: string;
  /** null deletes the matched line. */
  replace: string | null;
  expected: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
}

export const MUTATIONS: Mutation[] = [
  // ---- payments/refund.ts -------------------------------------------------
  {
    id: 'refund-bound-off-by-one',
    fixture: 'payments-refund.ts.txt',
    path: 'src/payments/refund.ts',
    kind: 'off-by-one',
    find: '  if (request.amountMinor > remainingMinor) {',
    replace: '  if (request.amountMinor >= remainingMinor) {',
    expected: 'a refund of exactly the remaining refundable amount is now rejected',
    severity: 'high',
  },
  {
    id: 'ledger-record-await-dropped',
    fixture: 'payments-refund.ts.txt',
    path: 'src/payments/refund.ts',
    kind: 'dropped-await',
    find: '  await ledger.record({',
    replace: '  ledger.record({',
    expected: 'the ledger write is no longer awaited, so a failure is unobserved and the refund can be recorded after the response',
    severity: 'high',
  },
  {
    id: 'idempotency-check-disabled',
    fixture: 'payments-refund.ts.txt',
    path: 'src/payments/refund.ts',
    kind: 'idempotency',
    find: '  if (existing) {',
    replace: '  if (false) {',
    expected: 'the idempotency lookup is dead code, so a retry issues a second refund',
    severity: 'critical',
  },
  {
    id: 'currency-unit-divided',
    fixture: 'payments-refund.ts.txt',
    path: 'src/payments/refund.ts',
    kind: 'wrong-unit',
    find: '  const refundId = await gateway.refund(order.transactionId, request.amountMinor);',
    replace: '  const refundId = await gateway.refund(order.transactionId, request.amountMinor / 100);',
    expected: 'the gateway is called with major units while everything else uses minor units',
    severity: 'critical',
  },
  {
    id: 'gateway-args-swapped',
    fixture: 'payments-refund.ts.txt',
    path: 'src/payments/refund.ts',
    kind: 'swapped-arguments',
    find: '  const refundId = await gateway.refund(order.transactionId, request.amountMinor);',
    replace: '  const refundId = await gateway.refund(request.amountMinor, order.transactionId);',
    expected: 'the transaction id and the amount are passed in the wrong order',
    severity: 'critical',
  },
  {
    id: 'currency-guard-inverted',
    fixture: 'payments-refund.ts.txt',
    path: 'src/payments/refund.ts',
    kind: 'inverted-condition',
    find: '  if (order.currency !== request.currency) {',
    replace: '  if (order.currency === request.currency) {',
    expected: 'the currency guard is inverted, so matching currencies throw and mismatched ones proceed',
    severity: 'critical',
  },
  {
    id: 'order-null-check-inverted',
    fixture: 'payments-refund.ts.txt',
    path: 'src/payments/refund.ts',
    kind: 'null-check',
    find: '  if (!order) {',
    replace: '  if (order) {',
    expected: 'the null check is inverted, so a missing order falls through and is dereferenced',
    severity: 'critical',
  },

  // ---- auth/session.ts ----------------------------------------------------
  {
    id: 'expiry-branch-inverted',
    fixture: 'auth-session.ts.txt',
    path: 'src/auth/session.ts',
    kind: 'inverted-condition',
    find: '  if (isExpired) {',
    replace: '  if (!isExpired) {',
    expected: 'expired sessions are accepted and valid ones rejected',
    severity: 'critical',
  },
  {
    id: 'auth-check-removed',
    fixture: 'auth-session.ts.txt',
    path: 'src/auth/session.ts',
    kind: 'missing-authorisation',
    find: "  assertAuthorized(session.role, 'account:delete');",
    replace: null,
    expected: 'the authorisation check before deleting an account was removed',
    severity: 'critical',
  },
  {
    id: 'expiry-comparison-flipped',
    fixture: 'auth-session.ts.txt',
    path: 'src/auth/session.ts',
    kind: 'wrong-comparison',
    find: '  const isExpired = session.expiresAt <= Date.now();',
    replace: '  const isExpired = session.expiresAt >= Date.now();',
    expected: 'the expiry comparison is backwards',
    severity: 'critical',
  },
  {
    id: 'revoked-check-flipped',
    fixture: 'auth-session.ts.txt',
    path: 'src/auth/session.ts',
    kind: 'inverted-condition',
    find: '  if (session.revoked === true) {',
    replace: '  if (session.revoked === false) {',
    expected: 'revoked sessions are now accepted and live sessions rejected',
    severity: 'critical',
  },
  {
    id: 'revoke-await-dropped',
    fixture: 'auth-session.ts.txt',
    path: 'src/auth/session.ts',
    kind: 'dropped-await',
    find: '  await sessions.revokeAllForUser(targetUserId);',
    replace: '  sessions.revokeAllForUser(targetUserId);',
    expected: 'session revocation is not awaited, so it can fail silently after the account is deleted',
    severity: 'high',
  },
  {
    id: 'delete-wrong-user',
    fixture: 'auth-session.ts.txt',
    path: 'src/auth/session.ts',
    kind: 'wrong-variable',
    find: '  await users.remove(targetUserId);',
    replace: '  await users.remove(session.userId);',
    expected: 'the caller is deleted instead of the requested target user',
    severity: 'critical',
  },

  // ---- orders/batch.ts ----------------------------------------------------
  {
    id: 'loop-bound-off-by-one',
    fixture: 'orders-batch.ts.txt',
    path: 'src/orders/batch.ts',
    kind: 'off-by-one',
    find: '  for (let index = 0; index < lines.length; index += 1) {',
    replace: '  for (let index = 0; index <= lines.length; index += 1) {',
    expected: 'the loop runs one past the end and dereferences undefined',
    severity: 'high',
  },
  {
    id: 'sql-string-concatenation',
    fixture: 'orders-batch.ts.txt',
    path: 'src/orders/batch.ts',
    kind: 'injection',
    find: "    'SELECT order_id, sku, quantity, unit_price_minor FROM order_lines WHERE order_id = ANY($1)',",
    replace:
      "    'SELECT order_id, sku, quantity, unit_price_minor FROM order_lines WHERE order_id = ' + orderIds[0],",
    expected: 'the query is built by string concatenation instead of a bound parameter',
    severity: 'critical',
  },
  {
    id: 'transaction-escaped',
    fixture: 'orders-batch.ts.txt',
    path: 'src/orders/batch.ts',
    kind: 'transaction',
    find: '      const order = await tx.findOrder(orderId);',
    replace: '      const order = await db.findOrder(orderId);',
    expected: 'the read escapes the transaction, so it can see uncommitted or stale state',
    severity: 'high',
  },
  {
    id: 'archive-await-dropped',
    fixture: 'orders-batch.ts.txt',
    path: 'src/orders/batch.ts',
    kind: 'dropped-await',
    find: '        await tx.archive(orderId);',
    replace: '        tx.archive(orderId);',
    expected: 'the archive write is not awaited inside the transaction',
    severity: 'high',
  },
  {
    id: 'status-condition-inverted',
    fixture: 'orders-batch.ts.txt',
    path: 'src/orders/batch.ts',
    kind: 'inverted-condition',
    find: "      if (order.status === 'completed') {",
    replace: "      if (order.status !== 'completed') {",
    expected: 'incomplete orders are archived and completed ones are left alone',
    severity: 'critical',
  },
  {
    id: 'total-uses-addition',
    fixture: 'orders-batch.ts.txt',
    path: 'src/orders/batch.ts',
    kind: 'wrong-operator',
    find: '    total += line.quantity * line.unitPriceMinor;',
    replace: '    total += line.quantity + line.unitPriceMinor;',
    expected: 'quantity and unit price are added instead of multiplied',
    severity: 'critical',
  },
  {
    id: 'map-entry-overwritten',
    fixture: 'orders-batch.ts.txt',
    path: 'src/orders/batch.ts',
    kind: 'lost-update',
    find: '      existing.push(row);',
    replace: '      byOrder.set(row.order_id, [row]);',
    expected: 'each new line replaces the accumulated lines instead of appending',
    severity: 'high',
  },
];

export interface AppliedMutation {
  mutation: Mutation;
  original: string;
  mutated: string;
  /** 1-based line number of the change in the mutated file. */
  line: number;
  diff: string;
}

const CONTEXT = 3;

export function applyMutation(source: string, mutation: Mutation): AppliedMutation | null {
  const lines = source.split('\n');
  const index = lines.findIndex((line) => line === mutation.find);
  if (index === -1) return null;

  const mutatedLines = [...lines];
  if (mutation.replace === null) mutatedLines.splice(index, 1);
  else mutatedLines[index] = mutation.replace;

  return {
    mutation,
    original: source,
    mutated: mutatedLines.join('\n'),
    line: mutation.replace === null ? Math.max(1, index) : index + 1,
    diff: unifiedDiffForSingleLine(lines, index, mutation.replace),
  };
}

/** A minimal, exact unified diff for one replaced or deleted line. */
export function unifiedDiffForSingleLine(
  oldLines: string[],
  index: number,
  replacement: string | null,
): string {
  const start = Math.max(0, index - CONTEXT);
  const end = Math.min(oldLines.length - 1, index + CONTEXT);

  const before = oldLines.slice(start, index);
  const after = oldLines.slice(index + 1, end + 1);

  const body: string[] = [
    ...before.map((line) => ` ${line}`),
    `-${oldLines[index]!}`,
    ...(replacement === null ? [] : [`+${replacement}`]),
    ...after.map((line) => ` ${line}`),
  ];

  const oldCount = before.length + 1 + after.length;
  const newCount = before.length + (replacement === null ? 0 : 1) + after.length;

  return [`@@ -${start + 1},${oldCount} +${start + 1},${newCount} @@`, ...body].join('\n');
}

export async function buildMutationCases(cleanDir: string): Promise<EvalCase[]> {
  const sources = new Map<string, string>();
  const cases: EvalCase[] = [];
  const missing: string[] = [];

  for (const mutation of MUTATIONS) {
    let source = sources.get(mutation.fixture);
    if (source === undefined) {
      source = await readFile(join(cleanDir, mutation.fixture), 'utf8');
      sources.set(mutation.fixture, source);
    }

    const applied = applyMutation(source, mutation);
    if (!applied) {
      missing.push(mutation.id);
      continue;
    }

    cases.push({
      id: `injected-${mutation.id}`,
      // Injected bugs are split deterministically by position so the holdout
      // half is never the half a prompt was tuned against.
      split: cases.length % 2 === 0 ? 'train' : 'holdout',
      source: `mutation:${mutation.kind}`,
      title: `Injected ${mutation.kind} in ${mutation.path}`,
      description: 'Synthetic change generated by evals/mutate.ts.',
      targetBranch: 'main',
      headSha: '0'.repeat(40),
      files: [
        {
          path: mutation.path,
          status: 'modified',
          diff: applied.diff,
          headContent: applied.mutated,
        },
      ],
      expected: [
        {
          path: mutation.path,
          line: applied.line,
          description: mutation.expected,
          severity: mutation.severity,
          injected: true,
        },
      ],
      forbidden: [],
      stubFindings: [],
    });
  }

  if (missing.length > 0) {
    // A mutation whose anchor line drifted is a broken eval, not a silent skip.
    throw new Error(
      `these mutations no longer match their fixture (anchor line changed?): ${missing.join(', ')}`,
    );
  }

  return cases;
}
