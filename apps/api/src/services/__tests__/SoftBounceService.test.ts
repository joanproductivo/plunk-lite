import {EmailSourceType} from '@plunk/db';
import {beforeEach, describe, expect, it, vi} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {redis} from '../../database/redis';
import {ContactService} from '../ContactService';
import {FailureAlertService} from '../FailureAlertService';
import * as SESService from '../SESService';
import {SoftBounceService} from '../SoftBounceService';
import {SuppressionService} from '../SuppressionService';

const DAY = 24 * 60 * 60 * 1000;

describe('SoftBounceService', () => {
  const prisma = getPrismaClient();
  let projectId: string;
  let contact: {id: string; email: string};

  /** A soft bounce some days ago, of an email of its own unless one is given */
  async function softBounce(
    daysAgo: number,
    {
      subType = 'MailboxFull' as string | undefined,
      address = contact.email as string | undefined,
      emailId = undefined as string | undefined,
      delivered = false,
      replayedNow = false,
    } = {},
  ) {
    const at = new Date(Date.now() - daysAgo * DAY);
    const id = emailId ?? (await factories.createEmail({projectId, contactId: contact.id})).id;
    if (delivered) {
      await prisma.email.update({where: {id}, data: {deliveredAt: at}});
    }
    await prisma.event.create({
      data: {
        projectId,
        contactId: contact.id,
        emailId: id,
        name: 'email.softbounce',
        createdAt: replayedNow ? new Date() : at,
        data: {
          ...(subType && {bounceSubType: subType}),
          ...(address && {softBounceAddress: address}),
          ...(replayedNow && {occurredAt: at.toISOString()}),
        },
      },
    });
    return id;
  }

  async function run() {
    const email = await factories.createEmail({projectId, contactId: contact.id});
    await SoftBounceService.afterSoftBounce(projectId, contact.id, email.id);
    return SuppressionService.find(projectId, contact.email);
  }

  const fiveOverAWeek = async () => {
    for (const daysAgo of [8, 6, 4, 2, 0.5]) {
      await softBounce(daysAgo);
    }
  };

  beforeEach(async () => {
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
    contact = await factories.createContact({projectId, subscribed: true});
    await redis.del(`plunk-lite:alerts:soft-bounce-brake:${projectId}`);
  });

  it('suppresses and unsubscribes after 5 over at least 7 days, with the reason', async () => {
    await fiveOverAWeek();

    expect((await run())?.reason).toBe('SOFT_BOUNCE');

    const updated = await prisma.contact.findUnique({where: {id: contact.id}});
    expect(updated?.subscribed).toBe(false);
    const events = await prisma.event.findMany({where: {contactId: contact.id, name: 'contact.unsubscribed'}});
    expect(events.map(event => event.data)).toEqual([{reason: 'soft_bounce'}]);
  });

  it('tells the project about each one', async () => {
    await fiveOverAWeek();
    const record = vi.spyOn(FailureAlertService, 'record').mockResolvedValue(true);

    await run();

    expect(record.mock.calls[0]?.[1]).toMatchObject({sourceKey: 'brake:soft_bounce', contactEmail: contact.email});
    record.mockRestore();
  });

  it('counts no email that was opened or clicked, whatever came of its delivery event', async () => {
    const opened = await softBounce(8);
    await prisma.email.update({where: {id: opened}, data: {openedAt: new Date(Date.now() - 9 * DAY)}});
    for (const daysAgo of [6, 4, 2, 1]) {
      await softBounce(daysAgo);
    }
    expect(await run()).toBeNull();
  });

  it('counts the opt-out against the campaign of the email that reached the cut', async () => {
    await fiveOverAWeek();
    const record = vi.spyOn(ContactService, 'recordCampaignUnsubscribe').mockResolvedValue();
    const campaign = await factories.createCampaign({projectId});
    const email = await factories.createEmail({projectId, contactId: contact.id, campaignId: campaign.id});

    await SoftBounceService.afterSoftBounce(projectId, contact.id, email.id);

    expect(record).toHaveBeenCalledWith(email.id, campaign.id);
    record.mockRestore();
  });

  it('tracks no unsubscribe for a contact already off the list', async () => {
    await prisma.contact.update({where: {id: contact.id}, data: {subscribed: false}});
    await fiveOverAWeek();

    expect((await run())?.reason).toBe('SOFT_BOUNCE');
    expect(await prisma.event.count({where: {contactId: contact.id, name: 'contact.unsubscribed'}})).toBe(0);
  });

  it('does nothing with 5 in under 7 days, or 4 over a week', async () => {
    for (const daysAgo of [5, 4, 3, 2, 1]) {
      await softBounce(daysAgo);
    }
    expect(await run()).toBeNull();

    await prisma.event.deleteMany({where: {contactId: contact.id}});
    for (const daysAgo of [9, 6, 3, 0.5]) {
      await softBounce(daysAgo);
    }
    expect(await run()).toBeNull();
  });

  it('counts an email once, however many bounces it has', async () => {
    const emailId = await softBounce(8);
    for (const daysAgo of [6, 4, 2, 1]) {
      await softBounce(daysAgo, {emailId});
    }
    expect(await run()).toBeNull();
  });

  it('counts neither a subtype about the content nor an event without a subtype', async () => {
    await softBounce(8, {subType: 'ContentRejected'});
    await softBounce(6, {subType: 'MessageTooLarge'});
    await softBounce(4, {subType: undefined});
    await softBounce(2);
    await softBounce(1);
    expect(await run()).toBeNull();
  });

  it('counts General as MailboxFull', async () => {
    for (const daysAgo of [8, 6, 4, 2, 1]) {
      await softBounce(daysAgo, {subType: 'General'});
    }
    expect((await run())?.reason).toBe('SOFT_BOUNCE');
  });

  it('counts no autoresponder: an email delivered and then reported as bounced', async () => {
    await softBounce(8, {delivered: true});
    for (const daysAgo of [6, 4, 2, 1]) {
      await softBounce(daysAgo);
    }
    expect(await run()).toBeNull();
  });

  it('starts again after a delivery, open or click of another email', async () => {
    for (const field of ['deliveredAt', 'openedAt', 'clickedAt'] as const) {
      await prisma.event.deleteMany({where: {contactId: contact.id}});
      await prisma.email.deleteMany({where: {contactId: contact.id}});
      for (const daysAgo of [9, 7, 5]) {
        await softBounce(daysAgo);
      }
      const other = await factories.createEmail({projectId, contactId: contact.id});
      await prisma.email.update({where: {id: other.id}, data: {[field]: new Date(Date.now() - 4 * DAY)}});
      for (const daysAgo of [3, 1]) {
        await softBounce(daysAgo);
      }
      expect(await run()).toBeNull();
    }
  });

  it('is not started again by an inbound email from the contact', async () => {
    await fiveOverAWeek();
    const inbound = await factories.createEmail({projectId, contactId: contact.id, sourceType: EmailSourceType.INBOUND});
    await prisma.email.update({where: {id: inbound.id}, data: {deliveredAt: new Date()}});

    expect((await run())?.reason).toBe('SOFT_BOUNCE');
  });

  it('counts no bounce of another address: a workflow recipient, the simulator, a former address', async () => {
    await softBounce(8, {address: undefined});
    await softBounce(6, {address: 'former@example.com'});
    for (const daysAgo of [4, 2, 1]) {
      await softBounce(daysAgo);
    }
    expect(await run()).toBeNull();
  });

  it('judges an event taken back from the dead-letter queue by when it happened', async () => {
    // All of them recorded now: by createdAt they would span no time at all
    for (const daysAgo of [8, 6, 4, 2, 1]) {
      await softBounce(daysAgo, {replayedNow: true});
    }
    expect((await run())?.reason).toBe('SOFT_BOUNCE');
  });

  it('counts no bounce from before a delivery, even taken back from the queue after it', async () => {
    for (const daysAgo of [12, 10, 8, 6, 5]) {
      await softBounce(daysAgo, {replayedNow: true});
    }
    const other = await factories.createEmail({projectId, contactId: contact.id});
    await prisma.email.update({where: {id: other.id}, data: {deliveredAt: new Date(Date.now() - 4 * DAY)}});

    expect(await run()).toBeNull();
  });

  it('starts again when the suppression is lifted, so the next bounce does not suppress again', async () => {
    await fiveOverAWeek();
    expect(await run()).not.toBeNull();

    await SuppressionService.lift(projectId, contact.email, {ses: 'any'});
    await softBounce(0);

    expect(await run()).toBeNull();
  });

  it('starts again when the contact subscribes, but not when a snooze ends', async () => {
    for (const daysAgo of [8, 6, 4]) {
      await softBounce(daysAgo);
    }
    await prisma.event.create({
      data: {projectId, contactId: contact.id, name: 'contact.subscribed', data: {reason: 'snooze_expired'}},
    });
    for (const daysAgo of [2, 1]) {
      await softBounce(daysAgo);
    }
    expect((await run())?.reason).toBe('SOFT_BOUNCE');

    contact = await factories.createContact({projectId, subscribed: true});
    for (const daysAgo of [8, 6, 4]) {
      await softBounce(daysAgo);
    }
    await prisma.event.create({
      data: {
        projectId,
        contactId: contact.id,
        name: 'contact.subscribed',
        createdAt: new Date(Date.now() - 3 * DAY),
      },
    });
    for (const daysAgo of [2, 1]) {
      await softBounce(daysAgo);
    }
    expect(await run()).toBeNull();
  });

  it('holds back at 20 suppressions in 7 days, and alerts once', async () => {
    await prisma.plunkLiteSuppression.createMany({
      data: Array.from({length: 20}, (_, i) => ({projectId, email: `gone${i}@example.com`, reason: 'SOFT_BOUNCE'})),
    });
    await fiveOverAWeek();
    const record = vi.spyOn(FailureAlertService, 'record').mockResolvedValue(true);

    expect(await run()).toBeNull();
    expect(await run()).toBeNull();

    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]?.[1]).toMatchObject({sourceKey: 'brake:soft_bounce_hold'});
    expect((await prisma.contact.findUnique({where: {id: contact.id}}))?.subscribed).toBe(true);
    record.mockRestore();
  });

  it('counts only the last 7 days and other reasons not at all in the brake', async () => {
    await prisma.plunkLiteSuppression.createMany({
      data: [
        ...Array.from({length: 19}, (_, i) => ({projectId, email: `gone${i}@example.com`, reason: 'SOFT_BOUNCE'})),
        {projectId, email: 'old@example.com', reason: 'SOFT_BOUNCE', createdAt: new Date(Date.now() - 8 * DAY)},
        {projectId, email: 'hard@example.com', reason: 'BOUNCE'},
      ],
    });
    await fiveOverAWeek();

    expect((await run())?.reason).toBe('SOFT_BOUNCE');
  });

  it('keeps holding back when the suppressions of the week are lifted', async () => {
    const gone = Array.from({length: 20}, (_, i) => `gone${i}@example.com`);
    await prisma.contact.createMany({data: gone.map(email => ({projectId, email}))});
    await SuppressionService.record(prisma, projectId, gone, 'SOFT_BOUNCE', null);
    for (const email of gone) {
      await SuppressionService.lift(projectId, email, {ses: 'any'});
    }
    await fiveOverAWeek();
    const record = vi.spyOn(FailureAlertService, 'record').mockResolvedValue(true);

    expect(await run()).toBeNull();

    record.mockRestore();
  });

  it('does not count lifts of other reasons, or of over 7 days ago, in the brake', async () => {
    const gone = Array.from({length: 20}, (_, i) => `gone${i}@example.com`);
    await prisma.contact.createMany({data: gone.map(email => ({projectId, email}))});
    await SuppressionService.record(prisma, projectId, gone, 'BOUNCE', null);
    for (const email of gone) {
      await SuppressionService.lift(projectId, email, {ses: 'any'});
    }
    await SuppressionService.record(prisma, projectId, gone, 'SOFT_BOUNCE', null);
    for (const email of gone) {
      await SuppressionService.lift(projectId, email, {ses: 'any'});
    }
    await prisma.event.updateMany({
      where: {projectId, name: 'contact.suppression_lifted', data: {path: ['reason'], equals: 'SOFT_BOUNCE'}},
      data: {createdAt: new Date(Date.now() - 8 * DAY)},
    });
    await fiveOverAWeek();

    expect((await run())?.reason).toBe('SOFT_BOUNCE');
  });

  describe('SuppressionService with the new reason', () => {
    const reasonAfter = async (first: string, second: string) => {
      const address = `${first}-${second}@example.com`.toLowerCase();
      const {id} = await factories.createEmail({projectId, contactId: contact.id});
      await SuppressionService.record(prisma, projectId, [address], first as never, id);
      await SuppressionService.record(prisma, projectId, [address], second as never, id);
      return (await SuppressionService.find(projectId, address))?.reason;
    };

    it('lets the stronger reason replace the weaker, never the other way', async () => {
      expect(await reasonAfter('SOFT_BOUNCE', 'BOUNCE')).toBe('BOUNCE');
      expect(await reasonAfter('SOFT_BOUNCE', 'COMPLAINT')).toBe('COMPLAINT');
      expect(await reasonAfter('BOUNCE', 'COMPLAINT')).toBe('COMPLAINT');
      expect(await reasonAfter('BOUNCE', 'SOFT_BOUNCE')).toBe('BOUNCE');
      expect(await reasonAfter('COMPLAINT', 'SOFT_BOUNCE')).toBe('COMPLAINT');
      expect(await reasonAfter('COMPLAINT', 'BOUNCE')).toBe('COMPLAINT');
    });

    it('keeps the email of the row when a stronger reason comes without one', async () => {
      const email = await factories.createEmail({projectId, contactId: contact.id});
      await SuppressionService.record(prisma, projectId, [contact.email], 'BOUNCE', email.id);
      await SuppressionService.record(prisma, projectId, [contact.email], 'COMPLAINT', null);

      const row = await prisma.plunkLiteSuppression.findFirst({where: {projectId, email: contact.email}});
      expect(row).toMatchObject({reason: 'COMPLAINT', emailId: email.id});
    });

    it('leaves a soft bounce suppression as it is on an import, which then lifts without SES', async () => {
      const remove = vi.spyOn(SESService, 'removeFromAccountSuppressionList');
      remove.mockClear();
      const email = await factories.createEmail({projectId, contactId: contact.id});
      await SuppressionService.record(prisma, projectId, [contact.email], 'SOFT_BOUNCE', email.id);
      await SuppressionService.record(prisma, projectId, [contact.email], 'BOUNCE', null);
      await SuppressionService.record(prisma, projectId, [contact.email], 'COMPLAINT', null);

      expect((await SuppressionService.find(projectId, contact.email))?.reason).toBe('SOFT_BOUNCE');
      await SuppressionService.lift(projectId, contact.email, {ses: 'any'});
      expect(remove).not.toHaveBeenCalled();
      remove.mockRestore();
    });

    it('lifts a soft bounce suppression without touching SES, and marks it', async () => {
      const remove = vi.spyOn(SESService, 'removeFromAccountSuppressionList');
      remove.mockClear();
      const email = await factories.createEmail({projectId, contactId: contact.id});
      await SuppressionService.record(prisma, projectId, [contact.email], 'SOFT_BOUNCE', email.id);

      expect(await SuppressionService.lift(projectId, contact.email, {ses: 'any'})).toEqual({lifted: true});

      expect(remove).not.toHaveBeenCalled();
      expect(await prisma.event.count({where: {contactId: contact.id, name: 'contact.suppression_lifted'}})).toBe(1);
      remove.mockRestore();
    });

    it('lifts all the same if the mark cannot be written', async () => {
      await SuppressionService.record(prisma, projectId, [contact.email], 'SOFT_BOUNCE', null);
      const create = vi.spyOn(prisma.event, 'create').mockRejectedValueOnce(new Error('db'));

      expect((await SuppressionService.lift(projectId, contact.email, {ses: 'any'})).lifted).toBe(true);

      create.mockRestore();
    });
  });
});
