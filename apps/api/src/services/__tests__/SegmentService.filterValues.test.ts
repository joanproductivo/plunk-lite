import {CampaignAudienceType, CampaignStatus, Prisma} from '@plunk/db';
import {beforeEach, describe, expect, it} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {HttpException} from '../../exceptions/index.js';
import {CampaignService} from '../CampaignService';
import {type SegmentFilter, SegmentService} from '../SegmentService';

/**
 * A filter value the query cannot compare is refused with a 400 before anything is saved, and a
 * condition saved before that check fails with the same 400 instead of Prisma's panic ("JSON target
 * types only accept strings or numbers") or an invalid date.
 */
describe('SegmentService - filter values', () => {
  const prisma = getPrismaClient();
  let projectId: string;

  beforeEach(async () => {
    projectId = (await factories.createUserWithProject()).project.id;
    await prisma.contact.create({data: {projectId, email: 'a@x.test', data: {n: 10, d: '2026-01-05'}}});
  });

  const condition = (filter: SegmentFilter) => ({logic: 'AND' as const, groups: [{filters: [filter]}]});
  const create = (filter: SegmentFilter) =>
    SegmentService.create(projectId, {name: `S ${Math.random()}`, condition: condition(filter)});

  async function expectRefused(filter: SegmentFilter) {
    const before = await prisma.segment.count({where: {projectId}});
    const error = await create(filter).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).code).toBe(400);
    expect((error as HttpException).message).toContain(`Filter "${filter.field} ${filter.operator}" needs`);
    expect(await prisma.segment.count({where: {projectId}})).toBe(before);
  }

  describe('ranges on custom data', () => {
    it.each([null, {}, {a: 1}, [1], true])('refuses %j', async value => {
      await expectRefused({field: 'data.n', operator: 'greaterThan', value});
    });

    it.each([
      [5, 1],
      ['5', 0],
    ])('accepts %j', async (value, members) => {
      const segment = await create({field: 'data.n', operator: 'greaterThan', value});
      expect(segment.memberCount).toBe(members);
    });
  });

  describe('time windows', () => {
    it.each(['x', '', {}, null, 1e9, [7]])('refuses %j', async value => {
      await expectRefused({field: 'data.d', operator: 'within', value, unit: 'days'});
      await expectRefused({field: 'event.signup', operator: 'triggeredWithin', value, unit: 'days'});
    });

    it.each([7, '7', -1, 0])('accepts %j', async value => {
      await expect(create({field: 'createdAt', operator: 'olderThan', value, unit: 'days'})).resolves.toBeDefined();
    });

    it('caps a window at 100 years whatever its unit', async () => {
      // 30 days in minutes, and the longest window in each unit
      await expect(
        create({field: 'data.d', operator: 'within', value: 43_200, unit: 'minutes'}),
      ).resolves.toBeDefined();
      await expect(
        create({field: 'createdAt', operator: 'within', value: 52_560_000, unit: 'minutes'}),
      ).resolves.toBeDefined();
      await expect(
        create({field: 'createdAt', operator: 'within', value: 876_000, unit: 'hours'}),
      ).resolves.toBeDefined();

      await expectRefused({field: 'createdAt', operator: 'within', value: 52_560_001, unit: 'minutes'});
      await expectRefused({field: 'createdAt', operator: 'within', value: 36_501, unit: 'days'});
    });
  });

  describe('contact dates', () => {
    it.each(['', null, true, 'foo', {}, -8.64e15])('refuses %j', async value => {
      await expectRefused({field: 'createdAt', operator: 'greaterThan', value});
    });

    it.each(['2026-01-01', '2026-01-01T10:00:00.000Z', 1_700_000_000_000])('accepts %j', async value => {
      const segment = await create({field: 'createdAt', operator: 'greaterThan', value});
      expect(segment.memberCount).toBe(1);
    });
  });

  describe('text operators', () => {
    it('refuses contains null and an object on email', async () => {
      await expectRefused({field: 'data.plan', operator: 'contains', value: null});
      await expectRefused({field: 'email', operator: 'equals', value: {}});
    });

    it('accepts contains with a number, and equals with any JSON on custom data', async () => {
      await expect(create({field: 'data.plan', operator: 'contains', value: 5})).resolves.toBeDefined();
      await expect(create({field: 'data.tags', operator: 'equals', value: ['vip']})).resolves.toBeDefined();
    });
  });

  describe('conditions saved before the check', () => {
    const broken = () =>
      factories.createSegment(projectId, {filters: [{field: 'data.n', operator: 'greaterThan', value: null}]});

    it('fails a recount with the 400, and leaves the stored count in a project-wide one', async () => {
      const segment = await broken();
      await prisma.segment.update({where: {id: segment.id}, data: {memberCount: 3}});

      const error = await SegmentService.refreshMemberCount(projectId, segment.id).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).code).toBe(400);
      expect(error).not.toBeInstanceOf(Prisma.PrismaClientRustPanicError);

      await SegmentService.refreshAllMemberCounts(projectId);
      expect((await prisma.segment.findUniqueOrThrow({where: {id: segment.id}})).memberCount).toBe(3);
    });
  });

  describe('campaigns', () => {
    const filtered = {
      logic: 'AND' as const,
      groups: [{filters: [{field: 'data.n', operator: 'lessThan', value: null}]}],
    };
    const refused = {code: 400, message: expect.stringContaining('Filter "data.n lessThan" needs')};

    it('does not create a filtered campaign with a value the query cannot compare', async () => {
      const before = await prisma.campaign.count({where: {projectId}});

      await expect(
        CampaignService.create(projectId, {
          name: 'Broken',
          subject: 'Hi',
          body: '<p>Hi</p>',
          from: 'news@example.com',
          audienceType: CampaignAudienceType.FILTERED,
          audienceCondition: filtered,
        }),
      ).rejects.toMatchObject(refused);
      expect(await prisma.campaign.count({where: {projectId}})).toBe(before);
    });

    it('does not save such a value into a scheduled campaign', async () => {
      const good = condition({field: 'data.n', operator: 'lessThan', value: 20});
      const {id} = await factories.createCampaign({
        projectId,
        status: CampaignStatus.SCHEDULED,
        scheduledFor: new Date(Date.now() + 86_400_000),
        audienceType: CampaignAudienceType.FILTERED,
      });
      const campaign = await prisma.campaign.update({where: {id}, data: {audienceCondition: good}});

      await expect(CampaignService.update(projectId, campaign.id, {audienceCondition: filtered})).rejects.toMatchObject(
        refused,
      );
      expect((await prisma.campaign.findUniqueOrThrow({where: {id: campaign.id}})).audienceCondition).toEqual(good);
    });
  });
});
