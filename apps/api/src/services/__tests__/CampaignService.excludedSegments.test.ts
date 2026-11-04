import {CampaignAudienceType, CampaignStatus, Prisma, SegmentType, TemplateType} from '@plunk/db';
import type {ScheduledCampaignJobData} from '@plunk/types';
import type {Job} from 'bullmq';
import {UnrecoverableError} from 'bullmq';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {processScheduledCampaign} from '../../jobs/scheduled-processor.js';
import {CampaignService} from '../CampaignService';
import {FailureAlertService} from '../FailureAlertService';
import {QueueService} from '../QueueService';

/**
 * Plunk Lite: a campaign can leave out the contacts of some segments, whatever its audience. Who is
 * in an excluded segment is counted and taken away, never negated: Prisma's NOT on a typed `data.*`
 * filter also requires the value's type, so negating a dynamic segment would leave out people not in it.
 */
describe('CampaignService - excluded segments', () => {
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

  const contact = (email: string, data?: Prisma.InputJsonValue | typeof Prisma.DbNull) =>
    prisma.contact.create({data: {projectId, email, subscribed: true, data}});

  const recipientsOf = async (campaignId: string) =>
    (await prisma.campaign.findUniqueOrThrow({where: {id: campaignId}})).totalRecipients;

  /** Every contact the send's batches would mail, walking the cursor like the batch chain does */
  async function batchedRecipients(campaignId: string, limit: number) {
    const campaign = await prisma.campaign.update({
      where: {id: campaignId},
      data: {status: CampaignStatus.SENDING, sentAt: new Date()},
    });
    const generation = campaign.sentAt!.getTime();
    const queued: Array<{cursor?: string; batchNumber: number}> = [];
    vi.spyOn(QueueService, 'queueCampaignBatch').mockImplementation(async job => {
      queued.push(job);
      return undefined as never;
    });
    // The last batch finalizes the campaign; that part is not what is under test
    vi.spyOn(CampaignService, 'finalizeIfDone' as never).mockResolvedValue(undefined as never);

    let next: {cursor?: string; batchNumber: number} | undefined = {batchNumber: 1};
    while (next) {
      const before = queued.length;
      await CampaignService.processBatch({
        campaignId,
        batchNumber: next.batchNumber,
        offset: 0,
        limit,
        cursor: next.cursor,
        generation,
      });
      next = queued.length > before ? queued[queued.length - 1] : undefined;
    }

    const emails = await prisma.email.findMany({where: {campaignId}, include: {contact: true}});
    return emails.map(email => email.contact!.email).sort();
  }

  it('leaves the members of an excluded static segment out of an ALL campaign', async () => {
    const a = await contact('a@x.test');
    const b = await contact('b@x.test');
    await contact('c@x.test');
    const buyers = await staticSegment('Buyers', [a.id, b.id]);

    const campaign = await CampaignService.create(projectId, {
      name: 'Newsletter',
      subject: 'Hi',
      body: '<p>Hi</p>',
      from: 'news@example.com',
      audienceType: CampaignAudienceType.ALL,
      excludedSegmentIds: [buyers.id],
    });

    expect(campaign.totalRecipients).toBe(1);
    expect(await batchedRecipients(campaign.id, 500)).toEqual(['c@x.test']);
  });

  it('leaves out of a segment campaign the contacts also in an excluded segment', async () => {
    const a = await contact('a@x.test');
    const b = await contact('b@x.test');
    const c = await contact('c@x.test');
    const leads = await staticSegment('Leads', [a.id, b.id]);
    const buyers = await staticSegment('Buyers', [b.id, c.id]);

    const campaign = await CampaignService.create(projectId, {
      name: 'Offer',
      subject: 'Hi',
      body: '<p>Hi</p>',
      from: 'news@example.com',
      audienceType: CampaignAudienceType.SEGMENT,
      segmentId: leads.id,
      excludedSegmentIds: [buyers.id],
    });

    expect(campaign.audienceType).toBe(CampaignAudienceType.SEGMENT);
    expect(campaign.totalRecipients).toBe(1);
    expect(await batchedRecipients(campaign.id, 500)).toEqual(['a@x.test']);
  });

  it('keeps the contacts a dynamic segment on a data field does not hold, with or without data', async () => {
    await contact('pro@x.test', {plan: 'pro'});
    await contact('free@x.test', {plan: 'free'});
    await contact('noplan@x.test', {});
    await contact('nodata@x.test', Prisma.DbNull);
    const pro = await factories.createSegment(projectId, {
      filters: [{field: 'data.plan', operator: 'equals', value: 'pro'}],
    });

    const campaign = await factories.createCampaign({projectId, excludedSegmentIds: [pro.id]});
    await CampaignService.update(projectId, campaign.id, {excludedSegmentIds: [pro.id]});

    expect(await recipientsOf(campaign.id)).toBe(3);
    expect(await batchedRecipients(campaign.id, 500)).toEqual(['free@x.test', 'nodata@x.test', 'noplan@x.test']);
  });

  it('walks every batch when the last contact of one is excluded, and goes on past an empty one', async () => {
    const contacts = [];
    for (let i = 0; i < 6; i++) contacts.push(await contact(`c${i}@x.test`));
    const byId = [...contacts].sort((x, y) => x.id.localeCompare(y.id));
    // Batches of 2 by id: the second batch is all excluded, and the first one ends on an excluded contact
    const left = await staticSegment('Left out', [byId[1]!.id, byId[2]!.id, byId[3]!.id]);
    const campaign = await factories.createCampaign({projectId, excludedSegmentIds: [left.id]});

    expect(await batchedRecipients(campaign.id, 2)).toEqual([byId[0]!.email, byId[4]!.email, byId[5]!.email].sort());
  });

  it('takes the excluded unsubscribed contacts out of what a transactional campaign reaches', async () => {
    const out = await prisma.contact.create({data: {projectId, email: 'out@x.test', subscribed: false}});
    await prisma.contact.create({data: {projectId, email: 'kept@x.test', subscribed: false}});
    const segment = await staticSegment('Out', [out.id]);
    const campaign = await factories.createCampaign({
      projectId,
      type: TemplateType.TRANSACTIONAL,
      excludedSegmentIds: [segment.id],
    });

    expect(await CampaignService.getSendAudience(projectId, campaign.id)).toEqual({unsubscribed: 1});
  });

  it('counts 0, never less, when the exclusion covers the whole audience', async () => {
    const a = await contact('a@x.test');
    const everyone = await staticSegment('Everyone', [a.id]);
    const campaign = await factories.createCampaign({projectId});

    await CampaignService.update(projectId, campaign.id, {excludedSegmentIds: [everyone.id]});

    expect(await recipientsOf(campaign.id)).toBe(0);
  });

  describe('an excluded segment that no longer exists', () => {
    async function campaignExcludingDeleted(status: CampaignStatus = CampaignStatus.DRAFT) {
      await contact('a@x.test');
      const gone = await staticSegment('Gone', []);
      const campaign = await factories.createCampaign({projectId, status, excludedSegmentIds: [gone.id]});
      // Deleted behind the campaign's back, as a race would
      await prisma.segment.delete({where: {id: gone.id}});
      return campaign;
    }

    it('stops the send with a 400 and keeps the campaign a draft', async () => {
      const campaign = await campaignExcludingDeleted();

      await expect(CampaignService.send(projectId, campaign.id)).rejects.toMatchObject({
        code: 400,
        message: expect.stringContaining('Deleted segment'),
      });
      expect((await prisma.campaign.findUniqueOrThrow({where: {id: campaign.id}})).status).toBe(CampaignStatus.DRAFT);
    });

    it('alerts when a scheduled campaign cannot start', async () => {
      const campaign = await campaignExcludingDeleted(CampaignStatus.SCHEDULED);
      await prisma.campaign.update({where: {id: campaign.id}, data: {scheduledFor: new Date()}});
      const alert = vi.spyOn(FailureAlertService, 'recordCampaignJob').mockResolvedValue();

      await expect(
        processScheduledCampaign({data: {campaignId: campaign.id}} as unknown as Job<ScheduledCampaignJobData>),
      ).rejects.toBeInstanceOf(UnrecoverableError);

      expect(alert).toHaveBeenCalledWith(campaign.id, expect.stringContaining('Deleted segment'));
    });

    it('fails a batch for good rather than retrying it', async () => {
      const campaign = await campaignExcludingDeleted();
      const sending = await prisma.campaign.update({
        where: {id: campaign.id},
        data: {status: CampaignStatus.SENDING, sentAt: new Date()},
      });

      await expect(
        CampaignService.processBatch({
          campaignId: campaign.id,
          batchNumber: 1,
          offset: 0,
          limit: 500,
          generation: sending.sentAt!.getTime(),
        }),
      ).rejects.toBeInstanceOf(UnrecoverableError);
      expect(await prisma.email.count({where: {campaignId: campaign.id}})).toBe(0);
    });

    it('does not block saving the rest, as the dashboard sends it with the same audience', async () => {
      const campaign = await campaignExcludingDeleted();

      const saved = await CampaignService.update(projectId, campaign.id, {
        subject: 'New subject',
        audienceType: CampaignAudienceType.ALL,
        excludedSegmentIds: campaign.excludedSegmentIds,
      });

      expect(saved.subject).toBe('New subject');
      expect(saved.excludedSegmentIds).toEqual(campaign.excludedSegmentIds);
    });

    it('lets a scheduled campaign take its same list again', async () => {
      const campaign = await campaignExcludingDeleted(CampaignStatus.SCHEDULED);

      await expect(
        CampaignService.update(projectId, campaign.id, {excludedSegmentIds: campaign.excludedSegmentIds}),
      ).resolves.toMatchObject({excludedSegmentIds: campaign.excludedSegmentIds});
    });

    it('is refused when a new list still holds it', async () => {
      const campaign = await campaignExcludingDeleted();
      const other = await staticSegment('Other', []);

      await expect(
        CampaignService.update(projectId, campaign.id, {
          excludedSegmentIds: [...campaign.excludedSegmentIds, other.id],
        }),
      ).rejects.toMatchObject({code: 400, message: expect.stringContaining('not a segment of this project')});
    });

    it('leaves a campaign created as it is deleted with a count of 0, not an error', async () => {
      await contact('a@x.test');
      const gone = await staticSegment('Gone', []);
      // Deleted after the campaign's list was checked and before it is counted, as a race would
      const service = CampaignService as unknown as {findSegments: (...args: unknown[]) => Promise<unknown>};
      const findSegments = service.findSegments.bind(CampaignService);
      vi.spyOn(service, 'findSegments').mockImplementationOnce(async (...args: unknown[]) => {
        const found = await findSegments(...args);
        await prisma.segment.delete({where: {id: gone.id}});
        return found;
      });

      const created = await CampaignService.create(projectId, {
        name: 'Race',
        subject: 'Hi',
        body: '<p>Hi</p>',
        from: 'news@example.com',
        audienceType: CampaignAudienceType.ALL,
        excludedSegmentIds: [gone.id],
      });

      expect(created.excludedSegmentIds).toEqual([gone.id]);
      expect(created.totalRecipients).toBe(0);
    });

    it('is left out of a duplicate, which keeps the ones that still exist', async () => {
      const kept = await staticSegment('Kept', []);
      const campaign = await campaignExcludingDeleted(CampaignStatus.SENT);
      await prisma.campaign.update({
        where: {id: campaign.id},
        data: {excludedSegmentIds: [...campaign.excludedSegmentIds, kept.id]},
      });

      const copy = await CampaignService.duplicate(projectId, campaign.id);

      expect(copy.excludedSegmentIds).toEqual([kept.id]);
      expect(copy.totalRecipients).toBe(1);
    });
  });

  describe('saving', () => {
    it('stores the list without repeats, and recounts the draft', async () => {
      const a = await contact('a@x.test');
      await contact('b@x.test');
      const segment = await staticSegment('One', [a.id]);
      const campaign = await factories.createCampaign({projectId});

      const updated = await CampaignService.update(projectId, campaign.id, {
        excludedSegmentIds: [segment.id, segment.id],
      });

      expect(updated.excludedSegmentIds).toEqual([segment.id]);
      expect(updated.totalRecipients).toBe(1);
    });

    it('refuses a segment of another project', async () => {
      const other = (await factories.createUserWithProject()).project.id;
      const theirs = await factories.createSegment(other, {type: SegmentType.STATIC});
      const campaign = await factories.createCampaign({projectId});

      await expect(
        CampaignService.update(projectId, campaign.id, {excludedSegmentIds: [theirs.id]}),
      ).rejects.toMatchObject({code: 400, message: 'An excluded segment is not a segment of this project'});
    });

    it('refuses to exclude the segment the campaign is sent to, also when the audience changes to it', async () => {
      const segment = await staticSegment('Same', []);
      const other = await staticSegment('Other', []);

      await expect(
        CampaignService.create(projectId, {
          name: 'Same',
          subject: 'Hi',
          body: '<p>Hi</p>',
          from: 'news@example.com',
          audienceType: CampaignAudienceType.SEGMENT,
          segmentId: segment.id,
          excludedSegmentIds: [segment.id],
        }),
      ).rejects.toMatchObject({code: 400, message: expect.stringContaining('cannot exclude')});

      const campaign = await factories.createCampaign({projectId, excludedSegmentIds: [segment.id]});
      await expect(
        CampaignService.update(projectId, campaign.id, {
          audienceType: CampaignAudienceType.SEGMENT,
          segmentId: segment.id,
        }),
      ).rejects.toMatchObject({code: 400, message: expect.stringContaining('cannot exclude')});
      await expect(
        CampaignService.update(projectId, campaign.id, {
          audienceType: CampaignAudienceType.SEGMENT,
          segmentId: other.id,
        }),
      ).resolves.toMatchObject({excludedSegmentIds: [segment.id]});
    });

    it('refuses a different list on a scheduled campaign, and takes the same one', async () => {
      const first = await staticSegment('First', []);
      const second = await staticSegment('Second', []);
      const campaign = await factories.createCampaign({
        projectId,
        status: CampaignStatus.SCHEDULED,
        excludedSegmentIds: [first.id],
      });

      await expect(
        CampaignService.update(projectId, campaign.id, {excludedSegmentIds: [first.id, second.id]}),
      ).rejects.toMatchObject({code: 400, message: expect.stringContaining('scheduled')});
      await expect(
        CampaignService.update(projectId, campaign.id, {excludedSegmentIds: [first.id]}),
      ).resolves.toMatchObject({excludedSegmentIds: [first.id]});
    });
  });
});
