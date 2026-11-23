// @vitest-environment happy-dom
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {network} from '../../lib/network';
import OptOutPage from '../../pages/opt-out/[id]';

(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

const route = vi.hoisted(() => ({isReady: true, query: {id: 'c1', t: 't1'} as Record<string, unknown>}));

vi.mock('next/router', () => ({useRouter: () => route}));
vi.mock('../../lib/network', () => ({network: {fetch: vi.fn()}}));
vi.mock('next/image', () => ({default: () => null}));

const CONTACT = {
  id: 'c1',
  email: 'ana@example.com',
  subscribed: false,
  snoozedUntil: null,
  projectName: 'Vida',
  language: 'es',
};

let root: Root;
let container: HTMLDivElement;

async function render() {
  await act(async () => root.render(<OptOutPage />));
  await act(async () => {});
}

const button = () => [...container.querySelectorAll('button')].find(b => b.textContent?.includes('Dejar de recibir'));

beforeEach(() => {
  route.isReady = true;
  route.query = {id: 'c1', t: 't1'};
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

/** Plunk Lite: the page of an opt-out link, which acts only on its button */
describe('the opt-out page', () => {
  it('only reads the contact on loading, and opts out when the button is pressed', async () => {
    vi.mocked(network.fetch).mockImplementation(async (_method, path) =>
      path === '/contacts/public/c1' ? CONTACT : {status: 'opted-out'},
    );

    await render();

    expect(network.fetch).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Dejar de recibir estos avisos de Vida');
    expect(container.textContent).toContain('ana@example.com');

    await act(async () => button()!.click());

    expect(network.fetch).toHaveBeenLastCalledWith('POST', '/opt-out/c1?t=t1');
    expect(container.textContent).toContain('Ya no recibirás más avisos como este de Vida.');
  });

  it('says the link no longer works when the API answers unavailable', async () => {
    vi.mocked(network.fetch).mockImplementation(async (_method, path) =>
      path === '/contacts/public/c1' ? CONTACT : {status: 'unavailable'},
    );

    await render();
    await act(async () => button()!.click());

    expect(container.textContent).toContain('Este enlace ya no funciona');
  });

  it('says so at once for a link without its template, and waits for the query first', async () => {
    vi.mocked(network.fetch).mockResolvedValue(CONTACT);
    route.isReady = false;
    route.query = {};

    await render();
    expect(container.textContent).not.toContain('Este enlace ya no funciona');

    route.isReady = true;
    route.query = {id: 'c1'};
    await render();
    expect(container.textContent).toContain('Este enlace ya no funciona');
    expect(button()).toBeUndefined();
  });
});
