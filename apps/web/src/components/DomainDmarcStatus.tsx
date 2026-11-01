import {AlertTriangle, CheckCircle2, Info} from 'lucide-react';
import type {ReactNode} from 'react';

import {useDomainDmarc} from '../lib/hooks/useDomains';

function Line({tone, children}: {tone: 'ok' | 'warning' | 'neutral'; children: ReactNode}) {
  const Icon = tone === 'ok' ? CheckCircle2 : tone === 'warning' ? AlertTriangle : Info;
  const color = tone === 'ok' ? 'text-green-600' : tone === 'warning' ? 'text-amber-600' : 'text-neutral-400';

  return (
    <div className="mt-1 flex items-start gap-2 text-xs text-neutral-600">
      <Icon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${color}`} />
      <p>{children}</p>
    </div>
  );
}

/**
 * Plunk Lite: what DNS says about a domain's DMARC, shown without asking. Only advice: it blocks
 * neither verifying the domain nor sending from it, and not being able to check is not a failure.
 */
export function DomainDmarcStatus({domainId}: {domainId: string}) {
  const {dmarc, error} = useDomainDmarc(domainId);

  if (error || dmarc?.status === 'unknown') {
    return <Line tone="neutral">DMARC could not be checked right now.</Line>;
  }
  if (!dmarc) {
    return null;
  }

  if (dmarc.status === 'missing') {
    return (
      <Line tone="warning">
        No DMARC record. Gmail and Yahoo require one from bulk senders. Add a TXT record named{' '}
        <code className="font-mono">_dmarc.{dmarc.rootDomain}</code> with the value{' '}
        <code className="font-mono">v=DMARC1; p=none;</code>
      </Line>
    );
  }

  if (dmarc.status === 'invalid') {
    return (
      <Line tone="warning">
        The DMARC record at <code className="font-mono">_dmarc.{dmarc.foundAt}</code> can’t be applied: there is more
        than one, or it has no valid policy. Mailbox providers will act as if there were none.
      </Line>
    );
  }

  // Where it was read, unless on a subdomain of its own, which then needs no naming
  const source = dmarc.foundAt === dmarc.rootDomain ? dmarc.foundAt : null;
  return (
    <Line tone={dmarc.policy === 'none' ? 'neutral' : 'ok'}>
      DMARC: <span className="font-medium">{dmarc.policy}</span>
      {source && <>, from {source}</>}
      {dmarc.policy === 'none' &&
        '. Enough to start: providers take no action on mail that fails. Move to quarantine or reject once every sender passes.'}
    </Line>
  );
}
