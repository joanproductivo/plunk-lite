import {describe, expect, it} from 'vitest';

import {pickTransition} from '../workflowTransitions';

const t = (id: string, condition: unknown) => ({id, condition: condition as never});

describe('pickTransition', () => {
  it('follows the first transition with no condition', () => {
    expect(pickTransition([t('a', null), t('b', null)], {})?.id).toBe('a');
  });

  it('follows the branch the step took', () => {
    const transitions = [t('yes', {branch: 'yes'}), t('no', {branch: 'no'})];
    expect(pickTransition(transitions, {branch: 'no'})?.id).toBe('no');
    expect(pickTransition(transitions, {branch: 'yes'})?.id).toBe('yes');
  });

  it('follows an unconditional transition ahead of a later branch, in priority order', () => {
    expect(pickTransition([t('any', null), t('yes', {branch: 'yes'})], {branch: 'yes'})?.id).toBe('any');
    expect(pickTransition([t('yes', {branch: 'yes'}), t('any', null)], {branch: 'yes'})?.id).toBe('yes');
  });

  it('finds nothing for a branch with no transition, or a branch transition without a branch', () => {
    expect(pickTransition([t('yes', {branch: 'yes'})], {branch: 'no'})).toBeUndefined();
    expect(pickTransition([t('timeout', {branch: 'timeout'})], {})).toBeUndefined();
    expect(pickTransition([t('timeout', {branch: 'timeout'})], {eventReceived: true})).toBeUndefined();
    expect(pickTransition([], {branch: 'yes'})).toBeUndefined();
  });

  it('never follows any other kind of condition', () => {
    expect(pickTransition([t('fallback', {fallback: true}), t('list', ['x'])], {branch: 'x'})).toBeUndefined();
  });
});
