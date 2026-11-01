import {EmailSourceType} from '@plunk/db';
import type {SubscriptionChangeReason} from '@plunk/types';
import signale from 'signale';

import {prisma} from '../database/prisma.js';
import {normalizeEmail} from '../utils/emailAddress.js';

import {ContactService} from './ContactService.js';
import {EventService} from './EventService.js';
import {FailureAlertService} from './FailureAlertService.js';
import {isChosenSubscription, ON_THE_LIST} from './SesEventMatch.js';
import {SuppressionService} from './SuppressionService.js';

// In a row, in separate emails: a full mailbox can recover, and with a small list losing someone
// costs more than a few more attempts, which SES leaves out of the reputation anyway
const BOUNCES_TO_SUPPRESS = 5;
const MIN_SPAN_MS = 7 * 24 * 60 * 60 * 1000;
// The others are about the email, not the mailbox: too large, its content or attachment refused
const SUBTYPES_THAT_COUNT = ['General', 'MailboxFull'];
// Far more than a project's dead mailboxes reach the cut in a day. A provider blocking the sender
// may well read as `General` too, and must not take a whole list off with it.
const BRAKE_SUPPRESSIONS = 20;
const BRAKE_WINDOW_MS = 24 * 60 * 60 * 1000;
// More than can count after the last delivery, or the query would have no bound
const EVENTS_READ = 200;

interface SoftBounceData {
  bounceSubType?: unknown;
  softBounceAddress?: unknown;
  occurredAt?: unknown;
}

/**
 * Plunk Lite: stops mailing an address that only bounces temporarily, which SES keeps trying and
 * Plunk kept sending to for ever. Anything that shows the address works starts the count again.
 */
export class SoftBounceService {
  /** Called once the event of a soft bounce of the contact's own address is tracked */
  public static async afterSoftBounce(projectId: string, contactId: string, emailId: string): Promise<void> {
    const contact = await prisma.contact.findUnique({where: {id: contactId}, select: {email: true}});
    if (!contact || (await SuppressionService.find(projectId, contact.email))) {
      return;
    }

    if (!(await this.reachedTheCut(contactId, contact.email))) {
      return;
    }

    const suppressedToday = await prisma.plunkLiteSuppression.count({
      where: {projectId, reason: 'SOFT_BOUNCE', createdAt: {gt: new Date(Date.now() - BRAKE_WINDOW_MS)}},
    });
    if (suppressedToday >= BRAKE_SUPPRESSIONS) {
      signale.warn(`[SOFT-BOUNCE] Project ${projectId} reached ${BRAKE_SUPPRESSIONS} suppressions today: not one more`);
      await FailureAlertService.recordSoftBounceBrake(projectId, BRAKE_SUPPRESSIONS);
      return;
    }

    const unsubscribed = await prisma.$transaction(async tx => {
      await SuppressionService.record(tx, projectId, [contact.email], 'SOFT_BOUNCE', emailId);
      const flipped = await tx.contact.updateMany({
        where: {id: contactId, AND: [ON_THE_LIST]},
        data: {subscribed: false, snoozedUntil: null},
      });
      return flipped.count === 1;
    });
    signale.warn(`[SOFT-BOUNCE] ${contact.email} suppressed after repeated temporary bounces`);

    if (!unsubscribed) {
      return;
    }
    try {
      await EventService.trackEvent(projectId, 'contact.unsubscribed', contactId, emailId, {
        reason: 'soft_bounce' satisfies SubscriptionChangeReason,
      });
    } finally {
      const email = await prisma.email.findUnique({where: {id: emailId}, select: {campaignId: true}});
      if (email?.campaignId) {
        await ContactService.recordCampaignUnsubscribe(emailId, email.campaignId);
      }
    }
  }

  private static async reachedTheCut(contactId: string, address: string): Promise<boolean> {
    const since = await this.countsSince(contactId);
    const events = await prisma.event.findMany({
      where: {contactId, name: 'email.softbounce'},
      select: {emailId: true, data: true, createdAt: true, email: {select: {deliveredAt: true}}},
      orderBy: {createdAt: 'desc'},
      take: EVENTS_READ,
    });

    const emails = new Set<string>();
    let first = Infinity;
    let last = -Infinity;
    for (const event of events) {
      const data = (event.data ?? {}) as SoftBounceData;
      // One taken back from the dead-letter queue is stamped when it was, and says when it happened
      const time = typeof data.occurredAt === 'string' ? Date.parse(data.occurredAt) : event.createdAt.getTime();
      if (
        !event.emailId ||
        // Delivered and then "bounced": an autoresponder, as SES reports some of them
        event.email?.deliveredAt ||
        !Number.isFinite(time) ||
        time <= since ||
        typeof data.bounceSubType !== 'string' ||
        !SUBTYPES_THAT_COUNT.includes(data.bounceSubType) ||
        typeof data.softBounceAddress !== 'string' ||
        normalizeEmail(data.softBounceAddress) !== normalizeEmail(address)
      ) {
        continue;
      }
      emails.add(event.emailId);
      first = Math.min(first, time);
      last = Math.max(last, time);
    }

    return emails.size >= BOUNCES_TO_SUPPRESS && last - first >= MIN_SPAN_MS;
  }

  /**
   * The moment the count starts from: the latest delivery, open or click of the contact's emails,
   * the contact choosing to subscribe, or their suppression being lifted. Each says the address is
   * worth trying again. The end of a snooze says nothing, as nobody chose it just then.
   */
  private static async countsSince(contactId: string): Promise<number> {
    const [emails, lifted, subscribed] = await Promise.all([
      prisma.email.aggregate({
        where: {contactId, sourceType: {not: EmailSourceType.INBOUND}},
        _max: {deliveredAt: true, openedAt: true, clickedAt: true},
      }),
      prisma.event.findFirst({
        where: {contactId, name: 'contact.suppression_lifted'},
        select: {createdAt: true},
        orderBy: {createdAt: 'desc'},
      }),
      prisma.event.findMany({
        where: {contactId, name: 'contact.subscribed'},
        select: {data: true, createdAt: true},
        orderBy: {createdAt: 'desc'},
        take: 20,
      }),
    ]);

    const dates = [
      emails._max.deliveredAt,
      emails._max.openedAt,
      emails._max.clickedAt,
      lifted?.createdAt,
      subscribed.find(isChosenSubscription)?.createdAt,
    ];
    return Math.max(0, ...dates.map(date => date?.getTime() ?? 0));
  }
}
