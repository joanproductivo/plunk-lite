import {SegmentType, TemplateType} from '@plunk/db';
import {beforeEach, describe, expect, it} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {HttpException} from '../../exceptions/index.js';
import {SegmentService} from '../SegmentService';

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

  const refusal = (promise: Promise<unknown>) =>
    promise.then(
      () => undefined,
      (error: unknown) => error as HttpException,
    );

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
