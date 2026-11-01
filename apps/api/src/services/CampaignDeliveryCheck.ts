import {CampaignStatus} from '@plunk/db';
import signale from 'signale';

import {prisma} from '../database/prisma.js';
import {redis} from '../database/redis.js';

import {NOT_DELIVERED_AFTER_MS} from './CampaignNotDelivered.js';
import {FailureAlertService} from './FailureAlertService.js';

// A first estimate, to review with the first real campaign of thousands
const MIN_DELIVERY_RATE = 95;
// So that a small campaign does not trip on one or two addresses
const MIN_NOT_DELIVERED = 5;
const WINDOW_END_MS = 2 * NOT_DELIVERED_AFTER_MS;
const DOMAINS_SHOWN = 3;
// Outlasts the window, and only keeps a campaign from being judged twice
const CHECKED_SECONDS = 3 * 86400;
const CHECKED_KEY = (campaignId: string) => `plunk-lite:campaign-delivery-checked:${campaignId}`;

/**
 * Plunk Lite: a campaign that delivered too little a day after it was sent, on the dashboard banner
 * and never by email. A bounce rate does not show a provider slowing the sender down, as temporary
 * bounces are not in it. Run with the check of the SES events, and judged once per campaign.
 *
 * Counted from the emails, so as not to depend on the counters' sweep, and without the SES mailbox
 * simulator, as the rates leave it out too.
 */
export const CampaignDeliveryCheck = {
  async run(): Promise<void> {
    const now = Date.now();
    const campaigns = await prisma.campaign.findMany({
      where: {
        status: CampaignStatus.SENT,
        sentAt: {gte: new Date(now - WINDOW_END_MS), lte: new Date(now - NOT_DELIVERED_AFTER_MS)},
      },
      select: {id: true, name: true, projectId: true},
    });

    for (const campaign of campaigns) {
      try {
        await this.judge(campaign);
      } catch (error) {
        // Without its key, it is judged again in 15 minutes while it is in the window
        signale.error(`[CAMPAIGN-DELIVERY] Could not check campaign ${campaign.id}:`, error);
      }
    }
  },

  async judge(campaign: {id: string; name: string; projectId: string}): Promise<void> {
    if (await redis.get(CHECKED_KEY(campaign.id))) {
      return;
    }

    const [counts] = await prisma.$queryRaw<{sent: number; delivered: number}[]>`
      SELECT count(*)::int AS "sent", count(e."deliveredAt")::int AS "delivered"
      FROM "emails" e
      WHERE e."campaignId" = ${campaign.id}::text AND e."sentAt" IS NOT NULL AND e."simulated" = false`;
    const {sent, delivered} = counts ?? {sent: 0, delivered: 0};
    const missing = sent - delivered;
    const rate = sent > 0 ? (delivered / sent) * 100 : 100;

    if (rate < MIN_DELIVERY_RATE && missing >= MIN_NOT_DELIVERED) {
      const sourceKey = `delivery:campaign:${campaign.id}`;
      await FailureAlertService.record(
        campaign.projectId,
        {sourceKey, label: campaign.name, error: await this.describe(campaign.id, rate, missing, sent)},
        {alert: false},
      );
      // `record` never throws: without its row, this is judged again rather than lost
      if ((await prisma.plunkLiteFailure.count({where: {projectId: campaign.projectId, sourceKey}})) === 0) {
        throw new Error('The delivery warning could not be recorded');
      }
    }

    await redis.set(CHECKED_KEY(campaign.id), '1', 'EX', CHECKED_SECONDS);
  },

  /** What the banner says, its first 140 characters being what it shows */
  async describe(campaignId: string, rate: number, missing: number, sent: number): Promise<string> {
    const domains = await prisma.$queryRaw<{domain: string; count: number}[]>`
      SELECT lower(split_part(c."email", '@', 2)) AS "domain", count(*)::int AS "count"
      FROM "emails" e
      JOIN "contacts" c ON c."id" = e."contactId"
      WHERE e."campaignId" = ${campaignId}::text AND e."sentAt" IS NOT NULL AND e."simulated" = false
        AND e."deliveredAt" IS NULL
      GROUP BY 1
      ORDER BY 2 DESC, 1
      LIMIT ${DOMAINS_SHOWN}`;
    const other = missing - domains.reduce((sum, {count}) => sum + count, 0);
    const breakdown = [
      ...domains.map(({domain, count}) => `${domain} ${count.toLocaleString('en-US')}`),
      ...(other > 0 ? [`other ${other.toLocaleString('en-US')}`] : []),
    ].join(', ');
    // Down, so that 94.96% does not read as the 95% it did not reach
    const shownRate = (Math.floor(rate * 10) / 10).toFixed(1);

    return `Only ${shownRate}% delivered after 24 h: ${missing.toLocaleString('en-US')} of ${sent.toLocaleString('en-US')} not. ${breakdown}.`;
  },
};
