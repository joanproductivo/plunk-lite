import {describe, expect, it} from 'vitest';

import {includeMissingField} from '../../lib/segments';
import {segmentRuleText} from '../SegmentRuleSummary';

describe('segmentRuleText', () => {
  it('reads what "Include contacts without this field" builds as one rule', () => {
    const group = includeMissingField(
      {
        filters: [
          {field: 'subscribed', operator: 'equals', value: true},
          {field: 'data.plan', operator: 'notEquals', value: 'pro'},
        ],
      },
      1,
    );

    expect(segmentRuleText({logic: 'AND', groups: [group]}, new Map())).toBe('Subscribed AND plan ≠ pro or no value');
  });
});
