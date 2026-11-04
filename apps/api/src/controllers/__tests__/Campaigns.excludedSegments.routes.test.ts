import {randomUUID} from 'node:crypto';

import {Server} from '@overnightjs/core';
import {CampaignAudienceType, SegmentType} from '@plunk/db';
import {CAMPAIGN_EXCLUDED_SEGMENTS_MAX} from '@plunk/shared';
import cookies from 'cookie-parser';
import {json, type NextFunction, type Request, type Response} from 'express';
import request from 'supertest';
import {beforeEach, describe, expect, it} from 'vitest';
import {ZodError} from 'zod';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {HttpException} from '../../exceptions/index';
import {Campaigns} from '../Campaigns';

/** The campaign routes behind their real middlewares, with the API's status for each error */
function createApp() {
  const server = new (class extends Server {})();
  server.app.use(json());
  server.app.use(cookies());
  server.addControllers([new Campaigns()]);
  server.app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = error instanceof HttpException ? error.code : error instanceof ZodError ? 422 : 500;
    res.status(status).json({success: false});
  });
  return server.app;
}

/** Plunk Lite: the segments a campaign leaves out, as POST and PUT /campaigns take them */
describe('excludedSegmentIds on the campaign routes', () => {
  const prisma = getPrismaClient();
  const app = createApp();
  let project: {id: string; secret: string};
  let segmentId: string;

  const ids = (count: number) => Array.from({length: count}, () => randomUUID());
  const campaign = {
    name: 'Newsletter',
    subject: 'Hi',
    body: '<p>Hi</p>',
    from: 'news@example.com',
    audienceType: CampaignAudienceType.ALL,
  };

  beforeEach(async () => {
    const created = await factories.createUserWithProject();
    project = created.project;
    await prisma.user.update({where: {id: created.user.id}, data: {emailVerified: true}});
    await factories.createDomain({projectId: project.id, domain: 'example.com'});
    segmentId = (await factories.createSegment(project.id, {type: SegmentType.STATIC})).id;
  });

  const post = (body: object) =>
    request(app).post('/campaigns').set('Authorization', `Bearer ${project.secret}`).send(body);
  const put = (id: string, body: object) =>
    request(app).put(`/campaigns/${id}`).set('Authorization', `Bearer ${project.secret}`).send(body);

  it('creates a campaign with them', async () => {
    const res = await post({...campaign, excludedSegmentIds: [segmentId]});

    expect(res.status).toBe(201);
    expect(res.body.data.excludedSegmentIds).toEqual([segmentId]);
  });

  it('refuses more than the maximum, or ids that are not segment ids', async () => {
    expect((await post({...campaign, excludedSegmentIds: ids(CAMPAIGN_EXCLUDED_SEGMENTS_MAX + 1)})).status).toBe(422);
    expect((await post({...campaign, excludedSegmentIds: ['not-an-id']})).status).toBe(422);
  });

  it('saves them on an update, cleaned up, and refuses a malformed list', async () => {
    const draft = await factories.createCampaign({projectId: project.id});

    const res = await put(draft.id, {excludedSegmentIds: [segmentId, segmentId]});
    expect(res.status).toBe(200);
    expect(res.body.data.excludedSegmentIds).toEqual([segmentId]);

    expect((await put(draft.id, {excludedSegmentIds: ['not-an-id']})).status).toBe(422);
    expect((await put(draft.id, {excludedSegmentIds: ids(CAMPAIGN_EXCLUDED_SEGMENTS_MAX + 1)})).status).toBe(422);
  });

  it('refuses a segment of another project', async () => {
    const other = (await factories.createUserWithProject()).project.id;
    const theirs = await factories.createSegment(other, {type: SegmentType.STATIC});

    expect((await post({...campaign, excludedSegmentIds: [theirs.id]})).status).toBe(400);
  });
});
