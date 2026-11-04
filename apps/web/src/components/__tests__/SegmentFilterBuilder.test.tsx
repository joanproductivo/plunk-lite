// @vitest-environment happy-dom
import type {FilterCondition} from '@plunk/types';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {network} from '../../lib/network';
import {SegmentFilterBuilder} from '../SegmentFilterBuilder';

(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../lib/network', () => ({network: {fetch: vi.fn()}}));

const subscribed = {field: 'subscribed', operator: 'equals', value: true} as const;
const notPro = {field: 'data.plan', operator: 'notEquals', value: 'pro'} as const;
const WARNING = 'Only contacts that have this field';
const INCLUDE = 'Include contacts without this field';

describe('SegmentFilterBuilder: contacts without the field', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.mocked(network.fetch).mockImplementation(async (_method, url) => {
      if (url === '/contacts/fields') return {fields: [{field: 'data.plan', type: 'string'}]};
      if (url === '/events/names') return {eventNames: []};
      return [];
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.mocked(network.fetch).mockReset();
  });

  const render = async (condition: FilterCondition, onChange = vi.fn()) => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(<SegmentFilterBuilder condition={condition} onChange={onChange} />));
    return onChange;
  };
  const includeButton = () =>
    Array.from(container.querySelectorAll('button')).find(button => button.textContent === INCLUDE);

  it('warns on "not equals" and lets the contacts without the field in, inside the same group', async () => {
    const onChange = await render({logic: 'AND', groups: [{filters: [subscribed, notPro]}]});

    expect(container.textContent).toContain(WARNING);
    await act(async () => includeButton()!.click());

    expect(onChange).toHaveBeenCalledWith({
      logic: 'AND',
      groups: [
        {
          filters: [subscribed],
          conditions: {
            logic: 'OR',
            groups: [{filters: [notPro]}, {filters: [{field: 'data.plan', operator: 'notExists'}]}],
          },
        },
      ],
    });
  });

  it('stops warning once those contacts are let in', async () => {
    await render({
      logic: 'AND',
      groups: [
        {
          filters: [subscribed],
          conditions: {
            logic: 'OR',
            groups: [{filters: [notPro]}, {filters: [{field: 'data.plan', operator: 'notExists'}]}],
          },
        },
      ],
    });

    expect(container.textContent).not.toContain(WARNING);
  });

  it('only explains how when the group already has a nested condition', async () => {
    await render({
      logic: 'AND',
      groups: [{filters: [notPro], conditions: {logic: 'AND', groups: [{filters: [subscribed]}]}}],
    });

    expect(container.textContent).toContain(WARNING);
    expect(container.textContent).toContain('OR this filter with "Has no value" in a nested condition');
    expect(includeButton()).toBeUndefined();
  });

  it('does not warn on a field every contact has', async () => {
    await render({logic: 'AND', groups: [{filters: [{field: 'email', operator: 'notEquals', value: 'a@b.c'}]}]});

    expect(container.textContent).not.toContain(WARNING);
  });
});
