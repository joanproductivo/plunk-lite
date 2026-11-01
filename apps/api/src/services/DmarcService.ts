import {promises as dns} from 'dns';

import type {DmarcPolicy, DomainDmarc} from '@plunk/types';
import {getDomain} from 'tldts';

const DNS_TRY_TIMEOUT_MS = 1500;
const DNS_DEADLINE_MS = 4000;

const POLICIES: readonly string[] = ['none', 'quarantine', 'reject'] satisfies DmarcPolicy[];

/** The `v=DMARC1` records among a name's TXT records; none when the name has none */
async function dmarcRecords(resolver: dns.Resolver, domain: string): Promise<string[]> {
  try {
    const records = await resolver.resolveTxt(`_dmarc.${domain}`);
    return records.map(chunks => chunks.join('')).filter(record => /^v\s*=\s*DMARC1\s*(;|$)/i.test(record.trim()));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOTFOUND' || code === 'ENODATA') {
      return [];
    }
    throw error;
  }
}

/** The value of a record's tag, lowercased: `p` in `v=DMARC1; p=reject;` */
function dmarcTag(record: string, tag: string): string | undefined {
  for (const part of record.split(';')) {
    const [name, value] = part.split('=');
    if (name?.trim().toLowerCase() === tag) {
      return value?.trim().toLowerCase();
    }
  }
  return undefined;
}

/**
 * Plunk Lite: reads a domain's DMARC record from DNS, as a mailbox provider would: the domain's
 * own, or else its root's, whose `sp` (or else `p`) then applies. It never throws: DNS failing or
 * too slow is `unknown`, and nothing here may stop a domain from being verified or used.
 */
export class DmarcService {
  public static async lookup(domain: string): Promise<DomainDmarc> {
    const rootDomain = getDomain(domain) ?? domain;
    const unknown: DomainDmarc = {status: 'unknown', policy: null, foundAt: null, rootDomain};

    // A resolver per lookup: cancelling it at the deadline must not cancel other requests' lookups
    const resolver = new dns.Resolver({timeout: DNS_TRY_TIMEOUT_MS, tries: 2});
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<DomainDmarc>(resolve => {
      timer = setTimeout(() => resolve(unknown), DNS_DEADLINE_MS);
    });
    try {
      return await Promise.race([this.discover(resolver, domain, rootDomain), deadline]);
    } catch {
      return unknown;
    } finally {
      clearTimeout(timer);
      resolver.cancel();
    }
  }

  private static async discover(resolver: dns.Resolver, domain: string, rootDomain: string): Promise<DomainDmarc> {
    const own = await dmarcRecords(resolver, domain);
    const inherited = own.length === 0 && rootDomain !== domain;
    const records = inherited ? await dmarcRecords(resolver, rootDomain) : own;
    const foundAt = inherited ? rootDomain : domain;

    if (records.length === 0) {
      return {status: 'missing', policy: null, foundAt: null, rootDomain};
    }

    const invalid: DomainDmarc = {status: 'invalid', policy: null, foundAt, rootDomain};
    // RFC 7489: more than one record is as good as none
    const [record] = records;
    if (records.length > 1 || !record) {
      return invalid;
    }

    const p = dmarcTag(record, 'p');
    if (!p || !POLICIES.includes(p)) {
      return invalid;
    }
    const sp = inherited ? dmarcTag(record, 'sp') : undefined;
    const policy = (sp && POLICIES.includes(sp) ? sp : p) as DmarcPolicy;

    return {status: 'found', policy, foundAt, rootDomain};
  }
}
