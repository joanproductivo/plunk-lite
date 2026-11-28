import {SegmentType, TemplateType} from '@plunk/db';
import type {Request, Response} from 'express';
import {beforeEach, describe, expect, it, vi} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {DASHBOARD_URI} from '../../app/constants';
import {HttpException} from '../../exceptions/index.js';
import {SegmentMembershipService} from '../../services/SegmentMembershipService';
import {OptOut} from '../OptOut';

/** A response double: `sent` resolves once the controller answered (CatchAsync does not return it) */
function mockResponse() {
  const captured: {status: number; body?: unknown; redirectedTo?: string} = {status: 200};
  let markSent: () => void;
  const sent = new Promise<void>(resolve => {
    markSent = resolve;
  });
  const res = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    type() {
      return this;
    },
    json(body: unknown) {
      captured.body = body;
      markSent();
      return this;
    },
    send(body: unknown) {
      captured.body = body;
      markSent();
      return this;
    },
    redirect(code: number, url: string) {
      captured.status = code;
      captured.redirectedTo = url;
      markSent();
      return this;
    },
  } as unknown as Response;
  return {res, captured, sent};
}

/**
 * Plunk Lite: the opt-out link of a transactional template with an opt-out topic. One-click POSTs
 * (RFC 8058) and the page's button answer 200 whatever happens.
 */
describe('OptOut controller', () => {
  const prisma = getPrismaClient();
  const controller = new OptOut();
  const next = vi.fn();
  let projectId: string;
  let segmentId: string;
  let templateId: string;

  beforeEach(async () => {
    next.mockReset();
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
    segmentId = (await factories.createSegment(projectId, {type: SegmentType.STATIC})).id;
    templateId = (
      await factories.createTemplate({projectId, type: TemplateType.TRANSACTIONAL, optOutSegmentId: segmentId})
    ).id;
  });

  async function post(id: string, query: Record<string, unknown>, body?: unknown) {
    const {res, captured, sent} = mockResponse();
    void controller.oneClick({params: {id}, query, body} as unknown as Request, res, next);
    await sent;
    expect(next).not.toHaveBeenCalled();
    return captured;
  }

  it('puts the contact in the topic on a one-click POST, whatever its form body', async () => {
    const contact = await factories.createContact({projectId});

    const answer = await post(contact.id, {t: templateId}, 'List-Unsubscribe=One-Click');

    expect(answer).toMatchObject({status: 200, body: {status: 'opted-out'}});
    const membership = await prisma.segmentMembership.findUnique({
      where: {contactId_segmentId: {contactId: contact.id, segmentId}},
    });
    expect(membership?.exitedAt).toBeNull();
  });

  it('answers 200 unavailable without `t`, with `t` repeated, or for an unknown contact', async () => {
    const contact = await factories.createContact({projectId});

    expect(await post(contact.id, {})).toMatchObject({status: 200, body: {status: 'unavailable'}});
    expect(await post(contact.id, {t: [templateId, templateId]})).toMatchObject({
      status: 200,
      body: {status: 'unavailable'},
    });
    expect(await post('unknown', {t: templateId})).toMatchObject({status: 200, body: {status: 'unavailable'}});
    expect(await prisma.segmentMembership.count({where: {segmentId}})).toBe(0);
  });

  it('answers 200 unavailable, not 404, when the segment goes between the read and the write', async () => {
    const contact = await factories.createContact({projectId});
    vi.spyOn(SegmentMembershipService, 'addMembers').mockRejectedValueOnce(new HttpException(404, 'Segment not found'));

    expect(await post(contact.id, {t: templateId})).toMatchObject({status: 200, body: {status: 'unavailable'}});
    vi.restoreAllMocks();
  });

  it('answers 500, not unavailable, when the database fails, so the provider or the page tries again', async () => {
    const contact = await factories.createContact({projectId});
    vi.spyOn(SegmentMembershipService, 'addMembers').mockRejectedValueOnce(new Error('database down'));

    const {res} = mockResponse();
    const failed = new Promise<unknown>(resolve => next.mockImplementationOnce(resolve));
    void controller.oneClick({params: {id: contact.id}, query: {t: templateId}} as unknown as Request, res, next);

    expect(await failed).toEqual(new Error('database down'));
    vi.restoreAllMocks();
  });

  it('redirects a GET to the dashboard page with the template', async () => {
    const {res, captured, sent} = mockResponse();
    controller.redirect({params: {id: 'c 1'}, query: {t: templateId}} as unknown as Request, res, next);
    await sent;

    expect(captured).toMatchObject({status: 302, redirectedTo: `${DASHBOARD_URI}/opt-out/c%201?t=${templateId}`});
  });

  it('takes a campaign with `c`, on POST and GET, and neither with `t` and `c` together', async () => {
    const contact = await factories.createContact({projectId});
    const campaignId = (
      await factories.createCampaign({projectId, type: TemplateType.TRANSACTIONAL, optOutSegmentId: segmentId})
    ).id;

    expect(await post(contact.id, {t: templateId, c: campaignId})).toMatchObject({
      status: 200,
      body: {status: 'unavailable'},
    });
    expect(await prisma.segmentMembership.count({where: {segmentId}})).toBe(0);

    expect(await post(contact.id, {c: campaignId})).toMatchObject({status: 200, body: {status: 'opted-out'}});
    expect(await prisma.segmentMembership.count({where: {segmentId, contactId: contact.id, exitedAt: null}})).toBe(1);

    const {res, captured, sent} = mockResponse();
    controller.redirect({params: {id: contact.id}, query: {c: campaignId}} as unknown as Request, res, next);
    await sent;
    expect(captured).toMatchObject({
      status: 302,
      redirectedTo: `${DASHBOARD_URI}/opt-out/${contact.id}?c=${campaignId}`,
    });

    const both = mockResponse();
    controller.redirect(
      {params: {id: contact.id}, query: {c: campaignId, t: templateId}} as unknown as Request,
      both.res,
      next,
    );
    await both.sent;
    expect(both.captured.redirectedTo).toBe(`${DASHBOARD_URI}/opt-out/${contact.id}`);
  });
});
