import {describe, expect, it} from 'vitest';

import {
  conditionFieldMayBeMissing,
  fieldsIncludedWhenMissing,
  filterIncludingMissing,
  includeMissingField,
  leavesOutMissingField,
  segmentName,
} from '../segments';

describe('segmentName', () => {
  const segments = [
    {id: 'a', name: 'Customers'},
    {id: 'b', name: 'Free workshop'},
  ];

  it('is the name of the segment with that id', () => {
    expect(segmentName(segments, 'b')).toBe('Free workshop');
  });

  it('marks a segment that is gone as deleted', () => {
    expect(segmentName(segments, 'c')).toBe('Deleted segment');
  });

  it('is a placeholder while the segments load', () => {
    expect(segmentName(undefined, 'a')).toBe('…');
  });
});

describe('leavesOutMissingField', () => {
  it.each([
    ['data.plan', 'notEquals', true],
    ['data.plan', 'notContains', true],
    ['data.plan', 'equals', false],
    ['data.plan', 'notExists', false],
    ['email', 'notEquals', false],
  ] as const)('%s %s → %s', (field, operator, expected) => {
    expect(leavesOutMissingField({field, operator, value: 'pro'})).toBe(expected);
  });
});

describe('conditionFieldMayBeMissing', () => {
  it.each([
    ['contact.data.plan', true],
    ['data.plan', true],
    ['event.amount', true],
    ['workflow.amount', true],
    ['contact.email', false],
    ['contact.subscribed', false],
    ['segment.abc', false],
  ])('%s → %s', (field, expected) => {
    expect(conditionFieldMayBeMissing(field)).toBe(expected);
  });
});

describe('includeMissingField', () => {
  const subscribed = {field: 'subscribed', operator: 'equals', value: true} as const;
  const notPro = {field: 'data.plan', operator: 'notEquals', value: 'pro'} as const;

  it('ORs the filter with its field having no value, inside the same group', () => {
    expect(includeMissingField({filters: [subscribed, notPro]}, 1)).toEqual({
      filters: [subscribed],
      conditions: {
        logic: 'OR',
        groups: [{filters: [notPro]}, {filters: [{field: 'data.plan', operator: 'notExists'}]}],
      },
    });
  });

  it('leaves a group that already has a nested condition as it is', () => {
    const group = {filters: [notPro], conditions: {logic: 'AND' as const, groups: [{filters: [subscribed]}]}};
    expect(includeMissingField(group, 0)).toBe(group);
  });
});

describe('fieldsIncludedWhenMissing', () => {
  const notPro = {field: 'data.plan', operator: 'notEquals', value: 'pro'} as const;
  const noPlan = {field: 'data.plan', operator: 'notExists'} as const;

  it('is what includeMissingField adds', () => {
    const {conditions} = includeMissingField({filters: [notPro]}, 0);
    expect(fieldsIncludedWhenMissing(conditions!)).toEqual(new Set(['data.plan']));
  });

  it('ignores an AND condition and a group with other filters', () => {
    expect(fieldsIncludedWhenMissing({logic: 'AND', groups: [{filters: [notPro]}, {filters: [noPlan]}]}).size).toBe(0);
    expect(
      fieldsIncludedWhenMissing({
        logic: 'OR',
        groups: [{filters: [notPro]}, {filters: [noPlan, {field: 'subscribed', operator: 'equals', value: true}]}],
      }).size,
    ).toBe(0);
  });
});

describe('filterIncludingMissing', () => {
  const notPro = {field: 'data.plan', operator: 'notEquals', value: 'pro'} as const;

  it('finds the filter includeMissingField nested', () => {
    const {conditions} = includeMissingField({filters: [notPro]}, 0);
    expect(filterIncludingMissing(conditions!)).toEqual(notPro);
  });

  it('is null for any other condition', () => {
    const noVip = {field: 'data.vip', operator: 'notExists'} as const;
    expect(filterIncludingMissing({logic: 'OR', groups: [{filters: [notPro]}, {filters: [noVip]}]})).toBeNull();
    expect(
      filterIncludingMissing({
        logic: 'AND',
        groups: [{filters: [notPro]}, {filters: [{field: 'data.plan', operator: 'notExists'}]}],
      }),
    ).toBeNull();
  });
});
