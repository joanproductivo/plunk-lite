import type {CampaignStatus, Prisma} from '@plunk/db';
import {beforeEach, describe, expect, it} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {redis} from '../../database/redis';
import {CampaignService} from '../CampaignService';
import {ContactService} from '../ContactService';
import {Keys} from '../keys';

/**
 * Plunk Lite: deleting a contact deletes its emails, and the campaign's figures follow them, or a
 * deleted contact would read as sent and never delivered. The project's rates keep counting them
 * (DeletedEmailCounts.test.ts).
 */
describe('CampaignService - deleted contacts', () => {
  const prisma = getPrismaClient();
  let projectId: string;

  beforeEach(async () => {
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
    await redis.del(Keys.Campaign.statsDirty());
  });

  /** A campaign of `count` delivered emails, its counters as the send left them */
  async function sentCampaign(
    count: number,
    status: CampaignStatus = 'SENT',
    stamps?: Prisma.EmailUpdateManyMutationInput,
  ) {
    const campaign = await factories.createCampaign({projectId, name: 'Deleted', status});
    const contacts = [];
    for (let i = 0; i < count; i++) {
      const contact = await factories.createContact({projectId});
      contacts.push(contact);
      await prisma.email.create({
        data: {
          projectId,
          contactId: contact.id,
          campaignId: campaign.id,
          subject: 'Hi',
          body: '<p>Hi</p>',
          from: 'hello@plunk.test',
          sourceType: 'CAMPAIGN',
          status: 'DELIVERED',
          sentAt: new Date(),
          deliveredAt: new Date(),
          ...stamps,
        },
      });
    }
    await prisma.campaign.update({where: {id: campaign.id}, data: {sentCount: count, deliveredCount: count}});
    return {campaign, contacts};
  }

  it('takes a deleted contact out of the sent figure at the next sweep, not as not delivered', async () => {
    const {campaign, contacts} = await sentCampaign(3);

    await ContactService.delete(projectId, contacts[0]!.id);
    await CampaignService.sweepDirtyStats(10);

    const stats = await CampaignService.getStats(projectId, campaign.id);
    expect(stats).toMatchObject({sentCount: 2, deliveredCount: 2, deliveryRate: 100, notDeliveredCount: 0});
  });

  it('does the same for a bulk delete, across campaigns', async () => {
    const one = await sentCampaign(2);
    const two = await sentCampaign(2);

    await ContactService.bulkDelete(projectId, [one.contacts[0]!.id, two.contacts[0]!.id, two.contacts[1]!.id]);
    await CampaignService.sweepDirtyStats(10);

    expect((await CampaignService.getStats(projectId, one.campaign.id)).sentCount).toBe(1);
    expect((await CampaignService.getStats(projectId, two.campaign.id)).sentCount).toBe(0);
  });

  it('takes the opt-outs of the deleted contacts out of the unsubscribe figure', async () => {
    const {campaign, contacts} = await sentCampaign(4, 'SENT');
    await prisma.email.updateMany({
      where: {campaignId: campaign.id, contactId: {in: [contacts[0]!.id, contacts[1]!.id]}},
      data: {unsubscribedAt: new Date()},
    });
    await prisma.campaign.update({where: {id: campaign.id}, data: {unsubscribedCount: 2}});

    await ContactService.bulkDelete(projectId, [contacts[0]!.id, contacts[2]!.id]);
    await CampaignService.sweepDirtyStats(10);

    const stats = await CampaignService.getStats(projectId, campaign.id);
    expect(stats).toMatchObject({sentCount: 2, unsubscribedCount: 1, unsubscribeRate: 50});
  });

  it('never takes the unsubscribe figure below zero', async () => {
    const {campaign, contacts} = await sentCampaign(1, 'SENT', {unsubscribedAt: new Date()});

    await ContactService.delete(projectId, contacts[0]!.id);

    const row = await prisma.campaign.findUniqueOrThrow({where: {id: campaign.id}});
    expect(row.unsubscribedCount).toBe(0);
  });

  it.each(['SENDING', 'CANCELLED', 'DRAFT'] as const)('leaves the sent figure of a %s campaign alone', async status => {
    const {campaign, contacts} = await sentCampaign(3, status);

    await ContactService.delete(projectId, contacts[0]!.id);
    await CampaignService.sweepDirtyStats(10);

    const row = await prisma.campaign.findUniqueOrThrow({where: {id: campaign.id}});
    expect(row.sentCount).toBe(3);
  });

  it('marks nothing when the contact had no campaign emails', async () => {
    const contact = await factories.createContact({projectId});

    await ContactService.delete(projectId, contact.id);

    expect(await redis.scard(Keys.Campaign.statsDirty())).toBe(0);
  });
});
