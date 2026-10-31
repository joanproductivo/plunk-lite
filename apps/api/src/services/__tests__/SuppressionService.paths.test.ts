import {EmailStatus, WorkflowStepType} from '@plunk/db';
import {toPrismaJson} from '@plunk/types';
import type {NextFunction, Request, Response} from 'express';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {Contacts} from '../../controllers/Contacts';
import {prisma as appPrisma} from '../../database/prisma';
import {ContactService} from '../ContactService';
import {EventService} from '../EventService';
import {SegmentService} from '../SegmentService';
import {removeFromAccountSuppressionList} from '../SESService';
import {MAX_FILTERED_SUPPRESSIONS, SuppressedAddressError, SuppressionService} from '../SuppressionService';

vi.mock('../SESService', async importOriginal => ({
  ...(await importOriginal<typeof import('../SESService')>()),
  removeFromAccountSuppressionList: vi.fn(),
}));

/**
 * Every path that subscribes a contact leaves a suppressed address unsubscribed: an explicit
 * request is refused with the reason, anything that subscribes in passing just leaves it as is.
 */
describe('suppressed addresses stay unsubscribed', () => {
  const prisma = getPrismaClient();
  let projectId: string;

  beforeEach(async () => {
    ({
      project: {id: projectId},
    } = await factories.createUserWithProject());
    vi.mocked(removeFromAccountSuppressionList).mockReset().mockResolvedValue('removed');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function suppressedContact(subscribed = false) {
    const contact = await factories.createContact({projectId, subscribed});
    await SuppressionService.record(prisma, projectId, [contact.email], 'BOUNCE', 'email-1');
    return contact;
  }

  const subscribedNow = async (id: string) => (await prisma.contact.findUniqueOrThrow({where: {id}})).subscribed;

  describe('explicit requests', () => {
    it('refuses to subscribe a suppressed contact, but saves its data', async () => {
      const contact = await suppressedContact();

      await expect(ContactService.update(projectId, contact.id, {subscribed: true})).rejects.toBeInstanceOf(
        SuppressedAddressError,
      );
      await ContactService.update(projectId, contact.id, {data: {plan: 'pro'}, subscribed: false});

      expect(await subscribedNow(contact.id)).toBe(false);
    });

    it('refuses to move a subscribed contact to a suppressed address', async () => {
      const suppressed = await suppressedContact();
      await prisma.contact.delete({where: {id: suppressed.id}});
      const contact = await factories.createContact({projectId, subscribed: true});

      await expect(ContactService.update(projectId, contact.id, {email: suppressed.email})).rejects.toBeInstanceOf(
        SuppressedAddressError,
      );
    });

    it('refuses the dashboard form, and tells an API key why the contact stayed unsubscribed', async () => {
      const contact = await suppressedContact();

      const call = (type: 'jwt' | 'apiKey') =>
        new Promise<{status?: number; body?: {subscribed: boolean; _meta: {suppressed?: unknown}}; error?: unknown}>(
          resolve => {
            const res = {
              locals: {auth: {type, projectId}},
              status(status: number) {
                return {json: (body: never) => resolve({status, body})};
              },
            } as unknown as Response;
            void new Contacts().create({body: {email: contact.email, subscribed: true}} as Request, res, (error =>
              resolve({error})) as NextFunction);
          },
        );

      expect((await call('jwt')).error).toBeInstanceOf(SuppressedAddressError);
      const fromKey = await call('apiKey');
      expect(fromKey.body?.subscribed).toBe(false);
      expect(fromKey.body?._meta.suppressed).toMatchObject({reason: 'BOUNCE'});
    });
  });

  describe('subscribing in passing', () => {
    it('leaves an existing contact unsubscribed, without a contact.subscribed event', async () => {
      const contact = await suppressedContact();
      const track = vi.spyOn(EventService, 'trackEvent');

      await ContactService.upsert(projectId, contact.email, {source: 'track'}, true);

      expect(await subscribedNow(contact.id)).toBe(false);
      expect(track).not.toHaveBeenCalledWith(projectId, 'contact.subscribed', contact.id);
    });

    it('creates a contact again unsubscribed after it was deleted', async () => {
      const contact = await suppressedContact();
      await prisma.contact.delete({where: {id: contact.id}});

      const created = await ContactService.upsert(projectId, contact.email);

      expect(created.subscribed).toBe(false);
    });

    it('ends the snooze of a suppressed contact unsubscribed, and wakes the others', async () => {
      const past = new Date(Date.now() - 60_000);
      const suppressed = await suppressedContact();
      await prisma.contact.update({where: {id: suppressed.id}, data: {snoozedUntil: past}});
      const other = await factories.createContact({projectId, subscribed: false});
      await prisma.contact.update({where: {id: other.id}, data: {snoozedUntil: past}});

      await ContactService.resumeExpiredSnoozes();

      const rows = await prisma.contact.findMany({where: {id: {in: [suppressed.id, other.id]}}});
      const byId = new Map(rows.map(row => [row.id, row]));
      expect(byId.get(suppressed.id)).toMatchObject({subscribed: false, snoozedUntil: null});
      expect(byId.get(other.id)).toMatchObject({subscribed: true, snoozedUntil: null});
    });

    it('leaves suppressed contacts out of a bulk subscribe, and counts them', async () => {
      const suppressed = await suppressedContact();
      const other = await factories.createContact({projectId, subscribed: false});

      const result = await ContactService.bulkSubscribe(projectId, [suppressed.id, other.id]);

      expect(result).toEqual({updated: 1, unchanged: 0, suppressed: 1});
      expect(await subscribedNow(suppressed.id)).toBe(false);
    });

    it('creates a missing segment member unsubscribed', async () => {
      const contact = await suppressedContact();
      await prisma.contact.delete({where: {id: contact.id}});
      const segment = await prisma.segment.create({data: {projectId, name: 'List', type: 'STATIC'}});

      await SegmentService.addContacts(projectId, segment.id, [contact.email], true);

      expect((await prisma.contact.findFirstOrThrow({where: {projectId, email: contact.email}})).subscribed).toBe(
        false,
      );
      // Plunk Lite: so is any other, since joining a segment is not a sign-up
      await SegmentService.addContacts(projectId, segment.id, ['fresh@plunk.test'], true);
      expect((await prisma.contact.findFirstOrThrow({where: {projectId, email: 'fresh@plunk.test'}})).subscribed).toBe(
        false,
      );
    });

    it("leaves a workflow's subscribe step without effect", async () => {
      const contact = await suppressedContact();
      const workflow = await factories.createWorkflow({
        projectId,
        enabled: true,
        triggerConfig: {eventName: 'test.subscribe'},
      });
      const trigger = await prisma.workflowStep.findFirstOrThrow({
        where: {workflowId: workflow.id, type: WorkflowStepType.TRIGGER},
      });
      await prisma.workflowStep.update({
        where: {id: trigger.id},
        data: {config: toPrismaJson({eventName: 'test.subscribe'})},
      });
      const step = await prisma.workflowStep.create({
        data: {
          workflowId: workflow.id,
          type: WorkflowStepType.UPDATE_CONTACT,
          name: 'subscribe',
          position: {x: 100, y: 0},
          config: toPrismaJson({subscriptionAction: 'subscribe'}),
        },
      });
      await prisma.workflowTransition.create({data: {fromStepId: trigger.id, toStepId: step.id}});

      const control = await factories.createContact({projectId, subscribed: false});

      await EventService.trackEvent(projectId, 'test.subscribe', contact.id);
      await EventService.trackEvent(projectId, 'test.subscribe', control.id);

      expect(await subscribedNow(contact.id)).toBe(false);
      // The same step does subscribe an address that is not suppressed
      expect(await subscribedNow(control.id)).toBe(true);
    });
  });

  describe('the public subscribe page', () => {
    /** A contact suppressed by a bounce SES attempted, as the webhook records it */
    async function attemptedBounce() {
      const contact = await factories.createContact({projectId, subscribed: false});
      const bounced = await emailOf(contact.id, EmailStatus.BOUNCED);
      await prisma.email.update({where: {id: bounced.id}, data: {bouncedAt: new Date()}});
      await SuppressionService.record(prisma, projectId, [contact.email], 'BOUNCE', bounced.id);
      return contact;
    }

    async function emailOf(contactId: string, status: EmailStatus, headers?: object) {
      return prisma.email.create({
        data: {
          projectId,
          contactId,
          subject: 'News',
          body: '<p>news</p>',
          from: 'hello@plunk.test',
          sourceType: 'CAMPAIGN',
          status,
          sentAt: new Date(),
          ...(headers && {headers}),
        },
      });
    }

    it('refuses a suppressed contact without an email that reached them', async () => {
      const contact = await suppressedContact();
      const bounced = await emailOf(contact.id, EmailStatus.BOUNCED);
      const custom = await emailOf(contact.id, EmailStatus.DELIVERED, {'X-Plunk-Recipient-Override': 'x@y.test'});

      await expect(ContactService.subscribe(contact.id)).rejects.toThrow(/cannot be resubscribed/);
      await expect(ContactService.subscribe(contact.id, {emailId: bounced.id})).rejects.toThrow(
        /cannot be resubscribed/,
      );
      await expect(ContactService.subscribe(contact.id, {emailId: custom.id})).rejects.toThrow(
        /cannot be resubscribed/,
      );
      expect(await subscribedNow(contact.id)).toBe(false);
    });

    it('lets its owner resubscribe from an email they received, lifting the suppression', async () => {
      const contact = await attemptedBounce();
      const delivered = await emailOf(contact.id, EmailStatus.DELIVERED);

      await ContactService.subscribe(contact.id, {emailId: delivered.id});

      expect(await subscribedNow(contact.id)).toBe(true);
      expect(await SuppressionService.find(projectId, contact.email)).toBeNull();
      expect(removeFromAccountSuppressionList).toHaveBeenCalledWith(contact.email);
    });

    it('still subscribes when the IAM policy does not let SES be touched', async () => {
      vi.mocked(removeFromAccountSuppressionList).mockResolvedValue('not_allowed');
      const contact = await attemptedBounce();
      const delivered = await emailOf(contact.id, EmailStatus.DELIVERED);

      await ContactService.subscribe(contact.id, {emailId: delivered.id});

      expect(await subscribedNow(contact.id)).toBe(true);
    });

    it('does not take off SES a complaint recorded as a bounce, on clicking twice', async () => {
      const contact = await factories.createContact({projectId, subscribed: false});
      await SuppressionService.record(prisma, projectId, [contact.email], 'COMPLAINT', 'email-1');
      const delivered = await emailOf(contact.id, EmailStatus.DELIVERED);

      await ContactService.subscribe(contact.id, {emailId: delivered.id});
      // The next email bounces as already on the account's list, which records no `bouncedAt`
      const blocked = await emailOf(contact.id, EmailStatus.BOUNCED);
      await SuppressionService.record(prisma, projectId, [contact.email], 'BOUNCE', blocked.id);
      await ContactService.subscribe(contact.id, {emailId: delivered.id});

      expect(removeFromAccountSuppressionList).not.toHaveBeenCalled();
    });

    it('leaves everything as it was when SES does not answer, so its owner can try again', async () => {
      vi.mocked(removeFromAccountSuppressionList).mockResolvedValue('unavailable');
      const contact = await attemptedBounce();
      const delivered = await emailOf(contact.id, EmailStatus.DELIVERED);

      await expect(ContactService.subscribe(contact.id, {emailId: delivered.id})).rejects.toMatchObject({code: 503});

      expect(await subscribedNow(contact.id)).toBe(false);
      expect(await SuppressionService.find(projectId, contact.email)).not.toBeNull();
    });

    it('does not take a complaint off the list at SES from the public page', async () => {
      const contact = await factories.createContact({projectId, subscribed: false});
      await SuppressionService.record(prisma, projectId, [contact.email], 'COMPLAINT', 'email-1');
      const delivered = await emailOf(contact.id, EmailStatus.DELIVERED);

      await ContactService.subscribe(contact.id, {emailId: delivered.id});

      expect(await subscribedNow(contact.id)).toBe(true);
      expect(await SuppressionService.find(projectId, contact.email)).toBeNull();
      expect(removeFromAccountSuppressionList).not.toHaveBeenCalled();
    });
  });

  describe('lift', () => {
    it.each(['removed', 'not_listed', 'not_allowed'] as const)('removes the row when SES answers %s', async ses => {
      vi.mocked(removeFromAccountSuppressionList).mockResolvedValue(ses);
      const contact = await suppressedContact();

      expect(await SuppressionService.lift(projectId, contact.email, {ses: 'any'})).toEqual({lifted: true, ses});
      expect(await SuppressionService.find(projectId, contact.email)).toBeNull();
    });

    it('keeps the row when SES does not answer', async () => {
      vi.mocked(removeFromAccountSuppressionList).mockResolvedValue('unavailable');
      const contact = await suppressedContact();

      await expect(SuppressionService.lift(projectId, contact.email, {ses: 'any'})).rejects.toMatchObject({code: 503});

      expect(await SuppressionService.find(projectId, contact.email)).not.toBeNull();
    });

    it('leaves the list at SES alone for an address not suppressed in this project', async () => {
      const contact = await factories.createContact({projectId, subscribed: false});

      expect(await SuppressionService.lift(projectId, contact.email, {ses: 'any'})).toEqual({lifted: false});

      expect(removeFromAccountSuppressionList).not.toHaveBeenCalled();
    });

    it('leaves the list at SES alone for an address from an import, which this project never sent to', async () => {
      const contact = await factories.createContact({projectId, subscribed: false});
      await SuppressionService.record(prisma, projectId, [contact.email], 'COMPLAINT', null);

      expect(await SuppressionService.lift(projectId, contact.email, {ses: 'any'})).toEqual({lifted: true});

      expect(removeFromAccountSuppressionList).not.toHaveBeenCalled();
    });
  });

  describe('addressesOfContacts', () => {
    it('leaves out the addresses without a contact, and other projects', async () => {
      const contact = await suppressedContact();
      await SuppressionService.record(prisma, projectId, ['gone@example.com'], 'BOUNCE', null);
      const other = await factories.createUserWithProject();
      await factories.createContact({projectId: other.project.id, email: 'other@example.com'});
      await SuppressionService.record(prisma, other.project.id, ['other@example.com'], 'BOUNCE', null);

      expect(await SuppressionService.addressesOfContacts(projectId)).toEqual([contact.email]);
    });

    it('refuses more than it can filter on', async () => {
      const rows = Array.from({length: MAX_FILTERED_SUPPRESSIONS + 1}, (_, n) => ({email: `c${n}@example.com`}));
      vi.spyOn(appPrisma, '$queryRaw').mockResolvedValueOnce(rows as never);

      await expect(SuppressionService.addressesOfContacts(projectId)).rejects.toMatchObject({code: 400});
    });
  });

  describe('the contact list', () => {
    function list(query: Record<string, string>) {
      return new Promise<{data: {email: string; suppression: {reason: string} | null}[]; total: number}>(
        (resolve, reject) => {
          const res = {
            locals: {auth: {type: 'jwt', projectId}},
            status() {
              return {json: resolve};
            },
          } as unknown as Response;
          void new Contacts().list({query} as unknown as Request, res, reject as NextFunction);
        },
      );
    }

    it('says on each row whether its address is suppressed, and filters on it', async () => {
      const suppressed = await suppressedContact();
      await factories.createContact({projectId, subscribed: false});

      const everyone = await list({});
      expect(everyone.data).toHaveLength(2);
      expect(everyone.data.find(c => c.email === suppressed.email)?.suppression?.reason).toBe('BOUNCE');
      expect(everyone.data.find(c => c.email !== suppressed.email)?.suppression).toBeNull();

      const filtered = await list({status: 'suppressed'});
      expect(filtered.total).toBe(1);
      expect(filtered.data.map(c => c.email)).toEqual([suppressed.email]);
    });
  });

  describe('the contact page', () => {
    function liftAs(type: 'jwt' | 'apiKey', contactId: string) {
      return new Promise<{status?: number; body?: unknown; error?: {code?: number}}>(resolve => {
        const res = {
          locals: {auth: {type, projectId}},
          status(status: number) {
            return {json: (body: unknown) => resolve({status, body})};
          },
        } as unknown as Response;
        void new Contacts().liftSuppression({params: {id: contactId}} as unknown as Request, res, (error =>
          resolve({error})) as NextFunction);
      });
    }

    it('lifts a suppression only from a dashboard session', async () => {
      const contact = await suppressedContact();

      expect((await liftAs('apiKey', contact.id)).error?.code).toBe(403);
      expect(await SuppressionService.find(projectId, contact.email)).not.toBeNull();

      const lifted = await liftAs('jwt', contact.id);
      expect(lifted.status).toBe(200);
      expect(lifted.body).toEqual({success: true, lifted: true, ses: 'removed'});
      expect(await SuppressionService.find(projectId, contact.email)).toBeNull();
    });
  });
});
