import type {Request} from 'express';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {createResponse, factories, getPrismaClient, runHandler} from '../../../../../test/helpers';
import {Actions} from '../../controllers/Actions.js';
import {requireTrackKey} from '../../middleware/auth.js';
import {QueueService} from '../../services/QueueService.js';

type Body = {success: boolean; data: Record<string, unknown>};

/**
 * Plunk Lite: /v1/track subscribes no one unless the call says so. A new contact is created
 * unsubscribed unless `subscribed: true`, as /v1/send does, and an existing one keeps its state
 * unless the call passes a value.
 */
describe('subscription on /v1/track', () => {
  const prisma = getPrismaClient();
  let project: {id: string; public: string; secret: string};

  beforeEach(async () => {
    project = (await factories.createUserWithProject()).project;
    vi.spyOn(QueueService, 'queueSegmentMembershipEvents').mockResolvedValue({} as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function track(key: string, body: Record<string, unknown>) {
    const req = {method: 'POST', path: '/v1/track', headers: {authorization: `Bearer ${key}`}, body} as Request;
    const actions = new Actions();
    return runHandler<Body>(actions.track.bind(actions), req, createResponse(), requireTrackKey);
  }

  const contactNamed = (email: string) => prisma.contact.findFirstOrThrow({where: {projectId: project.id, email}});
  const subscriptionEvents = (contactId: string) =>
    prisma.event.count({where: {contactId, name: {in: ['contact.subscribed', 'contact.unsubscribed']}}});

  it('creates a new contact unsubscribed when the call does not say', async () => {
    const outcome = await track(project.secret, {event: 'purchase', email: 'ana@example.com'});

    expect(outcome.status).toBe(200);
    const contact = await contactNamed('ana@example.com');
    expect(contact.subscribed).toBe(false);
    expect(await prisma.event.count({where: {contactId: contact.id, name: 'purchase'}})).toBe(1);
  });

  it('creates a new contact subscribed with subscribed: true', async () => {
    const outcome = await track(project.secret, {event: 'signup', email: 'ana@example.com', subscribed: true});

    expect(outcome.status).toBe(200);
    expect((await contactNamed('ana@example.com')).subscribed).toBe(true);
  });

  it('creates a new contact unsubscribed with the public key too', async () => {
    const outcome = await track(project.public, {event: 'purchase', email: 'ana@example.com'});

    expect(outcome.status).toBe(200);
    expect((await contactNamed('ana@example.com')).subscribed).toBe(false);
  });

  it('keeps a subscribed contact subscribed when the call does not say', async () => {
    const existing = await factories.createContact({projectId: project.id, email: 'ana@example.com', subscribed: true});

    const outcome = await track(project.secret, {event: 'purchase', email: 'ana@example.com'});

    expect(outcome.status).toBe(200);
    expect((await contactNamed('ana@example.com')).subscribed).toBe(true);
    expect(await subscriptionEvents(existing.id)).toBe(0);
  });

  it('keeps an unsubscribed contact unsubscribed when the call does not say', async () => {
    const existing = await factories.createContact({
      projectId: project.id,
      email: 'ana@example.com',
      subscribed: false,
    });

    const outcome = await track(project.secret, {event: 'purchase', email: 'ana@example.com'});

    expect(outcome.status).toBe(200);
    expect((await contactNamed('ana@example.com')).subscribed).toBe(false);
    expect(await subscriptionEvents(existing.id)).toBe(0);
  });

  it('adds a new contact to its segments without subscribing it', async () => {
    const segment = await prisma.segment.create({
      data: {projectId: project.id, name: 'Buyers', type: 'STATIC', trackMembership: true},
    });

    const outcome = await track(project.secret, {event: 'purchase', email: 'ana@example.com', segments: [segment.id]});

    expect(outcome.status).toBe(200);
    const contact = await contactNamed('ana@example.com');
    expect(contact.subscribed).toBe(false);
    expect(
      await prisma.segmentMembership.count({where: {segmentId: segment.id, contactId: contact.id, exitedAt: null}}),
    ).toBe(1);
  });
});
