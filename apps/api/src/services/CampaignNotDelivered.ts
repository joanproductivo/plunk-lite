import {EmailStatus, Prisma} from '@plunk/db';
import {NOT_DELIVERED_AFTER_MS} from '@plunk/shared';
import type {CampaignDeliveryState} from '@plunk/types';

import {prisma} from '../database/prisma.js';

import {POSSIBLY_SENT_NOTE} from './EmailService.js';

const ERROR_SHOWN = 300;

// The same rule as `left` in `describe` below: the figures and the reasons of the list must agree
const NEVER_LEFT = Prisma.sql`e."status" = 'FAILED' AND e."sentAt" IS NULL AND e."messageId" IS NULL
  AND COALESCE(e."error", '') NOT LIKE ${`%${POSSIBLY_SENT_NOTE}%`}`;

/**
 * Plunk Lite: the emails of a campaign with no confirmed delivery, of `emails` as `e`. Left out, what
 * has an answer: a delivery, an open or click (it arrived, and the delivery event is what is missing),
 * and a bounce or complaint with its date, which have their own figures. The statuses keep this on the
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
   * and an address Plunk itself holds back is not a problem of delivery.
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
        bouncedAt: true,
        complainedAt: true,
        // Tracked as `email.bounce`, marked transient, before `email.softbounce` existed
        events: {
          where: {name: {in: ['email.softbounce', 'email.bounce']}},
          select: {name: true, data: true},
          orderBy: {createdAt: 'desc'},
        },
      },
    });

    const details = new Map<string, {state: CampaignDeliveryState; detail: string | null}>();
    for (const email of emails) {
      const detail = describe(email);
      if (detail) {
        details.set(email.id, detail);
      }
    }
    return details;
  },
};

function describe(email: {
  status: EmailStatus;
  error: string | null;
  sentAt: Date | null;
  messageId: string | null;
  bouncedAt: Date | null;
  complainedAt: Date | null;
  events: {name: string; data: Prisma.JsonValue}[];
}): {state: CampaignDeliveryState; detail: string | null} | null {
  if (email.status === EmailStatus.FAILED) {
    const left = email.sentAt || email.messageId || email.error?.includes(POSSIBLY_SENT_NOTE);
    return {state: left ? 'failed' : 'not_sent', detail: email.error?.slice(0, ERROR_SHOWN) ?? null};
  }
  if (
    (email.status === EmailStatus.BOUNCED && !email.bouncedAt) ||
    (email.status === EmailStatus.COMPLAINED && !email.complainedAt)
  ) {
    return {state: 'suppressed', detail: null};
  }
  // An event that came in since the list read this row: it has an answer now, and no reason to give
  if (email.status !== EmailStatus.SENT) {
    return null;
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
