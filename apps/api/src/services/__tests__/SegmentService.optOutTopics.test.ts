import {CampaignStatus, SegmentType, TemplateType} from '@plunk/db';
import {beforeEach, describe, expect, it} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {HttpException} from '../../exceptions/index.js';
import {SegmentService} from '../SegmentService';

/** The error a delete is refused with, or undefined when it goes through */
const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error as HttpException,
  );

/** Plunk Lite: a segment that is the opt-out topic of a template cannot be deleted, alone or in bulk */
describe('deleting the segment of an opt-out topic', () => {
  const prisma = getPrismaClient();
  let projectId: string;
  let segmentId: string;

  beforeEach(async () => {
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
    segmentId = (await factories.createSegment(projectId, {type: SegmentType.STATIC})).id;
    await factories.createTemplate({
      projectId,
      name: 'Day 5',
      type: TemplateType.TRANSACTIONAL,
      optOutSegmentId: segmentId,
    });
  });

  it('refuses one delete with a 409 naming the template', async () => {
    const error = await refusal(SegmentService.delete(projectId, segmentId));

    expect(error?.code).toBe(409);
    expect(error?.message).toContain('opt-out topic of the template(s) "Day 5"');
    expect(await prisma.segment.count({where: {id: segmentId}})).toBe(1);
  });

  it('refuses a bulk delete with the template among the reasons', async () => {
    const other = await factories.createSegment(projectId, {type: SegmentType.STATIC});

    const error = await refusal(SegmentService.bulkUpdate(projectId, {ids: [segmentId, other.id], delete: true}));

    expect(error?.code).toBe(409);
    expect(error?.message).toContain('the opt-out topic of the template(s) "Day 5"');
    expect(await prisma.segment.count({where: {projectId}})).toBe(2);
  });

  it('deletes it once no template uses it', async () => {
    await prisma.template.updateMany({where: {projectId}, data: {optOutSegmentId: null}});

    await SegmentService.delete(projectId, segmentId);

    expect(await prisma.segment.count({where: {id: segmentId}})).toBe(0);
  });
});

/**
 * Plunk Lite: nor one that is the opt-out topic of a TRANSACTIONAL campaign, while it is active or
 * sent (or cancelled) and not archived: its emails link to it
 */
describe('deleting the segment of a campaign opt-out topic', () => {
  const prisma = getPrismaClient();
  let projectId: string;
  let segmentId: string;

  beforeEach(async () => {
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
    segmentId = (await factories.createSegment(projectId, {type: SegmentType.STATIC})).id;
  });

  const campaign = (status: CampaignStatus, extra: {archived?: boolean; type?: TemplateType} = {}) =>
    factories
      .createCampaign({
        projectId,
        name: `Reminder ${status}`,
        status,
        type: extra.type ?? TemplateType.TRANSACTIONAL,
        optOutSegmentId: segmentId,
      })
      .then(created =>
        extra.archived ? prisma.campaign.update({where: {id: created.id}, data: {archived: true}}) : created,
      );

  it('refuses one delete and a bulk one with a 409 naming a draft', async () => {
    await campaign(CampaignStatus.DRAFT);

    const one = await refusal(SegmentService.delete(projectId, segmentId));
    expect(one?.code).toBe(409);
    expect(one?.message).toContain('opt-out topic of the campaign(s) "Reminder DRAFT"');

    const bulk = await refusal(SegmentService.bulkUpdate(projectId, {ids: [segmentId], delete: true}));
    expect(bulk?.code).toBe(409);
    expect(bulk?.message).toContain('the opt-out topic of the campaign(s) "Reminder DRAFT"');
    expect(await prisma.segment.count({where: {id: segmentId}})).toBe(1);
  });

  it('refuses while a sent or cancelled one is not archived, and while a draft is archived', async () => {
    for (const status of [CampaignStatus.SENT, CampaignStatus.CANCELLED]) {
      const sent = await campaign(status);
      expect((await refusal(SegmentService.delete(projectId, segmentId)))?.code).toBe(409);
      await prisma.campaign.update({where: {id: sent.id}, data: {archived: true}});
    }

    const draft = await campaign(CampaignStatus.DRAFT, {archived: true});
    expect((await refusal(SegmentService.delete(projectId, segmentId)))?.code).toBe(409);
    await prisma.campaign.delete({where: {id: draft.id}});

    await SegmentService.delete(projectId, segmentId);
    expect(await prisma.segment.count({where: {id: segmentId}})).toBe(0);
  });

  it('does not count a MARKETING campaign with the column filled in', async () => {
    await campaign(CampaignStatus.DRAFT, {type: TemplateType.MARKETING});

    await SegmentService.delete(projectId, segmentId);

    expect(await prisma.segment.count({where: {id: segmentId}})).toBe(0);
  });
});
