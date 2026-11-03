// @vitest-environment happy-dom
import {BRAND_DEFAULTS, BUTTON_DEFAULTS, type ProjectBrand, SOCIAL_DEFAULTS} from '@plunk/shared';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {toast} from 'sonner';
import {SWRConfig} from 'swr';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {network} from '../../lib/network';
import {BrandSettings} from '../BrandSettings';
import {withSocialIcons} from '../EmailEditor/socialIcons';

(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../lib/network', () => ({network: {fetch: vi.fn(), upload: vi.fn()}}));
// Drawing needs a canvas, which happy-dom lacks (see socialIcons.test)
vi.mock('../EmailEditor/socialIcons', async importOriginal => ({
  ...(await importOriginal<typeof import('../EmailEditor/socialIcons')>()),
  withSocialIcons: vi.fn(),
}));
vi.mock('sonner', () => ({toast: {success: vi.fn(), error: vi.fn()}}));

const STORED: ProjectBrand = {
  ...BRAND_DEFAULTS,
  textColor: '#222222',
  button: BUTTON_DEFAULTS,
  social: SOCIAL_DEFAULTS,
};
const ICON = 'https://files.example.com/p/1-0123456789abcdef-plunk-social-youtube-circle-111827.png';
const SOCIAL = {
  ...SOCIAL_DEFAULTS,
  links: [{network: 'youtube' as const, url: 'https://youtube.com/@acme'}],
  icons: {youtube: ICON},
};

let root: Root;
let container: HTMLDivElement;
// The project's footers come from their own URL; this project has none of its own
const stored = async (url: string): Promise<unknown> => (url.endsWith('/footers') ? {} : STORED);
const fetcher = vi.fn(stored);

async function render(canEdit: boolean) {
  await act(async () => {
    root.render(
      <SWRConfig value={{fetcher, provider: () => new Map(), dedupingInterval: 0}}>
        <BrandSettings projectId="project-1" projectName="Acme" language="es" canEdit={canEdit} />
      </SWRConfig>,
    );
  });
}

const buttonNamed = (text: string) =>
  [...document.querySelectorAll('button')].find(button => button.textContent?.trim() === text);

beforeEach(() => {
  localStorage.setItem('activeProjectId', 'project-1');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
  fetcher.mockImplementation(stored);
});

describe('BrandSettings', () => {
  it("shows the project's brand in the fields and the preview", async () => {
    await render(true);

    expect(fetcher).toHaveBeenCalledWith('/projects/project-1/brand');
    expect(fetcher).toHaveBeenCalledWith('/projects/project-1/footers');
    expect(document.querySelector<HTMLInputElement>('#brand-text')!.value).toBe('#222222');
    expect(document.querySelector('iframe')!.getAttribute('srcdoc')).toContain('color: #222222;');
  });

  it('saves the brand as edited', async () => {
    vi.mocked(network.fetch).mockResolvedValueOnce({...STORED, backgroundColor: '#f3f4f6'});
    await render(true);

    await act(async () => {
      document.querySelector<HTMLButtonElement>('#brand-has-background')!.click();
    });
    await act(async () => {
      buttonNamed('Save')!.click();
    });

    expect(network.fetch).toHaveBeenCalledWith('PUT', '/projects/project-1/brand', {
      ...STORED,
      backgroundColor: '#f3f4f6',
    });
    expect(toast.success).toHaveBeenCalledWith('Brand saved');
  });

  it("shows the unsubscribe footer as sent, in the project's language, framed or not", async () => {
    await render(true);
    const preview = () => document.querySelector('iframe')!.getAttribute('srcdoc')!;

    expect(preview()).toContain('aceptaste recibir correos electrónicos de Acme');
    expect(preview()).toContain('actualiza tus preferencias</a>.');

    await act(async () => {
      document.querySelector<HTMLButtonElement>('#brand-has-background')!.click();
    });

    expect(preview()).toContain('actualiza tus preferencias</a>.');
    expect(preview()).not.toContain('plunk:footer');
  });

  describe('social links (Plunk Lite)', () => {
    const typeInto = async (input: HTMLInputElement, value: string) => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
        input.dispatchEvent(new Event('input', {bubbles: true}));
      });
    };

    it('shows them, and their icons in the preview once uploaded', async () => {
      fetcher.mockImplementation(async url => (url.endsWith('/footers') ? {} : {...STORED, social: SOCIAL}));
      await render(true);

      expect(document.querySelector<HTMLInputElement>('input[aria-label="YouTube link"]')!.value).toBe(
        'https://youtube.com/@acme',
      );
      expect(document.querySelector('iframe')!.getAttribute('srcdoc')).toContain(
        `<a href="https://youtube.com/@acme"><img src="${ICON}" alt="YouTube"`,
      );
    });

    it('saves a new link with the icon it has, uploading nothing', async () => {
      fetcher.mockImplementation(async url => (url.endsWith('/footers') ? {} : {...STORED, social: SOCIAL}));
      vi.mocked(network.fetch).mockImplementationOnce(async (_method, _url, body) => body);
      await render(true);

      await typeInto(
        document.querySelector<HTMLInputElement>('input[aria-label="YouTube link"]')!,
        'https://youtube.com/@new',
      );
      await act(async () => {
        buttonNamed('Save')!.click();
      });

      expect(withSocialIcons).not.toHaveBeenCalled();
      expect(network.fetch).toHaveBeenCalledWith(
        'PUT',
        '/projects/project-1/brand',
        expect.objectContaining({social: {...SOCIAL, links: [{network: 'youtube', url: 'https://youtube.com/@new'}]}}),
      );
      expect(toast.success).toHaveBeenCalledWith('Brand saved');
    });

    it('uploads the icons a new colour needs before saving, and saves them', async () => {
      const recoloured = 'https://files.example.com/p/2-0123456789abcdef-plunk-social-youtube-circle-e11d48.png';
      fetcher.mockImplementation(async url => (url.endsWith('/footers') ? {} : {...STORED, social: SOCIAL}));
      vi.mocked(withSocialIcons).mockImplementationOnce(async social => ({...social, icons: {youtube: recoloured}}));
      vi.mocked(network.fetch).mockImplementationOnce(async (_method, _url, body) => body);
      await render(true);

      await typeInto(document.querySelector<HTMLInputElement>('#brand-social-color')!, '#e11d48');
      await act(async () => {
        buttonNamed('Save')!.click();
      });

      expect(withSocialIcons).toHaveBeenCalledWith({...SOCIAL, color: '#e11d48'}, expect.any(Function));
      expect(network.fetch).toHaveBeenCalledWith(
        'PUT',
        '/projects/project-1/brand',
        expect.objectContaining({social: {...SOCIAL, color: '#e11d48', icons: {youtube: recoloured}}}),
      );
    });

    it('says so when the API drops the icons it was given', async () => {
      fetcher.mockImplementation(async url => (url.endsWith('/footers') ? {} : {...STORED, social: SOCIAL}));
      vi.mocked(network.fetch).mockImplementationOnce(async (_method, _url, body) => ({
        ...(body as ProjectBrand),
        social: {...SOCIAL, icons: {}},
      }));
      await render(true);

      await act(async () => {
        buttonNamed('Save')!.click();
      });

      expect(toast.error).toHaveBeenCalledWith(
        'Brand saved, but the social icons were not: file storage must be served over https.',
      );
    });

    it('saves nothing when an icon cannot be uploaded', async () => {
      fetcher.mockImplementation(async url =>
        url.endsWith('/footers') ? {} : {...STORED, social: {...SOCIAL, icons: {}}},
      );
      vi.mocked(withSocialIcons).mockRejectedValueOnce(new Error('File storage is not configured'));
      await render(true);

      await act(async () => {
        buttonNamed('Save')!.click();
      });

      expect(network.fetch).not.toHaveBeenCalled();
      expect(toast.error).toHaveBeenCalledWith('Couldn’t upload the social icons: File storage is not configured');
    });

    it('uploads nothing while another project is open in the browser, and saves nothing', async () => {
      fetcher.mockImplementation(async url =>
        url.endsWith('/footers') ? {} : {...STORED, social: {...SOCIAL, icons: {}}},
      );
      vi.mocked(withSocialIcons).mockImplementationOnce(async (social, upload) => {
        await upload(new Blob(['png']), 'plunk-social-youtube-circle-111827.png');
        return social;
      });
      localStorage.setItem('activeProjectId', 'project-2');
      await render(true);

      await act(async () => {
        buttonNamed('Save')!.click();
      });

      expect(network.upload).not.toHaveBeenCalled();
      expect(network.fetch).not.toHaveBeenCalled();
      expect(toast.error).toHaveBeenCalledWith(
        'Couldn’t upload the social icons: Another project is open in this browser. Reload the page to save this brand.',
      );
    });

    it('does not offer saving a link it would refuse', async () => {
      fetcher.mockImplementation(async url => (url.endsWith('/footers') ? {} : {...STORED, social: SOCIAL}));
      await render(true);

      await typeInto(
        document.querySelector<HTMLInputElement>('input[aria-label="YouTube link"]')!,
        'https://x.com/{{ a }}',
      );

      expect(buttonNamed('Save')!.disabled).toBe(true);
      expect(container.textContent).toContain('Use an https:// link without spaces or {{ }}.');
    });

    it('keeps them on Reset, which restores the look', async () => {
      fetcher.mockImplementation(async url => (url.endsWith('/footers') ? {} : {...STORED, social: SOCIAL}));
      vi.mocked(network.fetch).mockImplementationOnce(async (_method, _url, body) => body);
      await render(true);

      await act(async () => {
        buttonNamed('Reset')!.click();
      });
      await act(async () => {
        buttonNamed('Save')!.click();
      });

      expect(network.fetch).toHaveBeenCalledWith('PUT', '/projects/project-1/brand', {
        ...BRAND_DEFAULTS,
        button: BUTTON_DEFAULTS,
        social: SOCIAL,
      });
    });
  });

  it('does not offer saving to members who are not admins', async () => {
    await render(false);

    expect(buttonNamed('Save')).toBeUndefined();
    expect(container.textContent).toContain('Only admins can change the brand.');
  });
});
