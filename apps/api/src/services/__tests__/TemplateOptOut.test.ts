import {SegmentType, TemplateType} from '@plunk/db';
import {beforeEach, describe, expect, it, vi} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {API_URI, DASHBOARD_URI} from '../../app/constants';
import {HttpException} from '../../exceptions/index.js';
import {QueueService} from '../QueueService';
import {SegmentMembershipService} from '../SegmentMembershipService';
import {isOptedOut, optOutLink, optOutTopic, optOutUrl, readTemplateParam} from '../TemplateOptOut';
import {assertValidTopic, optOut} from '../TemplateOptOutAdmin';
import {TemplateService} from '../TemplateService';

/**
 * Plunk Lite: opt-out topics. A TRANSACTIONAL template names a static segment; its opt-out link puts
 * the contact there once, and its emails skip the members.
 */
describe('opt-out topics', () => {
  const prisma = getPrismaClient();
  let projectId: string;
  let segmentId: string;

  beforeEach(async () => {
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
    const segment = await factories.createSegment(projectId, {type: SegmentType.STATIC, trackMembership: true});
    segmentId = segment.id;
  });

  describe('optOutTopic', () => {
    const topic = (type: TemplateType, optOutSegmentId: string | null, override = false) =>
      optOutTopic({type, optOutSegmentId}, override);

    it('is the segment of a TRANSACTIONAL template sent to its contact', () => {
      expect(topic(TemplateType.TRANSACTIONAL, 'seg')).toBe('seg');
    });

    it('is none for MARKETING and HEADLESS templates, without a topic, or to a custom recipient', () => {
      expect(topic(TemplateType.MARKETING, 'seg')).toBeNull();
      expect(topic(TemplateType.HEADLESS, 'seg')).toBeNull();
      expect(topic(TemplateType.TRANSACTIONAL, null)).toBeNull();
      expect(topic(TemplateType.TRANSACTIONAL, 'seg', true)).toBeNull();
      expect(optOutTopic(null, false)).toBeNull();
    });
  });

  it('builds the link with the template, and no email id', () => {
    expect(optOutLink(API_URI, 'c 1', 't/1')).toBe(`${API_URI}/opt-out/c%201?t=t%2F1`);
    const template = {id: 't1', type: TemplateType.TRANSACTIONAL, optOutSegmentId: 'seg'};
    expect(optOutUrl('c1', template, false)).toBe(`${DASHBOARD_URI}/opt-out/c1?t=t1`);
    expect(optOutUrl('c1', template, true)).toBe('');
    expect(optOutUrl('c1', undefined, false)).toBe('');
  });

  it('reads `t` only as one non-empty string', () => {
    expect(readTemplateParam({t: 'abc'})).toBe('abc');
    expect(readTemplateParam({t: ''})).toBeUndefined();
    expect(readTemplateParam({t: ['a', 'b']})).toBeUndefined();
    expect(readTemplateParam({})).toBeUndefined();
  });

  describe('optOut', () => {
    it('puts the contact in the topic once: a second call fires no second entry', async () => {
      const contact = await factories.createContact({projectId});
      const template = await factories.createTemplate({
        projectId,
        type: TemplateType.TRANSACTIONAL,
        optOutSegmentId: segmentId,
      });
      const events = vi.spyOn(QueueService, 'queueSegmentMembershipEvents').mockResolvedValue(undefined);

      expect(await optOut(contact.id, template.id)).toBe('opted-out');
      expect(await optOut(contact.id, template.id)).toBe('opted-out');

      expect(await isOptedOut(projectId, segmentId, contact.id)).toBe(true);
      const entries = events.mock.calls.flatMap(([job]) => job.contactIds);
      expect(entries).toEqual([contact.id]);
      events.mockRestore();
    });

    it("is unavailable for another project's template, one without a topic, a deleted segment or contact", async () => {
      const contact = await factories.createContact({projectId});
      const {project: other} = await factories.createUserWithProject();
      const otherSegment = await factories.createSegment(other.id, {type: SegmentType.STATIC});
      const foreign = await factories.createTemplate({
        projectId: other.id,
        type: TemplateType.TRANSACTIONAL,
        optOutSegmentId: otherSegment.id,
      });
      const plain = await factories.createTemplate({projectId, type: TemplateType.TRANSACTIONAL});
      const marketing = await factories.createTemplate({projectId, optOutSegmentId: segmentId});
      const orphan = await factories.createTemplate({
        projectId,
        type: TemplateType.TRANSACTIONAL,
        optOutSegmentId: '00000000-0000-4000-8000-000000000000',
      });

      expect(await optOut(contact.id, foreign.id)).toBe('unavailable');
      expect(await optOut(contact.id, plain.id)).toBe('unavailable');
      expect(await optOut(contact.id, marketing.id)).toBe('unavailable');
      expect(await optOut(contact.id, orphan.id)).toBe('unavailable');
      expect(await optOut('missing-contact', plain.id)).toBe('unavailable');
      expect(await prisma.segmentMembership.count({where: {segmentId: otherSegment.id}})).toBe(0);
    });

    it('is unavailable, not an error, when the segment goes while opting out', async () => {
      const contact = await factories.createContact({projectId});
      const template = await factories.createTemplate({
        projectId,
        type: TemplateType.TRANSACTIONAL,
        optOutSegmentId: segmentId,
      });
      vi.spyOn(SegmentMembershipService, 'addMembers').mockRejectedValueOnce(
        new HttpException(404, 'Segment not found'),
      );

      expect(await optOut(contact.id, template.id)).toBe('unavailable');
      vi.restoreAllMocks();
    });
  });

  describe('assertValidTopic', () => {
    const status = async (promise: Promise<unknown>) => {
      try {
        await promise;
        return 'ok';
      } catch (error) {
        return error instanceof HttpException ? error.code : 'other';
      }
    };

    it('takes a static segment of the project on a TRANSACTIONAL template, or none', async () => {
      expect(await status(assertValidTopic(projectId, segmentId, TemplateType.TRANSACTIONAL))).toBe('ok');
      expect(await status(assertValidTopic(projectId, null, TemplateType.MARKETING))).toBe('ok');
      expect(await status(assertValidTopic(projectId, undefined, undefined))).toBe('ok');
    });

    it("refuses with a 400 a value that is not an id, a dynamic segment, another project's, or a MARKETING type", async () => {
      const dynamic = await factories.createSegment(projectId);
      const {project: other} = await factories.createUserWithProject();
      const foreign = await factories.createSegment(other.id, {type: SegmentType.STATIC});

      expect(await status(assertValidTopic(projectId, 123, TemplateType.TRANSACTIONAL))).toBe(400);
      expect(await status(assertValidTopic(projectId, {id: segmentId}, TemplateType.TRANSACTIONAL))).toBe(400);
      expect(await status(assertValidTopic(projectId, dynamic.id, TemplateType.TRANSACTIONAL))).toBe(400);
      expect(await status(assertValidTopic(projectId, foreign.id, TemplateType.TRANSACTIONAL))).toBe(400);
      expect(await status(assertValidTopic(projectId, segmentId, TemplateType.MARKETING))).toBe(400);
      // Created without a type, a template is MARKETING
      expect(await status(assertValidTopic(projectId, segmentId, undefined))).toBe(400);
    });

    it('on an update, compares a topic sent alone with the saved type', async () => {
      const transactional = await factories.createTemplate({projectId, type: TemplateType.TRANSACTIONAL});
      const marketing = await factories.createTemplate({projectId});

      expect(await status(assertValidTopic(projectId, segmentId, undefined, transactional.id))).toBe('ok');
      expect(await status(assertValidTopic(projectId, segmentId, undefined, marketing.id))).toBe(400);
    });

    it('refuses another type for a template with a topic unless the topic goes in the same request', async () => {
      const template = await factories.createTemplate({
        projectId,
        type: TemplateType.TRANSACTIONAL,
        optOutSegmentId: segmentId,
      });

      expect(await status(assertValidTopic(projectId, undefined, TemplateType.MARKETING, template.id))).toBe(400);
      expect(await status(assertValidTopic(projectId, null, TemplateType.MARKETING, template.id))).toBe('ok');
    });

    it('does not check again a saved topic whose segment is gone, so other edits go through', async () => {
      const template = await factories.createTemplate({
        projectId,
        type: TemplateType.TRANSACTIONAL,
        optOutSegmentId: segmentId,
      });
      await prisma.segment.delete({where: {id: segmentId}});

      expect(await status(assertValidTopic(projectId, undefined, undefined, template.id))).toBe('ok');
      expect(await status(assertValidTopic(projectId, segmentId, TemplateType.TRANSACTIONAL, template.id))).toBe('ok');
    });
  });

  describe('TemplateService', () => {
    it('creates, updates and duplicates the topic, and removes it with null', async () => {
      const created = await TemplateService.create(projectId, {
        name: 'Notice',
        subject: 'Hi',
        body: '<p>Hi</p>',
        from: 'hi@example.com',
        type: TemplateType.TRANSACTIONAL,
        optOutSegmentId: segmentId,
      });
      expect(created.optOutSegmentId).toBe(segmentId);

      const copy = await TemplateService.duplicate(projectId, created.id);
      expect(copy.optOutSegmentId).toBe(segmentId);

      const renamed = await TemplateService.update(projectId, created.id, {name: 'Renamed'});
      expect(renamed.optOutSegmentId).toBe(segmentId);

      const removed = await TemplateService.update(projectId, created.id, {optOutSegmentId: null});
      expect(removed.optOutSegmentId).toBeNull();
    });
  });
});
