import {CampaignAudienceType, CampaignStatus, SegmentType, TemplateType} from '@plunk/db';
import type {Campaign} from '@plunk/db';
import {UnrecoverableError} from 'bullmq';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {DASHBOARD_URI} from '../../app/constants';
import {prisma as appPrisma} from '../../database/prisma';
import {CampaignService} from '../CampaignService';
import {QueueService} from '../QueueService';
import {SegmentService} from '../SegmentService';
import {MISSING_CAMPAIGN_TOPIC} from '../TemplateOptOut';

vi.mock('../SESService', async importOriginal => ({
  ...(await importOriginal<typeof import('../SESService')>()),
  getDailyQuotaQuick: vi.fn(async () => null),
}));

/**
 * Plunk Lite: the opt-out topic of a TRANSACTIONAL campaign, a static segment. Its members are left
 * out of the audience (counts and batches alike), and each email's `{{optOutUrl}}` is the campaign's
 * opt-out page. A topic that is gone stops the count and the send.
 */
describe('CampaignService - opt-out topic', () => {
  const prisma = getPrismaClient();
  let projectId: string;

  beforeEach(async () => {
    projectId = (await factories.createUserWithProject()).project.id;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function staticSegment(name: string, contactIds: string[]) {
    const segment = await factories.createSegment(projectId, {name, type: SegmentType.STATIC});
    if (contactIds.length > 0) {
      await prisma.segmentMembership.createMany({
        data: contactIds.map(contactId => ({segmentId: segment.id, contactId})),
      });
    }
    return segment;
  }

  const contact = (email: string, subscribed = true) => prisma.contact.create({data: {projectId, email, subscribed}});

  const create = (data: Partial<Parameters<typeof CampaignService.create>[1]>) =>
    CampaignService.create(projectId, {
      name: 'Notice',
      subject: 'Hi',
      body: '<p>Hi <a href="{{optOutUrl}}">stop these</a></p>',
      from: 'news@example.com',
      type: TemplateType.TRANSACTIONAL,
      audienceType: CampaignAudienceType.ALL,
      ...data,
    });

  /** Runs the send's first batch (500), as the batch chain would, and returns the emails it created */
  async function firstBatch(campaign: Campaign) {
    const sending = await prisma.campaign.update({
      where: {id: campaign.id},
      data: {status: CampaignStatus.SENDING, sentAt: new Date()},
    });
    vi.spyOn(QueueService, 'queueCampaignBatch').mockResolvedValue(undefined as never);
    vi.spyOn(CampaignService, 'finalizeIfDone' as never).mockResolvedValue(undefined as never);
    await CampaignService.processBatch({
      campaignId: campaign.id,
      batchNumber: 1,
      offset: 0,
      limit: 500,
      generation: sending.sentAt!.getTime(),
    });
    return prisma.email.findMany({where: {campaignId: campaign.id}, include: {contact: true}});
  }

  describe('the audience', () => {
    it('leaves out its members, also when the same segment is excluded (once), with no other exclusion', async () => {
      const a = await contact('a@x.test');
      await contact('b@x.test');
      await contact('c@x.test', false);
      const topic = await staticSegment('Topic', [a.id]);

      const alone = await create({optOutSegmentId: topic.id});
      expect(alone.optOutSegmentId).toBe(topic.id);
      expect(alone.totalRecipients).toBe(2);

      const both = await create({optOutSegmentId: topic.id, excludedSegmentIds: [topic.id]});
      expect(both.totalRecipients).toBe(2);
    });

    it('does not count an unsubscribed member in the send audience', async () => {
      const out = await contact('out@x.test', false);
      await contact('kept@x.test', false);
      const topic = await staticSegment('Topic', [out.id]);
      const campaign = await create({optOutSegmentId: topic.id});

      expect(await CampaignService.getSendAudience(projectId, campaign.id)).toEqual({unsubscribed: 1});
    });

    it('creates no email for a member, and gives the others the campaign opt-out link', async () => {
      const member = await contact('member@x.test');
      const other = await contact('other@x.test');
      const topic = await staticSegment('Topic', [member.id]);
      const campaign = await create({optOutSegmentId: topic.id});

      const emails = await firstBatch(campaign);

      expect(emails.map(email => email.contactId)).toEqual([other.id]);
      expect(emails[0]!.body).toContain(`${DASHBOARD_URI}/opt-out/${other.id}?c=${campaign.id}`);
    });

    it('leaves {{optOutUrl}} empty without a topic', async () => {
      const one = await contact('one@x.test');
      const campaign = await create({});

      const emails = await firstBatch(campaign);

      expect(emails.map(email => email.contactId)).toEqual([one.id]);
      expect(emails[0]!.body).not.toContain('/opt-out/');
    });

    it('ignores a topic left on a MARKETING campaign (inert)', async () => {
      const member = await contact('member@x.test');
      await contact('other@x.test');
      const topic = await staticSegment('Topic', [member.id]);
      const campaign = await factories.createCampaign({projectId, optOutSegmentId: topic.id});

      await CampaignService.update(projectId, campaign.id, {
        subject: 'Recount',
        audienceType: CampaignAudienceType.ALL,
      });
      expect((await prisma.campaign.findUniqueOrThrow({where: {id: campaign.id}})).totalRecipients).toBe(2);

      const emails = await firstBatch(campaign);
      expect(emails).toHaveLength(2);
      expect(emails.every(email => !email.body.includes('/opt-out/'))).toBe(true);
    });

    it('refuses to be sent to its own topic', async () => {
      const topic = await staticSegment('Topic', []);

      await expect(
        create({optOutSegmentId: topic.id, audienceType: CampaignAudienceType.SEGMENT, segmentId: topic.id}),
      ).rejects.toMatchObject({code: 400, message: expect.stringContaining('own opt-out segment')});

      const campaign = await create({optOutSegmentId: topic.id});
      await expect(
        CampaignService.update(projectId, campaign.id, {
          audienceType: CampaignAudienceType.SEGMENT,
          segmentId: topic.id,
        }),
      ).rejects.toMatchObject({code: 400, message: expect.stringContaining('own opt-out segment')});
    });
  });

  describe('editing', () => {
    it('sets, recounts and removes the topic of a draft', async () => {
      const a = await contact('a@x.test');
      await contact('b@x.test');
      const topic = await staticSegment('Topic', [a.id]);
      const campaign = await create({});
      expect(campaign.totalRecipients).toBe(2);

      const set = await CampaignService.update(projectId, campaign.id, {optOutSegmentId: topic.id});
      expect(set).toMatchObject({optOutSegmentId: topic.id, totalRecipients: 1});

      const renamed = await CampaignService.update(projectId, campaign.id, {name: 'Renamed'});
      expect(renamed.optOutSegmentId).toBe(topic.id);

      const removed = await CampaignService.update(projectId, campaign.id, {optOutSegmentId: null});
      expect(removed).toMatchObject({optOutSegmentId: null, totalRecipients: 2});
    });

    it('recounts when only the type changes', async () => {
      await contact('a@x.test');
      await contact('b@x.test', false);
      const campaign = await factories.createCampaign({projectId, type: TemplateType.MARKETING});

      const updated = await CampaignService.update(projectId, campaign.id, {type: TemplateType.TRANSACTIONAL});

      expect(updated.totalRecipients).toBe(2);
    });

    it('refuses on a scheduled campaign to change or remove the topic, or to change the type', async () => {
      const topic = await staticSegment('Topic', []);
      const other = await staticSegment('Other', []);
      const scheduled = await factories.createCampaign({
        projectId,
        status: CampaignStatus.SCHEDULED,
        type: TemplateType.TRANSACTIONAL,
        optOutSegmentId: topic.id,
      });
      const plain = await factories.createCampaign({projectId, status: CampaignStatus.SCHEDULED});

      for (const data of [{optOutSegmentId: other.id}, {optOutSegmentId: null}]) {
        await expect(CampaignService.update(projectId, scheduled.id, data)).rejects.toMatchObject({
          code: 400,
          message: 'Cannot change the opt-out topic of a scheduled campaign',
        });
      }
      await expect(
        CampaignService.update(projectId, scheduled.id, {type: TemplateType.MARKETING, optOutSegmentId: null}),
      ).rejects.toMatchObject({code: 400, message: 'Cannot change the type of a scheduled campaign'});
      await expect(
        CampaignService.update(projectId, plain.id, {type: TemplateType.TRANSACTIONAL}),
      ).rejects.toMatchObject({code: 400, message: 'Cannot change the type of a scheduled campaign'});

      // The same topic and type again are not a change
      await expect(
        CampaignService.update(projectId, scheduled.id, {
          subject: 'Same audience',
          type: TemplateType.TRANSACTIONAL,
          optOutSegmentId: topic.id,
        }),
      ).resolves.toMatchObject({subject: 'Same audience', optOutSegmentId: topic.id});
    });

    it('writes nothing when the campaign starts sending between its read and its write', async () => {
      const topic = await staticSegment('Topic', []);
      const audience = await staticSegment('Audience', []);
      const campaign = await create({});
      const draft = await prisma.campaign.findUniqueOrThrow({where: {id: campaign.id}});
      await prisma.campaign.update({where: {id: campaign.id}, data: {status: CampaignStatus.SENDING}});
      // The read still sees the draft, as a save crossing the start of the send would
      vi.spyOn(CampaignService, 'get').mockResolvedValueOnce(draft as never);

      await expect(
        CampaignService.update(projectId, campaign.id, {
          optOutSegmentId: topic.id,
          audienceType: CampaignAudienceType.SEGMENT,
          segmentId: audience.id,
        }),
      ).rejects.toMatchObject({code: 400, message: 'Cannot update campaign that is sending or has been sent'});

      expect(await prisma.campaign.findUniqueOrThrow({where: {id: campaign.id}})).toMatchObject({
        status: CampaignStatus.SENDING,
        optOutSegmentId: null,
        segmentId: null,
        audienceType: CampaignAudienceType.ALL,
      });
    });

    it('lets a segment deleted before connecting it fail as it did, not as a status change', async () => {
      const audience = await staticSegment('Audience', []);
      const campaign = await create({});
      // Deleted between the update's own check of the segment and its write
      const findFirst = appPrisma.segment.findFirst.bind(appPrisma.segment);
      vi.spyOn(appPrisma.segment, 'findFirst').mockImplementationOnce((async (args: never) => {
        const found = await findFirst(args);
        await prisma.segment.delete({where: {id: audience.id}});
        return found;
      }) as never);

      const error = await CampaignService.update(projectId, campaign.id, {
        audienceType: CampaignAudienceType.SEGMENT,
        segmentId: audience.id,
      }).catch((caught: unknown) => caught);

      expect(error).toMatchObject({code: 'P2025'});
      expect((await prisma.campaign.findUniqueOrThrow({where: {id: campaign.id}})).segmentId).toBeNull();
    });
  });

  it('takes an archived draft out of the archive as it sends or is scheduled, so its segment stays locked', async () => {
    await contact('a@x.test');
    const topic = await staticSegment('Topic', []);
    const sent = await create({name: 'Sent', optOutSegmentId: topic.id});
    const scheduled = await create({name: 'Scheduled', optOutSegmentId: topic.id});
    await prisma.campaign.updateMany({where: {id: {in: [sent.id, scheduled.id]}}, data: {archived: true}});
    vi.spyOn(QueueService, 'queueCampaignBatch').mockResolvedValue(undefined as never);
    vi.spyOn(QueueService, 'scheduleCampaign').mockResolvedValue(undefined as never);

    await CampaignService.send(projectId, sent.id);
    await CampaignService.send(projectId, scheduled.id, new Date(Date.now() + 60 * 60 * 1000));
    const archived = await prisma.campaign.findMany({
      where: {id: {in: [sent.id, scheduled.id]}},
      select: {archived: true},
    });
    expect(archived).toEqual([{archived: false}, {archived: false}]);

    // Once sent it would no longer lock the segment if it were still archived
    await prisma.campaign.update({where: {id: sent.id}, data: {status: CampaignStatus.SENT}});
    await prisma.campaign.delete({where: {id: scheduled.id}});
    await expect(SegmentService.delete(projectId, topic.id)).rejects.toMatchObject({code: 409});
  });

  describe('archiving while it starts sending', () => {
    it('does not archive one campaign whose send started after the read', async () => {
      const campaign = await create({});
      await prisma.campaign.update({where: {id: campaign.id}, data: {status: CampaignStatus.SENDING}});
      // The read still sees the draft, as an archive crossing the start of the send would
      vi.spyOn(appPrisma.campaign, 'findFirst').mockResolvedValueOnce({
        id: campaign.id,
        status: CampaignStatus.DRAFT,
        archived: false,
      } as never);

      await expect(CampaignService.setArchived(projectId, campaign.id, true)).rejects.toMatchObject({
        code: 400,
        message: expect.stringContaining('This one is sending'),
      });
      expect((await prisma.campaign.findUniqueOrThrow({where: {id: campaign.id}})).archived).toBe(false);
    });

    it('archives none of a batch when one started sending after the check', async () => {
      const draft = await create({name: 'Draft'});
      const sending = await create({name: 'Sending'});
      await prisma.campaign.update({where: {id: sending.id}, data: {status: CampaignStatus.SENDING}});
      // The batch's check still sees both as drafts
      const transaction = appPrisma.$transaction.bind(appPrisma) as (fn: (tx: unknown) => unknown) => unknown;
      vi.spyOn(appPrisma, '$transaction').mockImplementationOnce(((fn: (tx: unknown) => unknown) =>
        transaction(async tx => {
          const client = tx as {campaign: {findMany: (args: unknown) => Promise<Array<{status: CampaignStatus}>>}};
          const findMany = client.campaign.findMany.bind(client.campaign);
          vi.spyOn(client.campaign, 'findMany').mockImplementationOnce(async (args: unknown) =>
            (await findMany(args)).map(row => ({...row, status: CampaignStatus.DRAFT})),
          );
          return fn(tx);
        })) as never);

      await expect(
        CampaignService.bulkUpdate(projectId, {ids: [draft.id, sending.id], archived: true}),
      ).rejects.toMatchObject({code: 400, message: expect.stringContaining('started sending')});
      expect(await prisma.campaign.count({where: {id: {in: [draft.id, sending.id]}, archived: true}})).toBe(0);
    });
  });

  describe('a topic whose segment is gone', () => {
    async function campaignWithDeletedTopic() {
      await contact('a@x.test');
      const topic = await staticSegment('Topic', []);
      const campaign = await create({optOutSegmentId: topic.id});
      // Deleted behind the campaign's back (by SQL, or from an earlier image)
      await prisma.segment.delete({where: {id: topic.id}});
      return campaign;
    }

    it('stops the send with a 400 and keeps the campaign a draft', async () => {
      const campaign = await campaignWithDeletedTopic();

      await expect(CampaignService.send(projectId, campaign.id)).rejects.toMatchObject({
        code: 400,
        message: MISSING_CAMPAIGN_TOPIC,
      });
      expect((await prisma.campaign.findUniqueOrThrow({where: {id: campaign.id}})).status).toBe(CampaignStatus.DRAFT);
    });

    it('fails a batch for good', async () => {
      const campaign = await campaignWithDeletedTopic();

      await expect(firstBatch(campaign)).rejects.toBeInstanceOf(UnrecoverableError);
      expect(await prisma.email.count({where: {campaignId: campaign.id}})).toBe(0);
    });

    it('does not block saving the draft, and a duplicate keeps it with a count of 0', async () => {
      const campaign = await campaignWithDeletedTopic();

      await expect(
        CampaignService.update(projectId, campaign.id, {
          subject: 'New subject',
          audienceType: CampaignAudienceType.ALL,
        }),
      ).resolves.toMatchObject({subject: 'New subject'});

      const copy = await CampaignService.duplicate(projectId, campaign.id);
      expect(copy.optOutSegmentId).toBe(campaign.optOutSegmentId);
      expect(copy.totalRecipients).toBe(0);
    });

    it('counts as gone when the segment is dynamic', async () => {
      await contact('a@x.test');
      const dynamic = await factories.createSegment(projectId, {type: SegmentType.DYNAMIC});
      const campaign = await factories.createCampaign({
        projectId,
        type: TemplateType.TRANSACTIONAL,
        optOutSegmentId: dynamic.id,
      });

      await expect(CampaignService.send(projectId, campaign.id)).rejects.toMatchObject({
        code: 400,
        message: MISSING_CAMPAIGN_TOPIC,
      });
    });
  });
});
