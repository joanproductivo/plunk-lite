import {randomUUID} from 'node:crypto';

import {describe, expect, it} from 'vitest';

import {CampaignSchemas} from '../schemas/index.js';
import {CAMPAIGN_EXCLUDED_SEGMENTS_MAX, sameSegmentIds} from '../segments.js';

/** Plunk Lite: the segments a campaign leaves out, as the campaign endpoints take them */
describe('excludedSegmentIds in the campaign schemas', () => {
  const base = {
    name: 'Newsletter',
    subject: 'Hi',
    body: '<p>Hi</p>',
    from: 'news@example.com',
    audienceType: 'ALL' as const,
  };
  const ids = (count: number) => Array.from({length: count}, () => randomUUID());

  it('takes up to the maximum of segment ids', () => {
    const excludedSegmentIds = ids(CAMPAIGN_EXCLUDED_SEGMENTS_MAX);
    expect(CampaignSchemas.create.parse({...base, excludedSegmentIds}).excludedSegmentIds).toEqual(excludedSegmentIds);
  });

  it('refuses more than the maximum, and ids that are not segment ids', () => {
    expect(() =>
      CampaignSchemas.create.parse({...base, excludedSegmentIds: ids(CAMPAIGN_EXCLUDED_SEGMENTS_MAX + 1)}),
    ).toThrow();
    expect(() => CampaignSchemas.create.parse({...base, excludedSegmentIds: ['not-an-id']})).toThrow();
  });

  it('leaves the field out of an update that does not send it', () => {
    expect(CampaignSchemas.update.shape.excludedSegmentIds.parse(undefined)).toBeUndefined();
    expect(() =>
      CampaignSchemas.update.shape.excludedSegmentIds.parse(ids(CAMPAIGN_EXCLUDED_SEGMENTS_MAX + 1)),
    ).toThrow();
  });
});

describe('sameSegmentIds', () => {
  it('compares the segments named, whatever their order or repeats', () => {
    expect(sameSegmentIds(['a', 'b'], ['b', 'a'])).toBe(true);
    expect(sameSegmentIds(['a', 'a'], ['a'])).toBe(true);
    expect(sameSegmentIds(['a', 'a'], ['a', 'b'])).toBe(false);
    expect(sameSegmentIds([], ['a'])).toBe(false);
  });
});
