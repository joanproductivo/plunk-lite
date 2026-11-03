import {
  normalizeHexColor,
  type SocialNetwork,
  type SocialSettings,
  type SocialShape,
  socialIconName,
} from '@plunk/shared';

import {SOCIAL_ICON_PATHS} from './socialIconPaths';

/** What drawing an icon needs from the browser; tests stand in for it (happy-dom has no Path2D). */
export interface IconTools {
  createCanvas: (width: number, height: number) => HTMLCanvasElement;
  createPath: (d: string) => Path2D;
}

const browserTools: IconTools = {
  createCanvas: (width, height) => Object.assign(document.createElement('canvas'), {width, height}),
  createPath: d => new Path2D(d),
};

/** Icons are drawn at 128 px, sharp at the largest size (40 px) on a 3× screen. */
export const SOCIAL_ICON_PX = 128;

/** The icons' own grid, how much of a filled shape the white icon takes, and a square's rounding. */
export const ICON_GRID = 16;
export const ICON_IN_SHAPE = 0.55;
export const SQUARE_RADIUS = 0.22;

// A rounded square across the canvas, drawn with arcs: Safari before 16 has no roundRect
function roundedSquare(context: CanvasRenderingContext2D, size: number, radius: number) {
  context.moveTo(radius, 0);
  context.arcTo(size, 0, size, size, radius);
  context.arcTo(size, size, 0, size, radius);
  context.arcTo(0, size, 0, 0, radius);
  context.arcTo(0, 0, size, 0, radius);
  context.closePath();
}

/**
 * A network's icon as a PNG: the icon alone in `color`, or white on a circle or a rounded square
 * of it, on a transparent background.
 */
export async function composeSocialIcon(
  network: SocialNetwork,
  shape: SocialShape,
  color: string,
  tools = browserTools,
): Promise<Blob> {
  const canvas = tools.createCanvas(SOCIAL_ICON_PX, SOCIAL_ICON_PX);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Couldn’t draw the icon');

  const size = SOCIAL_ICON_PX;
  let iconSize = size;
  if (shape !== 'plain') {
    context.fillStyle = color;
    context.beginPath();
    if (shape === 'circle') {
      context.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
    } else {
      roundedSquare(context, size, size * SQUARE_RADIUS);
    }
    context.fill();
    iconSize = size * ICON_IN_SHAPE;
  }

  const offset = (size - iconSize) / 2;
  context.setTransform(iconSize / ICON_GRID, 0, 0, iconSize / ICON_GRID, offset, offset);
  context.fillStyle = shape === 'plain' ? color : '#ffffff';
  context.fill(tools.createPath(SOCIAL_ICON_PATHS[network]));

  const image = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
  if (!image) throw new Error('Couldn’t draw the icon');
  return image;
}

/** Whether `url` is the icon of `network` drawn in `shape` and `color` (see socialIconName). */
export function isIconFor(url: string | undefined, network: SocialNetwork, shape: SocialShape, color: string) {
  return !!url && url.includes(`-${socialIconName(network, shape, color)}.png`);
}

// The colour as the API stores it and icons are named after: `#rrggbb`
const colorOf = (social: SocialSettings) => normalizeHexColor(social.color) ?? social.color;

/** The linked networks of `social` without an icon in its shape and colour. */
export function missingSocialIcons(social: SocialSettings): SocialNetwork[] {
  return social.links
    .map(link => link.network)
    .filter(network => !isIconFor(social.icons[network], network, social.shape, colorOf(social)));
}

/**
 * `social` with an icon for each of its links in its shape and colour, drawing and uploading only
 * those it lacks; icons of other shapes, colours or networks are dropped. `upload` resolves to an
 * uploaded image's URL.
 */
export async function withSocialIcons(
  social: SocialSettings,
  upload: (image: Blob, name: string) => Promise<string>,
  tools = browserTools,
): Promise<SocialSettings> {
  const color = colorOf(social);
  const missing = missingSocialIcons(social);
  const icons: SocialSettings['icons'] = {};
  for (const {network} of social.links) {
    icons[network] = missing.includes(network)
      ? await upload(
          await composeSocialIcon(network, social.shape, color, tools),
          `${socialIconName(network, social.shape, color)}.png`,
        )
      : social.icons[network];
  }
  return {...social, color, icons};
}
