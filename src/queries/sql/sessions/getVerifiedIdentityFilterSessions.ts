import { COLLECTION_TRUST_TIER, OPERATORS } from '@/lib/constants';
import { IdentitySearchTooBroadError } from '@/lib/identity-search-error';
import prisma from '@/lib/prisma';
import { LINKED_QUERY_TIMEOUT_MS, MAX_AUTH_SESSION_ROWS } from '@/lib/share-query-budget';
import type { Operator } from '@/lib/types';

const ROW_LIMIT = MAX_AUTH_SESSION_ROWS + 1;

export async function getVerifiedIdentityFilterSessions(
  websiteId: string,
  operator: Operator,
  value: string | string[],
): Promise<string[]> {
  const positiveOperator =
    operator === OPERATORS.notEquals
      ? OPERATORS.equals
      : operator === OPERATORS.doesNotContain
        ? OPERATORS.contains
        : operator === OPERATORS.notRegex
          ? OPERATORS.regex
          : operator;
  const conditions: Partial<Record<Operator, string>> = {
    [OPERATORS.equals]: 'distinct_id = ANY({{value}})',
    [OPERATORS.contains]: 'distinct_id ilike {{value}}',
    [OPERATORS.regex]: 'distinct_id ~* {{value}}',
  };
  const condition = conditions[positiveOperator];

  if (!condition) {
    throw new Error('INVALID_IDENTITY_FILTER');
  }

  const isEquality = operator === OPERATORS.equals || operator === OPERATORS.notEquals;
  const isSubstring = operator === OPERATORS.contains || operator === OPERATORS.doesNotContain;

  if (
    (isEquality && !(Array.isArray(value) || typeof value === 'string')) ||
    (!isEquality && typeof value !== 'string') ||
    (Array.isArray(value) && !value.every(item => typeof item === 'string'))
  ) {
    throw new Error('INVALID_IDENTITY_FILTER');
  }

  const resolvedValue = isEquality
    ? Array.isArray(value)
      ? value
      : [value]
    : isSubstring
      ? `%${value}%`
      : value;
  const rows = await prisma.rawQuery(
    `select session_id as "sessionId"
     from session_link
     where website_id = {{websiteId::uuid}}
       and trust_tier = ${COLLECTION_TRUST_TIER.backendAuthorized}
       ${positiveOperator === operator ? `and ${condition}` : ''}
     group by session_id
     ${positiveOperator === operator ? '' : `having count(*) filter (where ${condition}) = 0`}
     limit {{rowLimit}}`,
    { websiteId, value: resolvedValue, rowLimit: ROW_LIMIT },
    'getVerifiedIdentityFilterSessions',
    LINKED_QUERY_TIMEOUT_MS,
  );

  if (rows.length >= ROW_LIMIT) {
    throw new IdentitySearchTooBroadError();
  }

  return (rows as { sessionId: string }[]).map(({ sessionId }) => sessionId);
}
