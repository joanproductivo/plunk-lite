import type {Request} from 'express';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {createResponse, factories, getPrismaClient, runHandler} from '../../../../../test/helpers';
import {Actions} from '../../controllers/Actions.js';
import {Contacts} from '../../controllers/Contacts.js';
import {prisma as appPrisma} from '../../database/prisma.js';
import {HttpException} from '../../exceptions/index.js';
import {requireTrackKey} from '../../middleware/auth.js';
import {ContactService} from '../../services/ContactService.js';
import {EmailService} from '../../services/EmailService.js';
import {EventService} from '../../services/EventService.js';
import {QueueService} from '../../services/QueueService.js';
import {SegmentMembershipService} from '../../services/SegmentMembershipService.js';
import {SuppressionService} from '../../services/SuppressionService.js';

type Body = Record<string, unknown> & {data?: Record<string, unknown>};

/**
 * Plunk Lite: a contact is subscribed only when the call asks for it, and `contact.subscribed` fires
 * whenever a write subscribes one -- a new contact too, not only one that existed unsubscribed.
 */
describe('sign-ups and contact.subscribed', () => {
  const prisma = getPrismaClient();
  let project: {id: string; public: string; secret: string};

  beforeEach(async () => {
    project = (await factories.createUserWithProject()).project;
    vi.spyOn(QueueService, 'queueSegmentMembershipEvents').mockResolvedValue({} as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const apiKey = () => ({type: 'apiKey', key: 'secret', projectId: project.id});
  const contactNamed = (email: string) => prisma.contact.findFirstOrThrow({where: {projectId: project.id, email}});
  const subscribedEvents = (contactId: string) => prisma.event.count({where: {contactId, name: 'contact.subscribed'}});

  function create(auth: Record<string, unknown>, body: Record<string, unknown>) {
    const contacts = new Contacts();
    return runHandler<Body>(contacts.create.bind(contacts), {body} as Request, createResponse({auth}));
  }

  function track(key: string, body: Record<string, unknown>) {
    const req = {method: 'POST', path: '/v1/track', headers: {authorization: `Bearer ${key}`}, body} as Request;
    const actions = new Actions();
    return runHandler<Body>(actions.track.bind(actions), req, createResponse(), requireTrackKey);
  }

  function send(body: Record<string, unknown>) {
    const req = {method: 'POST', path: '/v1/send', headers: {}, body} as unknown as Request;
    const actions = new Actions();
    return runHandler<Body>(actions.send.bind(actions), req, createResponse({auth: apiKey()}));
  }

  function update(contactId: string, body: Record<string, unknown>) {
    const contacts = new Contacts();
    const req = {params: {id: contactId}, body} as unknown as Request;
    return runHandler<Body>(contacts.update.bind(contacts), req, createResponse({auth: apiKey()}));
  }

  describe('POST /contacts with an API key', () => {
    it('creates a new contact unsubscribed, and tells no workflow, when the call does not say', async () => {
      const outcome = await create(apiKey(), {email: 'ana@example.com', data: {plan: 'pro'}});

      expect(outcome.status).toBe(201);
      const contact = await contactNamed('ana@example.com');
      expect(contact.subscribed).toBe(false);
      expect(await subscribedEvents(contact.id)).toBe(0);
    });

    it('subscribes a new contact with subscribed: true, and fires contact.subscribed once', async () => {
      const outcome = await create(apiKey(), {email: 'ana@example.com', subscribed: true});

      expect(outcome.status).toBe(201);
      const contact = await contactNamed('ana@example.com');
      expect(contact.subscribed).toBe(true);
      expect(await subscribedEvents(contact.id)).toBe(1);
    });

    it('leaves an existing contact as it was when the call does not say', async () => {
      const subscribed = await factories.createContact({projectId: project.id, subscribed: true});
      const unsubscribed = await factories.createContact({projectId: project.id, subscribed: false});

      for (const contact of [subscribed, unsubscribed]) {
        expect((await create(apiKey(), {email: contact.email, data: {plan: 'pro'}})).status).toBe(200);
        const now = await prisma.contact.findUniqueOrThrow({where: {id: contact.id}});
        expect(now.subscribed).toBe(contact.subscribed);
        expect(await subscribedEvents(contact.id)).toBe(0);
      }
    });

    it('still subscribes the contact when contact.subscribed cannot be tracked', async () => {
      const tracked = vi.spyOn(EventService, 'trackEvent').mockRejectedValueOnce(new Error('database down'));

      const outcome = await create(apiKey(), {email: 'ana@example.com', subscribed: true});

      expect(outcome.status).toBe(201);
      const contact = await contactNamed('ana@example.com');
      expect(contact.subscribed).toBe(true);
      expect(tracked).toHaveBeenCalledWith(project.id, 'contact.subscribed', contact.id);
    });

    it('refuses a subscribed that is not true or false, here and on PATCH', async () => {
      const contact = await factories.createContact({projectId: project.id, subscribed: false});

      expect((await create(apiKey(), {email: 'ana@example.com', subscribed: 'false'})).status).toBe(400);
      expect((await update(contact.id, {subscribed: 'yes'})).status).toBe(400);
      expect(await prisma.contact.count({where: {projectId: project.id, email: 'ana@example.com'}})).toBe(0);
      expect((await prisma.contact.findUniqueOrThrow({where: {id: contact.id}})).subscribed).toBe(false);
    });
  });

  describe('/v1/track', () => {
    it('fires contact.subscribed for a new sign-up once it is in its segments, before the event', async () => {
      const segment = await prisma.segment.create({
        data: {projectId: project.id, name: 'Newsletter', type: 'STATIC', trackMembership: true},
      });
      const entered = vi.spyOn(SegmentMembershipService, 'enterSegments');
      const tracked = vi.spyOn(EventService, 'trackEvent');

      const outcome = await track(project.secret, {
        event: 'signup',
        email: 'ana@example.com',
        subscribed: true,
        segments: [segment.id],
      });

      expect(outcome.status).toBe(200);
      const contact = await contactNamed('ana@example.com');
      expect(contact.subscribed).toBe(true);
      expect(await subscribedEvents(contact.id)).toBe(1);
      const names = tracked.mock.calls.map(call => call[1]);
      const subscribedCall = names.indexOf('contact.subscribed');
      expect(subscribedCall).toBeGreaterThanOrEqual(0);
      expect(subscribedCall).toBeLessThan(names.indexOf('signup'));
      expect(entered.mock.invocationCallOrder[0]).toBeLessThan(tracked.mock.invocationCallOrder[subscribedCall]!);
    });

    it('fires nothing for a new contact the call does not subscribe', async () => {
      await track(project.secret, {event: 'purchase', email: 'ana@example.com'});

      expect(await subscribedEvents((await contactNamed('ana@example.com')).id)).toBe(0);
    });

    it('fires nothing for a new contact the public key subscribes', async () => {
      const outcome = await track(project.public, {event: 'signup', email: 'ana@example.com', subscribed: true});

      expect(outcome.status).toBe(200);
      const contact = await contactNamed('ana@example.com');
      expect(contact.subscribed).toBe(true);
      expect(await subscribedEvents(contact.id)).toBe(0);
    });

    it('fires nothing for a suppressed address, which stays unsubscribed', async () => {
      await SuppressionService.record(prisma, project.id, ['ana@example.com'], 'COMPLAINT', null);

      await track(project.secret, {event: 'signup', email: 'ana@example.com', subscribed: true});

      const contact = await contactNamed('ana@example.com');
      expect(contact.subscribed).toBe(false);
      expect(await subscribedEvents(contact.id)).toBe(0);
    });

    it('still subscribes, and tells the workflows, when contact.subscribed cannot be tracked', async () => {
      const tracked = vi.spyOn(EventService, 'trackEvent').mockRejectedValueOnce(new Error('database down'));

      const outcome = await track(project.secret, {event: 'signup', email: 'ana@example.com', subscribed: true});

      expect(outcome.status).toBe(200);
      const contact = await contactNamed('ana@example.com');
      expect(contact.subscribed).toBe(true);
      expect(tracked).toHaveBeenCalledWith(project.id, 'contact.subscribed', contact.id);
      expect(await prisma.event.count({where: {contactId: contact.id, name: 'signup'}})).toBe(1);
    });

    it('still fires contact.subscribed when joining the segments fails', async () => {
      const segment = await prisma.segment.create({
        data: {projectId: project.id, name: 'Newsletter', type: 'STATIC', trackMembership: true},
      });
      vi.spyOn(SegmentMembershipService, 'enterSegments').mockRejectedValueOnce(new Error('database down'));

      const outcome = await track(project.secret, {
        event: 'signup',
        email: 'ana@example.com',
        subscribed: true,
        segments: [segment.id],
      });

      expect(outcome.status).toBe(500);
      expect(await subscribedEvents((await contactNamed('ana@example.com')).id)).toBe(1);
    });
  });

  describe('concurrent sign-ups', () => {
    it('fires contact.subscribed once when another request created the same sign-up meanwhile', async () => {
      await ContactService.upsertWithOptIn(project.id, 'ana@example.com', undefined, true);
      // As if the other request created it between this one's lookup and its insert
      const lookup = vi.spyOn(appPrisma.contact, 'findFirst').mockResolvedValueOnce(null);

      const {contact, becameSubscribed} = await ContactService.upsertWithOptIn(
        project.id,
        'ana@example.com',
        undefined,
        true,
      );

      expect(lookup).toHaveBeenCalledTimes(2);
      expect(becameSubscribed).toBeUndefined();
      expect(await subscribedEvents(contact.id)).toBe(1);
    });
  });

  describe('/v1/send', () => {
    it('queues contact.subscribed for a new recipient it subscribes, rather than firing it in the request', async () => {
      await factories.createDomain({projectId: project.id, domain: 'plunk.test'});
      const queued = vi.spyOn(QueueService, 'queueContactSubscriptionEvents').mockResolvedValue({} as never);

      const outcome = await send({
        to: 'ana@plunk.test',
        subject: 'Welcome',
        body: '<p>Hi</p>',
        from: 'hello@plunk.test',
        subscribed: true,
      });

      expect(outcome.status).toBe(200);
      const contact = await contactNamed('ana@plunk.test');
      expect(contact.subscribed).toBe(true);
      expect(await subscribedEvents(contact.id)).toBe(0);
      expect(queued).toHaveBeenCalledWith({
        projectId: project.id,
        eventName: 'contact.subscribed',
        contactIds: [contact.id],
      });
    });

    it('queues it for an existing recipient it subscribes too', async () => {
      await factories.createDomain({projectId: project.id, domain: 'plunk.test'});
      const existing = await factories.createContact({
        projectId: project.id,
        email: 'ana@plunk.test',
        subscribed: false,
      });
      const queued = vi.spyOn(QueueService, 'queueContactSubscriptionEvents').mockResolvedValue({} as never);

      const outcome = await send({
        to: existing.email,
        subject: 'Hi',
        body: '<p>Hi</p>',
        from: 'hello@plunk.test',
        subscribed: true,
      });

      expect(outcome.status).toBe(200);
      expect(await subscribedEvents(existing.id)).toBe(0);
      expect(queued).toHaveBeenCalledWith({
        projectId: project.id,
        eventName: 'contact.subscribed',
        contactIds: [existing.id],
      });
    });

    it('queues it even when no email could be sent, as the recipient is subscribed all the same', async () => {
      await factories.createDomain({projectId: project.id, domain: 'plunk.test'});
      const queued = vi.spyOn(QueueService, 'queueContactSubscriptionEvents').mockResolvedValue({} as never);
      vi.spyOn(EmailService, 'sendTransactionalEmail').mockRejectedValueOnce(new HttpException(400, 'Refused'));

      const outcome = await send({
        to: 'ana@plunk.test',
        subject: 'Hi',
        body: '<p>Hi</p>',
        from: 'hello@plunk.test',
        subscribed: true,
      });

      expect(outcome.status).toBe(400);
      const contact = await contactNamed('ana@plunk.test');
      expect(contact.subscribed).toBe(true);
      expect(queued).toHaveBeenCalledWith({
        projectId: project.id,
        eventName: 'contact.subscribed',
        contactIds: [contact.id],
      });
    });
  });

  describe('import', () => {
    it('fires nothing for a new contact an import subscribes', async () => {
      const {contact} = await ContactService.upsertWithOptIn(
        project.id,
        'ana@example.com',
        undefined,
        undefined,
        true,
        {
          consent: 'import',
        },
      );

      expect(contact.subscribed).toBe(true);
      expect(await subscribedEvents(contact.id)).toBe(0);
    });
  });
});
