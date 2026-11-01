import type {Prisma} from '@plunk/db';
import {NOT_DELIVERED_AFTER_MS} from '@plunk/shared';
import {beforeEach, describe, expect, it} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {CampaignNotDelivered} from '../CampaignNotDelivered';
import {CampaignService} from '../CampaignService';
import {POSSIBLY_SENT_NOTE} from '../EmailService';

/**
 * Plunk Lite: the emails of a campaign with no confirmed delivery. Each state below is what the send
 * path or the SES webhook leaves on the row.
 */
describe('CampaignNotDelivered', () => {
  const prisma = getPrismaClient();
  let projectId: string;
  let campaignId: string;

  beforeEach(async () => {
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
    const campaign = await factories.createCampaign({projectId, name: 'Not delivered', status: 'SENT'});
    campaignId = campaign.id;
  });

  async function emailTo(address: string, stamps: Partial<Prisma.EmailUncheckedCreateInput> = {}) {
    const contact = await factories.createContact({projectId, email: address, subscribed: true});
    return prisma.email.create({
      data: {
        projectId,
        contactId: contact.id,
        campaignId,
        subject: 'Hi',
        body: '<p>Hi</p>',
        from: 'hello@plunk.test',
        sourceType: 'CAMPAIGN',
        status: 'SENT',
        sentAt: new Date(),
        ...stamps,
      },
    });
  }

  const softBounce = (emailId: string, name: string, data: Prisma.InputJsonValue) =>
    prisma.event.create({data: {projectId, emailId, name, data}});

  const listed = async () => {
    const {data} = await CampaignService.listRecipients(projectId, campaignId, 'not_delivered');
    return Object.fromEntries(data.map(row => [row.email, row.delivery]));
  };

  it('says why each email has no confirmed delivery', async () => {
    const hours = (n: number) => new Date(Date.now() - n * 3600_000);
    await emailTo('pending@plunk.test', {sentAt: hours(23)});
    await emailTo('silent@plunk.test', {sentAt: hours(25)});
    const full = await emailTo('full@plunk.test', {sentAt: hours(25)});
    await softBounce(full.id, 'email.softbounce', {bounceType: 'Transient', bounceSubType: 'MailboxFull'});
    // Before the subtype was kept, and before `email.softbounce` existed
    const old = await emailTo('old@plunk.test');
    await softBounce(old.id, 'email.softbounce', {bounceType: 'Transient', transientBounce: true});
    const older = await emailTo('older@plunk.test');
    await softBounce(older.id, 'email.bounce', {bounceType: 'Transient', transientBounce: true});
    await emailTo('bounce-list@plunk.test', {status: 'BOUNCED'});
    await emailTo('complaint-list@plunk.test', {status: 'COMPLAINED'});
    await emailTo('rejected@plunk.test', {status: 'FAILED', error: 'Rejected by SES: Bad content'});
    await emailTo('maybe@plunk.test', {
      status: 'FAILED',
      sentAt: null,
      error: `The email ${POSSIBLY_SENT_NOTE}: timeout`,
    });
    await emailTo('taken@plunk.test', {status: 'FAILED', sentAt: null, messageId: 'ses-1', error: 'Lost'});
    await emailTo('suppressed@plunk.test', {
      status: 'FAILED',
      sentAt: null,
      error: 'Address is suppressed after a bounce',
    });
    await emailTo('unsubscribed@plunk.test', {status: 'FAILED', sentAt: null, error: 'Contact is unsubscribed'});

    expect(await listed()).toEqual({
      'pending@plunk.test': {state: 'pending', detail: null},
      'silent@plunk.test': {state: 'no_answer', detail: null},
      'full@plunk.test': {state: 'soft_bounce', detail: 'MailboxFull'},
      'old@plunk.test': {state: 'soft_bounce', detail: null},
      'older@plunk.test': {state: 'soft_bounce', detail: null},
      'bounce-list@plunk.test': {state: 'suppressed', detail: null},
      'complaint-list@plunk.test': {state: 'suppressed', detail: null},
      'rejected@plunk.test': {state: 'failed', detail: 'Rejected by SES: Bad content'},
      'maybe@plunk.test': {state: 'failed', detail: `The email ${POSSIBLY_SENT_NOTE}: timeout`},
      'taken@plunk.test': {state: 'failed', detail: 'Lost'},
      'suppressed@plunk.test': {state: 'not_sent', detail: 'Address is suppressed after a bounce'},
      'unsubscribed@plunk.test': {state: 'not_sent', detail: 'Contact is unsubscribed'},
    });
    expect(await CampaignNotDelivered.counts(campaignId)).toEqual({notDelivered: 10, notSent: 2});
  });

  it('leaves out what has an answer, and what has not left yet', async () => {
    const now = new Date();
    // A temporary bounce can follow the delivery: an out-of-office reply does
    const delivered = await emailTo('delivered@plunk.test', {status: 'DELIVERED', deliveredAt: now});
    await softBounce(delivered.id, 'email.softbounce', {bounceType: 'Transient'});
    await emailTo('opened@plunk.test', {status: 'OPENED', openedAt: now});
    await emailTo('clicked@plunk.test', {status: 'CLICKED', clickedAt: now});
    await emailTo('bounced@plunk.test', {status: 'BOUNCED', bouncedAt: now});
    await emailTo('complained@plunk.test', {status: 'COMPLAINED', complainedAt: now});
    await emailTo('pending@plunk.test', {status: 'PENDING', sentAt: null});
    await emailTo('sending@plunk.test', {status: 'SENDING', sentAt: null});
    // A row failed as possibly sent keeps its status, and only gets the event's marks
    const possibly = {status: 'FAILED', sentAt: null, error: `The email ${POSSIBLY_SENT_NOTE}`} as const;
    await emailTo('maybe-bounced@plunk.test', {...possibly, bouncedAt: now});
    await emailTo('maybe-complained@plunk.test', {...possibly, complainedAt: now});
    await emailTo('maybe-opened@plunk.test', {...possibly, openedAt: now});
    await emailTo('maybe-clicked@plunk.test', {...possibly, clickedAt: now});
    await emailTo('maybe-delivered@plunk.test', {...possibly, deliveredAt: now});

    expect(await listed()).toEqual({});
    expect(await CampaignNotDelivered.counts(campaignId)).toEqual({notDelivered: 0, notSent: 0});
  });

  it('treats an email as pending until the time SES can take is over', async () => {
    const sentAt = new Date(Date.now() - NOT_DELIVERED_AFTER_MS + 60_000);
    await emailTo('edge@plunk.test', {sentAt});
    expect((await listed())['edge@plunk.test']?.state).toBe('pending');

    await prisma.email.updateMany({where: {campaignId}, data: {sentAt: new Date(Date.now() - NOT_DELIVERED_AFTER_MS)}});
    expect((await listed())['edge@plunk.test']?.state).toBe('no_answer');
  });

  it('cuts a long error', async () => {
    await emailTo('long@plunk.test', {status: 'FAILED', error: 'x'.repeat(1000)});

    expect((await listed())['long@plunk.test']?.detail).toHaveLength(300);
  });

  it('counts the rows in the total of the list, and pages through them', async () => {
    const createdAt = new Date('2026-01-01T10:00:00Z');
    for (const address of ['a@plunk.test', 'b@plunk.test', 'c@plunk.test']) {
      await emailTo(address, {createdAt});
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await CampaignService.listRecipients(projectId, campaignId, 'not_delivered', {limit: 2, cursor});
      expect(page.total).toBe(3);
      seen.push(...page.data.map(row => row.email));
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);

    expect(seen.sort()).toEqual(['a@plunk.test', 'b@plunk.test', 'c@plunk.test']);
  });

  it('only gives the other lists no reason', async () => {
    await emailTo('bounced@plunk.test', {status: 'BOUNCED', bouncedAt: new Date()});

    const {data} = await CampaignService.listRecipients(projectId, campaignId, 'bounced');

    expect(data[0]).not.toHaveProperty('delivery');
  });

  it('refuses a campaign of another project', async () => {
    const {project: other} = await factories.createUserWithProject();

    await expect(CampaignService.listRecipients(other.id, campaignId, 'not_delivered')).rejects.toThrow();
  });

  it('reports the two figures only for a campaign that has finished sending', async () => {
    await emailTo('silent@plunk.test');
    await emailTo('suppressed@plunk.test', {status: 'FAILED', sentAt: null, error: 'Address is suppressed'});

    const sent = await CampaignService.getStats(projectId, campaignId);
    expect([sent.notDeliveredCount, sent.notSentCount]).toEqual([1, 1]);

    for (const status of ['SENDING', 'CANCELLED', 'DRAFT'] as const) {
      await prisma.campaign.update({where: {id: campaignId}, data: {status}});
      const stats = await CampaignService.getStats(projectId, campaignId);
      expect([stats.notDeliveredCount, stats.notSentCount]).toEqual([0, 0]);
    }
  });
});
