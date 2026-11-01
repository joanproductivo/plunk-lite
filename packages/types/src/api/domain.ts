/**
 * Plunk Lite: what DNS says about a domain's DMARC.
 * - `found`: a readable record, on the domain or inherited from its root
 * - `missing`: no record on either
 * - `invalid`: a record no mailbox provider can apply: two of them, or no valid policy
 * - `unknown`: DNS did not answer, which says nothing about the record
 */
export type DmarcStatus = 'found' | 'missing' | 'invalid' | 'unknown';

export type DmarcPolicy = 'none' | 'quarantine' | 'reject';

export interface DomainDmarc {
  status: DmarcStatus;
  /** The policy that applies to mail from this domain: for an inherited record, its `sp` or else its `p` */
  policy: DmarcPolicy | null;
  /** The domain whose `_dmarc` record was read, when there is one */
  foundAt: string | null;
  /** The domain's root, where a record belongs when there is none */
  rootDomain: string;
}
