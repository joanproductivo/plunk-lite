// @vitest-environment happy-dom
import {CAMPAIGN_EXCLUDED_SEGMENTS_MAX} from '@plunk/shared';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {ExcludedSegmentsField, ExcludedSegmentsSuffix} from '../campaigns/ExcludedSegmentsField';

(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

const segments = [
  {id: 's1', name: 'Buyers', type: 'STATIC'},
  {id: 's2', name: 'Leads', type: 'DYNAMIC'},
  {id: 's3', name: 'Partners', type: 'STATIC'},
  {id: 's4', name: 'Press', type: 'STATIC'},
];

vi.mock('swr', () => ({default: () => ({data: segments})}));

// The real select is a Radix popover; what matters here is which ids the field keeps out of it
vi.mock('../segments/SegmentPicker', async importOriginal => ({
  ...(await importOriginal<typeof import('../segments/SegmentPicker')>()),
  SegmentSelect: ({exclude}: {exclude: string[]}) => <div data-testid="select" data-exclude={exclude.join(',')} />,
}));

describe('ExcludedSegmentsField', () => {
  let root: Root;
  let container: HTMLDivElement;

  const render = async (node: React.ReactNode) => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(node));
  };
  const select = () => container.querySelector('[data-testid="select"]');

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('does not offer the chosen segments nor the one the campaign is sent to', async () => {
    await render(<ExcludedSegmentsField value={['s1']} onChange={vi.fn()} audienceSegmentId="s2" />);

    expect(select()?.getAttribute('data-exclude')).toBe('s1,s2');
    expect(container.textContent).toContain('Buyers');
  });

  it('shows a deleted segment and lets it be removed', async () => {
    const onChange = vi.fn();
    await render(<ExcludedSegmentsField value={['s1', 'gone']} onChange={onChange} />);

    expect(container.textContent).toContain('Deleted segment');
    const remove = container.querySelector(
      'button[aria-label="Stop leaving out Deleted segment"]',
    ) as HTMLButtonElement;
    await act(async () => remove.click());

    expect(onChange).toHaveBeenCalledWith(['s1']);
  });

  it('stops offering more once the maximum is reached', async () => {
    const full = Array.from({length: CAMPAIGN_EXCLUDED_SEGMENTS_MAX}, (_, i) => `id${i}`);
    await render(<ExcludedSegmentsField value={full} onChange={vi.fn()} />);

    expect(select()).toBeNull();
  });
});

describe('ExcludedSegmentsSuffix', () => {
  let root: Root;
  let container: HTMLDivElement;

  const text = async (ids: string[]) => {
    container = document.createElement('div');
    root = createRoot(container);
    await act(async () => root.render(<ExcludedSegmentsSuffix ids={ids} />));
    const result = container.textContent;
    await act(async () => root.unmount());
    return result;
  };

  it('names up to three segments, and counts more', async () => {
    expect(await text([])).toBe('');
    expect(await text(['s1', 's2'])).toBe(' except Buyers, Leads');
    expect(await text(['s1', 's2', 's3', 's4'])).toBe(' except 4 segments');
  });
});
