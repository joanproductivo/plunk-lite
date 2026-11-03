import {SOCIAL_DEFAULTS} from '@plunk/shared';
import {describe, expect, it, vi} from 'vitest';

import {
  composeSocialIcon,
  type IconTools,
  isIconFor,
  missingSocialIcons,
  SOCIAL_ICON_PX,
  withSocialIcons,
} from '../socialIcons';
import {SOCIAL_ICON_PATHS} from '../socialIconPaths';

// A canvas that records what is drawn on it, as happy-dom draws nothing
function fakeTools() {
  const calls: string[] = [];
  const context = {
    fillStyle: '',
    beginPath: () => calls.push('beginPath'),
    arc: (...args: number[]) => calls.push(`arc ${args.join(' ')}`),
    moveTo: (...args: number[]) => calls.push(`moveTo ${args.join(' ')}`),
    arcTo: (...args: number[]) => calls.push(`arcTo ${args.join(' ')}`),
    closePath: () => calls.push('closePath'),
    fill: (path?: {d: string}) => calls.push(`fill ${context.fillStyle}${path ? ` path ${path.d.slice(0, 12)}` : ''}`),
    setTransform: (...args: number[]) => calls.push(`setTransform ${args.map(n => +n.toFixed(2)).join(' ')}`),
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => context,
    toBlob: (resolve: (blob: Blob | null) => void, type: string) => resolve(new Blob(['png'], {type})),
  };
  const tools: IconTools = {
    createCanvas: (width, height) => Object.assign(canvas, {width, height}) as unknown as HTMLCanvasElement,
    createPath: d => ({d}) as unknown as Path2D,
  };
  return {tools, calls, canvas};
}

describe('composeSocialIcon', () => {
  it('draws the icon alone in the colour, across the whole image', async () => {
    const {tools, calls, canvas} = fakeTools();

    const image = await composeSocialIcon('instagram', 'plain', '#e11d48', tools);

    expect(image.type).toBe('image/png');
    expect(canvas.width).toBe(SOCIAL_ICON_PX);
    expect(calls).toEqual([
      `setTransform 8 0 0 8 0 0`,
      `fill #e11d48 path ${SOCIAL_ICON_PATHS.instagram.slice(0, 12)}`,
    ]);
  });

  it('draws a white icon in the middle of a circle or a rounded square of the colour', async () => {
    const circle = fakeTools();
    await composeSocialIcon('youtube', 'circle', '#111827', circle.tools);
    expect(circle.calls).toEqual([
      'beginPath',
      'arc 64 64 64 0 6.283185307179586',
      'fill #111827',
      'setTransform 4.4 0 0 4.4 28.8 28.8',
      `fill #ffffff path ${SOCIAL_ICON_PATHS.youtube.slice(0, 12)}`,
    ]);

    const square = fakeTools();
    await composeSocialIcon('email', 'square', '#111827', square.tools);
    expect(square.calls.slice(1, 7)).toEqual([
      'moveTo 28.16 0',
      'arcTo 128 0 128 128 28.16',
      'arcTo 128 128 0 128 28.16',
      'arcTo 0 128 0 0 28.16',
      'arcTo 0 0 128 0 28.16',
      'closePath',
    ]);
  });

  it('fails when the browser cannot make the image', async () => {
    const {tools, canvas} = fakeTools();
    canvas.toBlob = resolve => resolve(null);

    await expect(composeSocialIcon('x', 'plain', '#000000', tools)).rejects.toThrow('Couldn’t draw the icon');
  });
});

describe('withSocialIcons', () => {
  const own = 'https://files.example.com/p/1-0123456789abcdef-plunk-social-youtube-circle-111827.png';

  it('uploads only the icons missing in the shape and colour, named after them, and drops the rest', async () => {
    const {tools} = fakeTools();
    const upload = vi.fn(async (_image: Blob, name: string) => `https://files.example.com/${name}`);

    const social = await withSocialIcons(
      {
        ...SOCIAL_DEFAULTS,
        links: [
          {network: 'youtube', url: 'https://youtube.com/@a'},
          {network: 'x', url: 'https://x.com/a'},
        ],
        icons: {youtube: own, x: 'https://files.example.com/p/1-0123456789abcdef-plunk-social-x-square-111827.png'},
      },
      upload,
      tools,
    );

    expect(upload).toHaveBeenCalledOnce();
    expect(upload).toHaveBeenCalledWith(expect.any(Blob), 'plunk-social-x-circle-111827.png');
    expect(social.icons).toEqual({youtube: own, x: 'https://files.example.com/plunk-social-x-circle-111827.png'});
  });

  it('names icons after the colour as stored, however it was typed', async () => {
    const {tools} = fakeTools();
    const upload = vi.fn(
      async (_image: Blob, name: string) => `https://files.example.com/p/1-0123456789abcdef-${name}`,
    );
    const social = {...SOCIAL_DEFAULTS, color: '#ABC', links: [{network: 'x' as const, url: 'https://x.com/a'}]};

    const saved = await withSocialIcons(social, upload, tools);

    expect(upload).toHaveBeenCalledWith(expect.any(Blob), 'plunk-social-x-circle-aabbcc.png');
    expect(saved.color).toBe('#aabbcc');
    expect(missingSocialIcons(saved)).toEqual([]);
    expect(missingSocialIcons({...saved, shape: 'square'})).toEqual(['x']);
  });

  it('tells an icon of another network, shape or colour apart', () => {
    expect(isIconFor(own, 'youtube', 'circle', '#111827')).toBe(true);
    expect(isIconFor(own, 'youtube', 'square', '#111827')).toBe(false);
    expect(isIconFor(own, 'youtube', 'circle', '#111828')).toBe(false);
    expect(isIconFor(own, 'x', 'circle', '#111827')).toBe(false);
    expect(isIconFor(undefined, 'x', 'circle', '#111827')).toBe(false);
  });
});
