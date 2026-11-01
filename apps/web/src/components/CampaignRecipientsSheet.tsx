import {NOT_DELIVERED_AFTER_MS} from '@plunk/shared';
import type {CampaignRecipient, CampaignRecipientType, CursorPaginatedResponse} from '@plunk/types';
import {Button, Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, Skeleton} from '@plunk/ui';
import {AlertCircle, ChevronRight} from 'lucide-react';
import Link from 'next/link';
import {useState} from 'react';
import useSWR from 'swr';

import {formatFullDateTime, formatRelativeTime} from '../lib/dateUtils';

const COPY: Record<CampaignRecipientType, {title: string; empty: string; describe: (total: number) => string}> = {
  bounced: {
    title: 'Bounced',
    empty: 'No address bounced on this campaign.',
    describe: total =>
      `${total.toLocaleString()} ${total === 1 ? 'address' : 'addresses'} could not be delivered to. Each one is now unsubscribed.`,
  },
  complained: {
    title: 'Spam reports',
    empty: 'Nobody reported this campaign as spam.',
    describe: total =>
      `${total.toLocaleString()} ${total === 1 ? 'recipient' : 'recipients'} moved this to spam. Each one is now unsubscribed.`,
  },
  unsubscribed: {
    title: 'Unsubscribed',
    empty: 'Nobody unsubscribed from this campaign.',
    describe: total =>
      `${total.toLocaleString()} ${total === 1 ? 'recipient' : 'recipients'} opted out from this campaign, including any who snoozed.`,
  },
  not_delivered: {
    title: 'Not delivered',
    empty: 'Every email of this campaign was delivered, or is in another list.',
    describe: total => `${total.toLocaleString()} ${total === 1 ? 'email has' : 'emails have'} no confirmed delivery.`,
  },
};

/** The kinds of temporary bounce SES names that read better in words; the rest show as they come */
const BOUNCE_SUBTYPES: Record<string, string> = {
  General: 'Temporary bounce',
  MailboxFull: 'Mailbox full',
  MessageTooLarge: 'Email too large',
  ContentRejected: 'Content rejected',
  AttachmentRejected: 'Attachment rejected',
};

/** Why an email has no confirmed delivery, for its row in the list */
export function deliveryReason({state, detail}: NonNullable<CampaignRecipient['delivery']>): string {
  switch (state) {
    case 'soft_bounce':
      return detail ? (BOUNCE_SUBTYPES[detail] ?? detail) : 'Temporary bounce';
    case 'pending':
      return 'SES may still be trying';
    case 'no_answer':
      return 'No answer from SES';
    case 'suppressed':
      return 'On the SES suppression list';
    case 'failed':
      return detail ?? 'Failed';
    case 'not_sent':
      return detail ? `Not sent: ${detail}` : 'Not sent';
  }
}

const countOf = (count: number) => `${count.toLocaleString()} ${count === 1 ? 'email' : 'emails'}`;

/** The line that opens the list, on the campaign's results */
export function describeNotDelivered(
  {notDeliveredCount, notSentCount}: {notDeliveredCount: number; notSentCount: number},
  sentAt: string | Date | null,
): string {
  // Right after a send, nearly everything is unconfirmed
  const stillArriving = sentAt !== null && Date.now() - new Date(sentAt).getTime() < NOT_DELIVERED_AFTER_MS;
  const parts: string[] = [];
  if (notDeliveredCount > 0) {
    parts.push(
      stillArriving
        ? `${countOf(notDeliveredCount)} not confirmed as delivered yet.`
        : `${countOf(notDeliveredCount)} ${notDeliveredCount === 1 ? 'was' : 'were'} not confirmed as delivered.`,
    );
  }
  if (notSentCount > 0) {
    parts.push(`${countOf(notSentCount)} ${notSentCount === 1 ? 'was' : 'were'} not sent.`);
  }
  return parts.join(' ');
}

const PAGE_SIZE = 50;

const pageKey = (campaignId: string, type: CampaignRecipientType, cursor?: string) =>
  `/campaigns/${campaignId}/recipients?type=${type}&limit=${PAGE_SIZE}${
    cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''
  }`;

interface CampaignRecipientsSheetProps {
  campaignId: string;
  /** Null closes the sheet. The type doubles as the open state so the two cannot disagree. */
  type: CampaignRecipientType | null;
  onClose: () => void;
}

/**
 * The "who" behind a campaign's bounce and spam figures, and (Plunk Lite) behind its emails with
 * no confirmed delivery, each with why.
 *
 * Pages accumulate rather than replace each other: this list is read looking for
 * particular addresses, and a reader six pages deep should not lose them to a seventh.
 * The cursors reset when the sheet closes, so reopening always starts from current data.
 */
export function CampaignRecipientsSheet({campaignId, type, onClose}: CampaignRecipientsSheetProps) {
  return (
    <Sheet open={type !== null} onOpenChange={open => !open && onClose()}>
      <SheetContent className="p-0">
        {/* Keyed, and unmounted entirely while closed, so the pages a reader loaded are
            discarded when they leave. Switching from Bounced to Spam reports is a new
            list, not the old one resuming from the old one's cursor. */}
        {type && <RecipientList key={`${campaignId}:${type}`} campaignId={campaignId} type={type} />}
      </SheetContent>
    </Sheet>
  );
}

function RecipientList({campaignId, type}: {campaignId: string; type: CampaignRecipientType}) {
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const copy = COPY[type];
  const lastCursor = cursors[cursors.length - 1];

  // The newest page, read here for the header count and the Load more button. `RecipientPage`
  // requests the same key for its rows, and SWR serves both from one cache entry, so this
  // costs no extra request.
  const {data: newest, error, isLoading} = useSWR<CursorPaginatedResponse<CampaignRecipient>>(
    pageKey(campaignId, type, lastCursor),
    {revalidateOnFocus: false},
  );

  const isFirstLoad = isLoading && cursors.length === 1;

  // Only meaningful on the first page: a later page coming back empty means the reader
  // reached the end, not that anything is missing.
  // `not_delivered` counts its rows rather than reading a counter, so it cannot disagree this way.
  const isMissingRows =
    type !== 'not_delivered' && cursors.length === 1 && (newest?.total ?? 0) > 0 && newest?.data.length === 0;

  return (
    <>
      <SheetHeader>
        <SheetTitle>{copy.title}</SheetTitle>
        <SheetDescription>
          {/* The count belongs in the header only when there is one worth stating; at zero
              the body carries the message, and repeating it here says it twice. */}
          {!newest ? 'Loading recipients' : (newest.total ?? 0) > 0 ? copy.describe(newest.total ?? 0) : 'Nothing to list.'}
        </SheetDescription>
      </SheetHeader>

      <div className="flex-1 overflow-y-auto">
        {error && (
          <div className="flex items-start gap-3 p-6 text-sm text-red-700">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            Couldn{"'"}t load this list. Close the panel and open it again.
          </div>
        )}

        {isFirstLoad && (
          <div className="space-y-5 p-6">
            {Array.from({length: 8}).map((_, i) => (
              <div key={i} className="space-y-2">
                <Skeleton className="h-4 w-56" />
                <Skeleton className="h-3 w-20" />
              </div>
            ))}
          </div>
        )}

        {!error && !isFirstLoad && (newest?.total ?? 0) === 0 && (
          <p className="p-6 text-sm text-neutral-500">{copy.empty}</p>
        )}

        {/*
          The figure counts recipients this campaign lost; the list reads the emails that
          carry them. Those can disagree: deleting a contact takes their email rows away and
          the counter only follows at the next sweep, or never for an opt-out deleted before
          that was kept in step. A few rows are also in no list. Saying so is the only honest option: an empty panel under a
          header promising 209 addresses reads as a broken screen.
        */}
        {!error && !isFirstLoad && isMissingRows && (
          <p className="p-6 text-sm text-neutral-500">
            There is nobody left to list: these contacts may have been deleted from the project
            since. The figure can still count them.
          </p>
        )}

        {!error && (
          <ul className="divide-y divide-neutral-100">
            {cursors.map(cursor => (
              <RecipientPage key={cursor ?? 'first'} campaignId={campaignId} type={type} cursor={cursor} />
            ))}
          </ul>
        )}
      </div>

      {newest?.hasMore && newest.cursor && (
        <div className="border-t border-neutral-100 p-4">
          <Button variant="outline" className="w-full" onClick={() => setCursors(previous => [...previous, newest.cursor as string])}>
            Load more
          </Button>
        </div>
      )}
    </>
  );
}

/**
 * One page of rows, keyed by the cursor that produced it. Split out so appending a page
 * costs one request for that page rather than refetching everything already on screen.
 */
function RecipientPage({
  campaignId,
  type,
  cursor,
}: {
  campaignId: string;
  type: CampaignRecipientType;
  cursor?: string;
}) {
  const {data} = useSWR<CursorPaginatedResponse<CampaignRecipient>>(pageKey(campaignId, type, cursor), {
    revalidateOnFocus: false,
  });

  return (
    <>
      {data?.data.map(recipient => (
        <li key={recipient.emailId}>
          <Link
            href={`/contacts/${recipient.contactId}`}
            className="group flex items-center gap-3 px-6 py-3 transition-colors hover:bg-neutral-50"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-neutral-900">{recipient.email}</span>
              {recipient.delivery && (
                <span className="block truncate text-xs text-neutral-500" title={deliveryReason(recipient.delivery)}>
                  {deliveryReason(recipient.delivery)}
                </span>
              )}
            </span>
            {/* The emails of a campaign were all created at once: here it would read as when it failed */}
            {!recipient.delivery && (
              <span
                className="shrink-0 text-xs tabular-nums text-neutral-500"
                title={formatFullDateTime(new Date(recipient.occurredAt))}
              >
                {formatRelativeTime(recipient.occurredAt)}
              </span>
            )}
            <ChevronRight className="h-4 w-4 shrink-0 text-neutral-300 transition-colors group-hover:text-neutral-500" />
          </Link>
        </li>
      ))}
    </>
  );
}
