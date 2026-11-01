import {EmailStatus, Prisma} from '@plunk/db';
import type {CampaignDeliveryState} from '@plunk/types';

import {prisma} from '../database/prisma.js';

import {POSSIBLY_SENT_NOTE} from './EmailService.js';

/** How long SES can still be trying. Measured once: it gave up on a mailbox after 14 hours. */
export const NOT_DELIVERED_AFTER_MS = 24 * 60 * 60 * 1000;

const ERROR_SHOWN = 300;

const NEVER_LEFT = Prisma.sql`e."status" = 'FAILED' AND e."sentAt" IS NULL AND e."messageId" IS NULL
  AND COALESCE(e."error", '') NOT LIKE ${`%${POSSIBLY_SENT_NOTE}%`}`;

/**
 * Plunk Lite: the emails of a campaign with no confirmed delivery, of `emails` as `e`. Left out, what
 * has an answer: a delivery, an open or click (it arrived, and the delivery event is what is missing),
 * and a bounce or complaint with its date, which have their own lists. The statuses keep this on the
 * (campaignId, status) index, so its cost follows these emails and not the size of the campaign.
 *
 * A row failed as possibly sent keeps its status whatever comes back for it, hence the dates on FAILED.
 */
export const NOT_DELIVERED_FILTER = Prisma.sql`e."deliveredAt" IS NULL AND e."status" IN ('SENT', 'BOUNCED', 'COMPLAINED', 'FAILED')
  AND (e."status" <> 'BOUNCED' OR e."bouncedAt" IS NULL)
  AND (e."status" <> 'COMPLAINED' OR e."complainedAt" IS NULL)
  AND (e."status" <> 'FAILED' OR (e."bouncedAt" IS NULL AND e."complainedAt" IS NULL AND e."openedAt" IS NULL AND e."clickedAt" IS NULL))`;

export const CampaignNotDelivered = {
  /**
   * How many left with no confirmed delivery, and how many never left: those are not in `sentCount`,
   * and a suppressed address is not a problem of delivery.
   */
  async counts(campaignId: string): Promise<{notDelivered: number; notSent: number}> {
    const [row] = await prisma.$queryRaw<{notDelivered: number; notSent: number}[]>`
      SELECT (count(*) FILTER (WHERE NOT (${NEVER_LEFT})))::int AS "notDelivered",
             (count(*) FILTER (WHERE ${NEVER_LEFT}))::int AS "notSent"
      FROM "emails" e
      WHERE e."campaignId" = ${campaignId}::text AND ${NOT_DELIVERED_FILTER}`;
    return row ?? {notDelivered: 0, notSent: 0};
  },

  /** Why each of these emails, one page of the list, has no confirmed delivery */
  async details(emailIds: string[]): Promise<Map<string, {state: CampaignDeliveryState; detail: string | null}>> {
    const emails = await prisma.email.findMany({
      where: {id: {in: emailIds}},
      select: {
        id: true,
        status: true,
        error: true,
        sentAt: true,
        messageId: true,
        // Tracked as `email.bounce`, marked transient, before `email.softbounce` existed
        events: {
          where: {name: {in: ['email.softbounce', 'email.bounce']}},
          select: {name: true, data: true},
          orderBy: {createdAt: 'desc'},
        },
      },
    });

    return new Map(emails.map(email => [email.id, describe(email)]));
  },
};

function describe(email: {
  status: EmailStatus;
  error: string | null;
  sentAt: Date | null;
  messageId: string | null;
  events: {name: string; data: Prisma.JsonValue}[];
}): {state: CampaignDeliveryState; detail: string | null} {
  if (email.status === EmailStatus.FAILED) {
    const left = email.sentAt || email.messageId || email.error?.includes(POSSIBLY_SENT_NOTE);
    return {state: left ? 'failed' : 'not_sent', detail: email.error?.slice(0, ERROR_SHOWN) ?? null};
  }
  if (email.status !== EmailStatus.SENT) {
    return {state: 'suppressed', detail: null};
  }

  for (const event of email.events) {
    const data = (event.data ?? {}) as {transientBounce?: unknown; bounceSubType?: unknown};
    if (event.name === 'email.softbounce' || data.transientBounce === true) {
      return {state: 'soft_bounce', detail: typeof data.bounceSubType === 'string' ? data.bounceSubType : null};
    }
  }

  const stillTrying = email.sentAt !== null && Date.now() - email.sentAt.getTime() < NOT_DELIVERED_AFTER_MS;
  return {state: stillTrying ? 'pending' : 'no_answer', detail: null};
}
