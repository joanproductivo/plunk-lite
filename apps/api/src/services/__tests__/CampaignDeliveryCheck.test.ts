import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {redis} from '../../database/redis';
import {CampaignDeliveryCheck} from '../CampaignDeliveryCheck';
import {FailureAlertService} from '../FailureAlertService';
import {sendRawEmail} from '../SESService';

vi.mock('../SESService', () => ({
  sendRawEmail: vi.fn(async () => ({messageId: 'mock-message-id'})),
}));

const HOUR = 3600_000;

/** Plunk Lite: a campaign that delivered too little after a day shows on the banner, and only there */
describe('CampaignDeliveryCheck', () => {
  const prisma = getPrismaClient();
  let projectId: string;

  beforeEach(async () => {
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
    // Addresses set: a warning that went by email would reach them
    await factories.createDomain({projectId, domain: 'example.com'});
    await prisma.plunkLiteAlertSettings.create({
      data: {projectId, recipients: ['ops@example.org'], fromEmail: 'alerts@example.com'},
    });
    vi.mocked(sendRawEmail).mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function campaignOf(
    recipients: {delivered?: number; missing?: Record<string, number>; simulated?: number},
    {hoursAgo = 25, status = 'SENT' as const}: {hoursAgo?: number; status?: 'SENT' | 'SENDING'} = {},
  ) {
    const campaign = await factories.createCampaign({projectId, name: 'Big send', status});
    await prisma.campaign.update({where: {id: campaign.id}, data: {sentAt: new Date(Date.now() - hoursAgo * HOUR)}});

    const emailTo = async (address: string, data: {deliveredAt?: Date; simulated?: boolean}) => {
      const contact = await factories.createContact({projectId, email: address});
      await prisma.email.create({
        data: {
          projectId,
          contactId: contact.id,
          campaignId: campaign.id,
          subject: 'Hi',
          body: '<p>Hi</p>',
          from: 'hello@example.com',
          sourceType: 'CAMPAIGN',
          status: data.deliveredAt ? 'DELIVERED' : 'SENT',
          sentAt: new Date(),
          ...data,
        },
      });
    };

    for (let i = 0; i < (recipients.delivered ?? 0); i++) {
      await emailTo(`${campaign.id}-d${i}@delivered.test`, {deliveredAt: new Date()});
    }
    for (const [domain, count] of Object.entries(recipients.missing ?? {})) {
      for (let i = 0; i < count; i++) {
        await emailTo(`${campaign.id}-m${i}@${domain}`, {});
      }
    }
    for (let i = 0; i < (recipients.simulated ?? 0); i++) {
      await emailTo(`${campaign.id}-s${i}@simulator.amazonses.com`, {simulated: true});
    }
    return campaign;
  }

  const warnings = () => FailureAlertService.listOpen(projectId);

  it('warns about a low delivery, with its providers adding up to what it says', async () => {
    const campaign = await campaignOf({
      delivered: 10,
      missing: {'gmail.com': 3, 'hotmail.com': 2, 'yahoo.es': 1, 'aaa.test': 1, 'bbb.test': 1},
    });

    await CampaignDeliveryCheck.run();

    const [warning] = await warnings();
    expect(warning).toMatchObject({
      sourceKey: `delivery:campaign:${campaign.id}`,
      label: 'Big send',
      count: 1,
      reviewPath: `/campaigns/${campaign.id}`,
      lastError: 'Only 55.5% delivered after 24 h: 8 of 18 not. gmail.com 3, hotmail.com 2, aaa.test 1, other 2.',
    });
  });

  it('never sends the warning by email', async () => {
    await campaignOf({delivered: 1, missing: {'gmail.com': 5}});

    await CampaignDeliveryCheck.run();
    await new Promise(resolve => setImmediate(resolve));

    expect(await warnings()).toHaveLength(1);
    expect(sendRawEmail).not.toHaveBeenCalled();
  });

  it('does not round a rate up to the threshold', async () => {
    const shown = (delivered: number, sent: number) =>
      CampaignDeliveryCheck.describe('no-such-campaign', delivered, sent);

    expect(await shown(9496, 10000)).toContain('Only 94.9% delivered');
    // In floating point, 1884 / 2000 * 100 is just under 94.2
    expect(await shown(1884, 2000)).toContain('Only 94.2% delivered');
  });

  it('accepts exactly the threshold', async () => {
    await campaignOf({delivered: 95, missing: {'gmail.com': 5}});

    await CampaignDeliveryCheck.run();

    expect(await warnings()).toHaveLength(0);
  });

  it('does not trip on a few addresses of a small campaign', async () => {
    await campaignOf({delivered: 1, missing: {'gmail.com': 4}});

    await CampaignDeliveryCheck.run();

    expect(await warnings()).toHaveLength(0);
  });

  it.each([
    ['before the 24 hours', 23],
    ['after the window', 49],
  ])('leaves a campaign alone %s', async (_when, hoursAgo) => {
    await campaignOf({delivered: 1, missing: {'gmail.com': 5}}, {hoursAgo});

    await CampaignDeliveryCheck.run();

    expect(await warnings()).toHaveLength(0);
  });

  it('leaves alone a campaign still sending', async () => {
    await campaignOf({delivered: 1, missing: {'gmail.com': 5}}, {status: 'SENDING'});

    await CampaignDeliveryCheck.run();

    expect(await warnings()).toHaveLength(0);
  });

  it('counts as arrived what was opened, clicked or complained about, its delivery event lost', async () => {
    const campaign = await campaignOf({delivered: 5, missing: {'gmail.com': 6}});
    const emails = await prisma.email.findMany({where: {campaignId: campaign.id, deliveredAt: null}});
    await prisma.email.update({where: {id: emails[0]!.id}, data: {status: 'OPENED', openedAt: new Date()}});
    await prisma.email.update({where: {id: emails[1]!.id}, data: {status: 'CLICKED', clickedAt: new Date()}});
    await prisma.email.update({where: {id: emails[2]!.id}, data: {status: 'COMPLAINED', complainedAt: new Date()}});

    await CampaignDeliveryCheck.run();

    // 3 left missing, under the minimum
    expect(await warnings()).toHaveLength(0);
  });

  it('counts a permanent bounce as not delivered, and in the providers', async () => {
    const campaign = await campaignOf({delivered: 5, missing: {'gmail.com': 5}});
    await prisma.email.updateMany({
      where: {campaignId: campaign.id, deliveredAt: null},
      data: {status: 'BOUNCED', bouncedAt: new Date()},
    });

    await CampaignDeliveryCheck.run();

    const [warning] = await warnings();
    expect(warning?.lastError).toBe('Only 50.0% delivered after 24 h: 5 of 10 not. gmail.com 5.');
  });

  it('leaves out the SES mailbox simulator', async () => {
    await campaignOf({delivered: 10, simulated: 6});

    await CampaignDeliveryCheck.run();

    expect(await warnings()).toHaveLength(0);
  });

  it('judges a campaign once, so a warning marked as reviewed stays closed', async () => {
    await campaignOf({delivered: 1, missing: {'gmail.com': 5}});

    await CampaignDeliveryCheck.run();
    const [warning] = await warnings();
    await FailureAlertService.review(projectId, [{id: warning!.id, lastAt: warning!.lastAt}]);
    await CampaignDeliveryCheck.run();

    expect(await warnings()).toHaveLength(0);
  });

  it('judges again a campaign whose warning could not be recorded', async () => {
    const campaign = await campaignOf({delivered: 1, missing: {'gmail.com': 5}});
    vi.spyOn(FailureAlertService, 'record').mockResolvedValueOnce(false);

    await CampaignDeliveryCheck.run();

    expect(await redis.get(`plunk-lite:campaign-delivery-checked:${campaign.id}`)).toBeNull();
    await CampaignDeliveryCheck.run();
    expect(await warnings()).toHaveLength(1);
  });

  it('goes on to the other campaigns when one cannot be judged', async () => {
    const broken = await campaignOf({delivered: 1, missing: {'gmail.com': 5}});
    const fine = await campaignOf({delivered: 1, missing: {'gmail.com': 5}});
    const judge = CampaignDeliveryCheck.judge.bind(CampaignDeliveryCheck);
    vi.spyOn(CampaignDeliveryCheck, 'judge').mockImplementation(async campaign => {
      if (campaign.id === broken.id) {
        throw new Error('Lost');
      }
      return judge(campaign);
    });

    await CampaignDeliveryCheck.run();

    expect((await warnings()).map(warning => warning.sourceKey)).toEqual([`delivery:campaign:${fine.id}`]);
  });
});
