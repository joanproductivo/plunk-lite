// @vitest-environment happy-dom
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {OptOutTopicField, templateTypeDescription} from '../templates/OptOutTopicField';

(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

const picker = vi.hoisted(() => ({exclude: undefined as string[] | undefined}));

vi.mock('../segments/SegmentPicker', () => ({
  useSegments: () => ({data: [{id: 's1', name: 'EXCLUIR', type: 'STATIC'}]}),
  useSegmentName: () => (id: string) => (id === 's1' ? 'EXCLUIR' : 'Deleted segment'),
  SegmentChip: ({name}: {name: string}) => <span>{name}</span>,
  SegmentSelect: ({exclude}: {exclude: string[]}) => {
    picker.exclude = exclude;
    return <span>picker</span>;
  },
}));

/** Plunk Lite: the opt-out topic field, with a campaign's texts */
describe('OptOutTopicField for a campaign', () => {
  let root: Root;
  let container: HTMLDivElement;

  const render = async (props: Partial<Parameters<typeof OptOutTopicField>[0]>) => {
    await act(async () =>
      root.render(
        <OptOutTopicField owner="campaign" type="TRANSACTIONAL" value={null} body="" onChange={() => {}} {...props} />,
      ),
    );
  };
  const text = () => container.textContent ?? '';

  beforeEach(() => {
    picker.exclude = undefined;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('speaks of the campaign, with a topic, removing it, gone, and without one', async () => {
    await render({value: 's1'});
    expect(text()).toContain('This campaign is not sent to its members');
    expect(text()).not.toContain('template');

    await render({value: null, saved: 's1'});
    expect(text()).toContain('Contacts who opted out of EXCLUIR will get this campaign once you save.');
    expect(text()).toContain('stops this kind of email for whoever opts out');

    await render({value: 'gone'});
    expect(text()).toContain('so this campaign cannot be sent');

    await render({type: 'MARKETING', body: '<a href="{{optOutUrl}}">x</a>'});
    expect(text()).toContain('only works in a transactional campaign with one');
  });

  it('keeps the audience segment out of the picker', async () => {
    await render({exclude: ['s2']});

    expect(picker.exclude).toEqual(['s2']);
  });

  it('describes the type card of a campaign', () => {
    expect(templateTypeDescription(true, 'campaign')).toBe(
      'Transactional campaigns skip the subscription check and the footer, except the notices footer of their opt-out topic.',
    );
    expect(templateTypeDescription(false)).toBe('Transactional templates skip the subscription check and the footer.');
  });
});
