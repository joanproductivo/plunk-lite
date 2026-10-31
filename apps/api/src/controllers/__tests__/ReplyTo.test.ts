import type {NextFunction, Request, Response} from 'express';
import {randomUUID} from 'node:crypto';
import {beforeEach, describe, expect, it} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {HttpException} from '../../exceptions/index.js';
import {Campaigns} from '../Campaigns';
import {Templates} from '../Templates';

type Handler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;
type Outcome = {status?: number; error?: unknown};

const OTHER_DOMAIN = 'info@not-verified.example.org';
const NOT_VERIFIED = 'hello@not-verified.example.org';
const REFUSED = ['info@example', '', 'a@b.com\nBcc: x@y.com'];

/** Reply-To may be on any domain, and is checked at all four points that save one; From stays on a verified domain */
describe('Reply-To on templates and campaigns', () => {
  const prisma = getPrismaClient();
  let projectId: string;
  let from: string;

  beforeEach(async () => {
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
    const domain = `${randomUUID()}.example.com`;
    await factories.createDomain({projectId, domain, verified: true});
    from = `hello@${domain}`;
  });

  /** Run a handler and resolve with the response status, or the error passed to next */
  function run(handler: Handler, target: object, req: Partial<Request>) {
    return new Promise<Outcome>(resolve => {
      const done = (status: number) => ({json: () => resolve({status})});
      const res = {
        locals: {auth: {projectId}},
        status: done,
        json: () => resolve({status: 200}),
      } as unknown as Response;
      const next: NextFunction = error => resolve({error});
      void handler.call(target, req as Request, res, next);
    });
  }

  const content = {name: 'Name', subject: 'Subject', body: '<p>Body</p>'};

  const createTemplate = (replyTo: unknown, sender = from) => {
    const controller = new Templates();
    return run(controller.create, controller, {body: {...content, from: sender, replyTo}});
  };
  const updateTemplate = (id: string, replyTo: unknown, sender?: string) => {
    const controller = new Templates();
    return run(controller.update, controller, {params: {id}, body: {replyTo, from: sender}});
  };
  const createCampaign = (replyTo: unknown, sender = from) => {
    const controller = new Campaigns();
    return run(controller['create'] as Handler, controller, {
      body: {...content, from: sender, replyTo, audienceType: 'ALL'},
    });
  };
  const updateCampaign = (id: string, replyTo: unknown, sender?: string) => {
    const controller = new Campaigns();
    return run(controller['update'] as Handler, controller, {params: {id}, body: {replyTo, from: sender}});
  };

  function expectRefused(outcome: Outcome) {
    expect(outcome.error).toBeInstanceOf(HttpException);
    expect((outcome.error as HttpException).message).toBe('Reply-To must be a valid email address');
  }

  describe('creating a template', () => {
    it('takes null', async () => {
      expect(await createTemplate(null)).toEqual({status: 201});
      expect((await prisma.template.findFirstOrThrow({where: {projectId}})).replyTo).toBeNull();
    });

    it('keeps an address on a domain that is not verified', async () => {
      expect(await createTemplate(OTHER_DOMAIN)).toEqual({status: 201});
      expect((await prisma.template.findFirstOrThrow({where: {projectId}})).replyTo).toBe(OTHER_DOMAIN);
    });

    it.each(REFUSED)('refuses %j and saves nothing', async replyTo => {
      expectRefused(await createTemplate(replyTo));
      expect(await prisma.template.count({where: {projectId}})).toBe(0);
    });

    it('still refuses a From on a domain that is not verified', async () => {
      const {error} = await createTemplate(OTHER_DOMAIN, NOT_VERIFIED);
      expect((error as HttpException).code).toBe(403);
    });
  });

  describe('updating a template', () => {
    let id: string;

    beforeEach(async () => {
      id = (await factories.createTemplate({projectId})).id;
      await prisma.template.update({where: {id}, data: {replyTo: 'before@example.com'}});
    });

    const stored = async () => (await prisma.template.findUniqueOrThrow({where: {id}})).replyTo;

    it('keeps an address on a domain that is not verified', async () => {
      expect(await updateTemplate(id, OTHER_DOMAIN)).toEqual({status: 200});
      expect(await stored()).toBe(OTHER_DOMAIN);
    });

    it('clears it with null', async () => {
      expect(await updateTemplate(id, null)).toEqual({status: 200});
      expect(await stored()).toBeNull();
    });

    it('leaves it alone when the request does not mention it', async () => {
      expect(await updateTemplate(id, undefined)).toEqual({status: 200});
      expect(await stored()).toBe('before@example.com');
    });

    it.each(REFUSED)('refuses %j and changes nothing', async replyTo => {
      expectRefused(await updateTemplate(id, replyTo));
      expect(await stored()).toBe('before@example.com');
    });

    it('still refuses a From on a domain that is not verified', async () => {
      const {error} = await updateTemplate(id, OTHER_DOMAIN, NOT_VERIFIED);
      expect((error as HttpException).code).toBe(403);
      expect(await stored()).toBe('before@example.com');
    });
  });

  describe('creating a campaign', () => {
    it('takes null', async () => {
      expect(await createCampaign(null)).toEqual({status: 201});
      expect((await prisma.campaign.findFirstOrThrow({where: {projectId}})).replyTo).toBeNull();
    });

    it('keeps an address on a domain that is not verified', async () => {
      expect(await createCampaign(OTHER_DOMAIN)).toEqual({status: 201});
      expect((await prisma.campaign.findFirstOrThrow({where: {projectId}})).replyTo).toBe(OTHER_DOMAIN);
    });

    it.each(REFUSED)('refuses %j by name and saves nothing', async replyTo => {
      expectRefused(await createCampaign(replyTo));
      expect(await prisma.campaign.count({where: {projectId}})).toBe(0);
    });

    it('still refuses a From on a domain that is not verified', async () => {
      const {error} = await createCampaign(OTHER_DOMAIN, NOT_VERIFIED);
      expect((error as HttpException).code).toBe(403);
    });
  });

  describe('updating a campaign', () => {
    let id: string;

    beforeEach(async () => {
      id = (await factories.createCampaign({projectId})).id;
      await prisma.campaign.update({where: {id}, data: {replyTo: 'before@example.com'}});
    });

    const stored = async () => (await prisma.campaign.findUniqueOrThrow({where: {id}})).replyTo;

    it('keeps an address on a domain that is not verified', async () => {
      expect(await updateCampaign(id, OTHER_DOMAIN)).toEqual({status: 200});
      expect(await stored()).toBe(OTHER_DOMAIN);
    });

    it('clears it with null', async () => {
      expect(await updateCampaign(id, null)).toEqual({status: 200});
      expect(await stored()).toBeNull();
    });

    it('leaves it alone when the request does not mention it', async () => {
      expect(await updateCampaign(id, undefined)).toEqual({status: 200});
      expect(await stored()).toBe('before@example.com');
    });

    it('still refuses a From on a domain that is not verified', async () => {
      const {error} = await updateCampaign(id, OTHER_DOMAIN, NOT_VERIFIED);
      expect((error as HttpException).code).toBe(403);
      expect(await stored()).toBe('before@example.com');
    });

    it.each(REFUSED)('refuses %j and changes nothing', async replyTo => {
      expectRefused(await updateCampaign(id, replyTo));
      expect(await stored()).toBe('before@example.com');
    });
  });
});
