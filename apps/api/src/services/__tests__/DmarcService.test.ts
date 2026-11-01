import {beforeEach, describe, expect, it, vi} from 'vitest';

const {resolveTxt, cancel} = vi.hoisted(() => ({resolveTxt: vi.fn(), cancel: vi.fn()}));

vi.mock('dns', () => ({
  promises: {
    Resolver: class {
      public resolveTxt = resolveTxt;
      public cancel = cancel;
    },
  },
}));

import {DmarcService} from '../DmarcService';

function dnsError(code: string) {
  return Object.assign(new Error(code), {code});
}

/** TXT records by name; a name left out does not exist */
function zone(records: Record<string, string[][]>) {
  resolveTxt.mockImplementation(async (name: string) => {
    const found = records[name];
    if (!found) {
      throw dnsError('ENOTFOUND');
    }
    return found;
  });
}

describe('DmarcService.lookup', () => {
  beforeEach(() => {
    resolveTxt.mockReset();
    cancel.mockReset();
  });

  it('reads the domain’s own record, whose p applies whatever its sp says', async () => {
    zone({'_dmarc.example.com': [['v=DMARC1; p=quarantine; sp=none;']]});

    expect(await DmarcService.lookup('example.com')).toEqual({
      status: 'found',
      policy: 'quarantine',
      foundAt: 'example.com',
      rootDomain: 'example.com',
    });
  });

  it('joins a record split into chunks and ignores other TXT records', async () => {
    zone({'_dmarc.example.com': [['some-verification=abc'], ['v=DMARC1; ', 'p=reject']]});

    expect((await DmarcService.lookup('example.com')).policy).toBe('reject');
  });

  it('inherits p from the root when the subdomain has none', async () => {
    zone({'_dmarc.example.com': [['v=DMARC1; p=reject;']]});

    expect(await DmarcService.lookup('soy.example.com')).toEqual({
      status: 'found',
      policy: 'reject',
      foundAt: 'example.com',
      rootDomain: 'example.com',
    });
  });

  it('applies sp when inheriting', async () => {
    zone({'_dmarc.example.com': [['v=DMARC1; p=reject; sp=none;']]});

    expect((await DmarcService.lookup('soy.example.com')).policy).toBe('none');
  });

  it('prefers the subdomain’s own record, and p over sp there', async () => {
    zone({
      '_dmarc.soy.example.com': [['v=DMARC1; p=none; sp=reject;']],
      '_dmarc.example.com': [['v=DMARC1; p=reject;']],
    });

    const dmarc = await DmarcService.lookup('soy.example.com');
    expect(dmarc.policy).toBe('none');
    expect(dmarc.foundAt).toBe('soy.example.com');
  });

  it('knows the root of a multi-part suffix', async () => {
    zone({'_dmarc.example.co.uk': [['v=DMARC1; p=none;']]});

    const dmarc = await DmarcService.lookup('mail.example.co.uk');
    expect(dmarc.foundAt).toBe('example.co.uk');
    expect(resolveTxt).not.toHaveBeenCalledWith('_dmarc.co.uk');
  });

  it('says missing when neither has one, and asks a root only once', async () => {
    zone({});

    expect(await DmarcService.lookup('soy.example.com')).toEqual({
      status: 'missing',
      policy: null,
      foundAt: null,
      rootDomain: 'example.com',
    });

    resolveTxt.mockClear();
    await DmarcService.lookup('example.com');
    expect(resolveTxt).toHaveBeenCalledTimes(1);
  });

  it('treats a name with only other TXT records, or ENODATA, as missing', async () => {
    zone({'_dmarc.example.com': [['not-dmarc']]});
    expect((await DmarcService.lookup('example.com')).status).toBe('missing');

    resolveTxt.mockRejectedValue(dnsError('ENODATA'));
    expect((await DmarcService.lookup('example.com')).status).toBe('missing');
  });

  it('says invalid for two records, or no valid policy', async () => {
    zone({'_dmarc.example.com': [['v=DMARC1; p=none;'], ['v=DMARC1; p=reject;']]});
    expect(await DmarcService.lookup('example.com')).toEqual({
      status: 'invalid',
      policy: null,
      foundAt: 'example.com',
      rootDomain: 'example.com',
    });

    zone({'_dmarc.example.com': [['v=DMARC1; p=strict;']]});
    expect((await DmarcService.lookup('example.com')).status).toBe('invalid');

    zone({'_dmarc.example.com': [['v=DMARC1; rua=mailto:a@example.com']]});
    expect((await DmarcService.lookup('example.com')).status).toBe('invalid');
  });

  it('falls back to p when sp is not a policy', async () => {
    zone({'_dmarc.example.com': [['v=DMARC1; p=reject; sp=whatever;']]});

    expect((await DmarcService.lookup('soy.example.com')).policy).toBe('reject');
  });

  it('says unknown when DNS fails, not missing', async () => {
    resolveTxt.mockRejectedValue(dnsError('ESERVFAIL'));

    expect(await DmarcService.lookup('example.com')).toEqual({
      status: 'unknown',
      policy: null,
      foundAt: null,
      rootDomain: 'example.com',
    });
  });

  it('says unknown at the deadline and cancels the resolver', async () => {
    vi.useFakeTimers();
    try {
      resolveTxt.mockReturnValue(new Promise(() => {}));

      const lookup = DmarcService.lookup('example.com');
      await vi.advanceTimersByTimeAsync(4000);

      expect((await lookup).status).toBe('unknown');
      expect(cancel).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
