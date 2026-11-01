// @vitest-environment happy-dom
import type {DomainDmarc} from '@plunk/types';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {SWRConfig} from 'swr';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {DomainDmarcStatus} from '../DomainDmarcStatus';

(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

async function render(fetcher: () => Promise<DomainDmarc>) {
  await act(async () => {
    root.render(
      <SWRConfig value={{fetcher, provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false}}>
        <DomainDmarcStatus domainId="d1" />
      </SWRConfig>,
    );
  });
  return container.textContent;
}

const dmarc = (fields: Partial<DomainDmarc>): DomainDmarc => ({
  status: 'found',
  policy: 'reject',
  foundAt: 'example.com',
  rootDomain: 'example.com',
  ...fields,
});

describe('DomainDmarcStatus', () => {
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('shows the policy and where it comes from', async () => {
    expect(await render(async () => dmarc({}))).toContain('DMARC: reject, from example.com');
  });

  it('does not name a source for a subdomain’s own record', async () => {
    const text = await render(async () => dmarc({foundAt: 'mail.example.com'}));
    expect(text).toContain('DMARC: reject');
    expect(text).not.toContain('from');
  });

  it('warns gently about p=none', async () => {
    expect(await render(async () => dmarc({policy: 'none'}))).toContain('Enough to start');
  });

  it('gives the record to add when there is none, at the root', async () => {
    const text = await render(async () => dmarc({status: 'missing', policy: null, foundAt: null}));
    expect(text).toContain('_dmarc.example.com');
    expect(text).toContain('v=DMARC1; p=none;');
  });

  it('explains an invalid record', async () => {
    expect(await render(async () => dmarc({status: 'invalid', policy: null}))).toContain('can’t be applied');
  });

  it('never reports a DNS failure, or a failed request, as a failure of the domain', async () => {
    const message = 'DMARC could not be checked right now.';
    expect(await render(async () => dmarc({status: 'unknown', policy: null, foundAt: null}))).toBe(message);
    expect(await render(() => Promise.reject(new Error('nope')))).toBe(message);
  });
});
