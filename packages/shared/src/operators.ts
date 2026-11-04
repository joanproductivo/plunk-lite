/**
 * Operator Behavior Documentation
 *
 * This file documents the consistent behavior of operators across the entire application.
 * These operators are used in:
 * - Segment filtering (SegmentService)
 * - Workflow CONDITION steps (WorkflowExecutionService)
 *
 * IMPORTANT: Both implementations MUST behave identically for consistency, except where noted
 * (rule 12).
 */

/**
 * All supported operators
 */
export const OPERATORS = {
  // String operators
  EQUALS: 'equals',
  NOT_EQUALS: 'notEquals',
  CONTAINS: 'contains',
  NOT_CONTAINS: 'notContains',

  // Numeric operators
  GREATER_THAN: 'greaterThan',
  LESS_THAN: 'lessThan',
  GREATER_THAN_OR_EQUAL: 'greaterThanOrEqual',
  LESS_THAN_OR_EQUAL: 'lessThanOrEqual',

  // Existence operators
  EXISTS: 'exists',
  NOT_EXISTS: 'notExists',

  // Temporal operators (segments only)
  WITHIN: 'within',
} as const;

/**
 * Operators available for segments
 */
export const SEGMENT_OPERATORS = [
  OPERATORS.EQUALS,
  OPERATORS.NOT_EQUALS,
  OPERATORS.CONTAINS,
  OPERATORS.NOT_CONTAINS,
  OPERATORS.GREATER_THAN,
  OPERATORS.LESS_THAN,
  OPERATORS.GREATER_THAN_OR_EQUAL,
  OPERATORS.LESS_THAN_OR_EQUAL,
  OPERATORS.EXISTS,
  OPERATORS.NOT_EXISTS,
  OPERATORS.WITHIN,
] as const;

/**
 * Operators available for workflow conditions
 * Note: 'within' is NOT supported in workflow conditions
 */
export const WORKFLOW_CONDITION_OPERATORS = [
  OPERATORS.EQUALS,
  OPERATORS.NOT_EQUALS,
  OPERATORS.CONTAINS,
  OPERATORS.NOT_CONTAINS,
  OPERATORS.GREATER_THAN,
  OPERATORS.LESS_THAN,
  OPERATORS.GREATER_THAN_OR_EQUAL,
  OPERATORS.LESS_THAN_OR_EQUAL,
  OPERATORS.EXISTS,
  OPERATORS.NOT_EXISTS,
] as const;

/**
 * Operator Behavior Rules
 *
 * CRITICAL: These rules apply to BOTH SegmentService and WorkflowExecutionService
 *
 * 1. EQUALS (=)
 *    - Matches when actualValue === expectedValue
 *    - CAN match null/undefined if expectedValue is also null/undefined
 *    - String fields: case-insensitive (email)
 *    - Boolean fields: strict comparison
 *
 * 2. NOT_EQUALS (≠)
 *    - ONLY matches when field EXISTS and actualValue !== expectedValue
 *    - Does NOT match missing fields (undefined/null)
 *    - Use notExists operator if you want to find missing fields
 *    - Use OR[notEquals, notExists] if you want both
 *    - Segments: every data.* comparison but equals/notEquals null requires its key first, so it is
 *      never NULL and a notMemberOfSegment of a dynamic segment counts contacts without the key as
 *      outside it
 *
 * 3. CONTAINS (substring)
 *    - ONLY matches when field EXISTS and contains substring
 *    - Does NOT match missing fields (undefined/null)
 *    - String fields: case-insensitive (email)
 *    - Converts values to strings before comparison
 *
 * 4. NOT_CONTAINS (not substring)
 *    - ONLY matches when field EXISTS and does NOT contain substring
 *    - Does NOT match missing fields (undefined/null)
 *    - Use notExists operator if you want to find missing fields
 *    - Use OR[notContains, notExists] if you want both
 *
 * 5. GREATER_THAN (>)
 *    - ONLY matches when field EXISTS and Number(actualValue) > Number(expectedValue)
 *    - Does NOT match missing fields (undefined/null)
 *    - Converts values to numbers before comparison
 *
 * 6. LESS_THAN (<)
 *    - ONLY matches when field EXISTS and Number(actualValue) < Number(expectedValue)
 *    - Does NOT match missing fields (undefined/null)
 *    - Converts values to numbers before comparison
 *
 * 7. GREATER_THAN_OR_EQUAL (≥)
 *    - ONLY matches when field EXISTS and Number(actualValue) >= Number(expectedValue)
 *    - Does NOT match missing fields (undefined/null)
 *    - Converts values to numbers before comparison
 *
 * 8. LESS_THAN_OR_EQUAL (≤)
 *    - ONLY matches when field EXISTS and Number(actualValue) <= Number(expectedValue)
 *    - Does NOT match missing fields (undefined/null)
 *    - Converts values to numbers before comparison
 *
 * 9. EXISTS
 *    - Matches when actualValue !== undefined && actualValue !== null
 *    - Matches empty strings, zero, false (these are valid existing values)
 *
 * 10. NOT_EXISTS
 *     - Matches when actualValue === undefined || actualValue === null
 *     - Does NOT match empty strings, zero, or false
 *
 * 11. WITHIN (temporal - segments only)
 *     - Matches when date field is within specified time period
 *     - Requires unit: 'days' | 'hours' | 'minutes'
 *     - Example: within 7 days = createdAt >= (now - 7 days)
 *
 * 12. DATES (workflow conditions)
 *     - When both values are dates (YYYY-MM-DD, with an optional time), EQUALS, NOT_EQUALS and the
 *       numeric operators compare them as instants instead of the rules above
 *     - An expected value without a time is the whole day in UTC: greaterThan = after that day,
 *       lessThanOrEqual = up to its end
 *     - A time without a zone is UTC, not the server's local time
 *     - contact.createdAt and contact.updatedAt are ISO dates; updatedAt changes with any write to
 *       the contact, including an earlier step of the same workflow
 *     - Segments compare data.* dates as text, and contact dates from midnight UTC, so a day in a
 *       greaterThan or lessThanOrEqual can give a different result there
 *
 * Segments refuse a value their query cannot compare with a 400: a data.* range value that is not a
 * text or a number, a time window that is not a number of units of up to 100 years, a contact date
 * that is not a date, and a contains/notContains or email value that is not a text, a number or
 * true/false.
 */

/**
 * Example: Finding contacts without a field vs with a different value
 *
 * To find contacts where plan is NOT "basic":
 * - Use: { field: 'data.plan', operator: 'notEquals', value: 'basic' }
 * - Result: Matches contacts with plan='premium', plan='free', etc.
 * - Does NOT match: Contacts without plan field
 *
 * To find contacts WITHOUT a plan field:
 * - Use: { field: 'data.plan', operator: 'notExists' }
 * - Result: Matches contacts where plan is undefined or null
 *
 * To find contacts where plan is NOT "basic" OR plan doesn't exist:
 * - Use: OR[
 *     { field: 'data.plan', operator: 'notEquals', value: 'basic' },
 *     { field: 'data.plan', operator: 'notExists' }
 *   ]
 * - Result: Matches all except contacts with plan='basic'
 */
