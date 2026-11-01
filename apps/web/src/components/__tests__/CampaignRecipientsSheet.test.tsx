// @vitest-environment happy-dom
import type {CampaignRecipient} from '@plunk/types';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {SWRConfig} from 'swr';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {CampaignRecipientsSheet, deliveryReason, describeNotDelivered} from '../CampaignRecipientsSheet';

(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('next/link', () => ({
  default: ({href, children, ...props}: {href: string; children: React.ReactNode}) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

const HOUR = 3600_000;

describe('describeNotDelivered', () => {
  const ago = (hours: number) => new Date(Date.now() - hours * HOUR);

  it('does not call it final while SES can still be trying', () => {
    expect(describeNotDelivered({notDeliveredCount: 1950, notSentCount: 0}, ago(1))).toBe(
      '1,950 emails not confirmed as delivered yet.',
    );
  });

  it('says it plainly after that', () => {
    expect(describeNotDelivered({notDeliveredCount: 1, notSentCount: 0}, ago(25))).toBe(
      '1 email was not confirmed as delivered.',
    );
    expect(describeNotDelivered({notDeliveredCount: 12, notSentCount: 0}, ago(25))).toBe(
      '12 emails were not confirmed as delivered.',
    );
  });

  it('keeps the emails that never left apart', () => {
    expect(describeNotDelivered({notDeliveredCount: 12, notSentCount: 50}, ago(25))).toBe(
      '12 emails were not confirmed as delivered. 50 emails were not sent.',
    );
    expect(describeNotDelivered({notDeliveredCount: 0, notSentCount: 1}, ago(1))).toBe('1 email was not sent.');
  });
});

describe('deliveryReason', () => {
  it.each([
    [{state: 'soft_bounce', detail: 'MailboxFull'}, 'Mailbox full'],
    [{state: 'soft_bounce', detail: 'General'}, 'Temporary bounce'],
    [{state: 'soft_bounce', detail: 'Undetermined'}, 'Undetermined'],
    [{state: 'soft_bounce', detail: null}, 'Temporary bounce'],
    [{state: 'pending', detail: null}, 'SES may still be trying'],
    [{state: 'no_answer', detail: null}, 'No answer from SES'],
    [{state: 'suppressed', detail: null}, 'On the SES suppression list'],
    [{state: 'failed', detail: 'Rejected by SES: Bad content'}, 'Rejected by SES: Bad content'],
    [{state: 'not_sent', detail: 'Contact is unsubscribed'}, 'Not sent: Contact is unsubscribed'],
  ] as [NonNullable<CampaignRecipient['delivery']>, string][])('reads %j', (delivery, reason) => {
    expect(deliveryReason(delivery)).toBe(reason);
  });
});

describe('CampaignRecipientsSheet', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('shows why an email was not delivered, instead of a date', async () => {
    const data: CampaignRecipient[] = [
      {
        emailId: 'e1',
        contactId: 'c1',
        email: 'full@example.com',
        occurredAt: '2026-11-01T10:00:00.000Z',
        delivery: {state: 'soft_bounce', detail: 'MailboxFull'},
      },
    ];
    const fetcher = vi.fn(async () => ({data, hasMore: false, total: 1}));

    await act(async () => {
      root.render(
        <SWRConfig value={{fetcher, provider: () => new Map(), dedupingInterval: 0}}>
          <CampaignRecipientsSheet campaignId="c" type="not_delivered" onClose={() => {}} />
        </SWRConfig>,
      );
    });

    expect(fetcher).toHaveBeenCalledWith('/campaigns/c/recipients?type=not_delivered&limit=50');
    const text = document.body.textContent ?? '';
    expect(text).toContain('Not delivered');
    expect(text).toContain('1 email has no confirmed delivery');
    expect(text).toContain('full@example.com');
    expect(text).toContain('Mailbox full');
    expect(text).not.toMatch(/ago/);
  });
});
