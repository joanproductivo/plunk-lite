import {
  contrastRatio,
  isValidSocialUrl,
  normalizeHexColor,
  SOCIAL_NETWORKS,
  type SocialNetwork,
  type SocialSettings,
  type SocialShape,
} from '@plunk/shared';
import {Button, Input} from '@plunk/ui';
import {ArrowDown, ArrowUp, X} from 'lucide-react';

import {ColorField, OptionSelect} from './EmailEditor/BlockFields';
import {SOCIAL_ICON_PATHS} from './EmailEditor/socialIconPaths';
import {ICON_GRID, ICON_IN_SHAPE, SQUARE_RADIUS} from './EmailEditor/socialIcons';

const SHAPES: Record<SocialShape, string> = {circle: 'Circle', square: 'Rounded square', plain: 'Icon only'};

// What a network's link looks like, as the field's placeholder
const PLACEHOLDERS: Partial<Record<SocialNetwork, string>> = {
  email: 'mailto:hello@example.com',
  website: 'https://example.com',
  whatsapp: 'https://wa.me/34600000000',
};

/** Below this, an icon alone is hard to see on the email's content colour. */
const ICON_CONTRAST = 3;

/** Whether every link of `social` may be saved (see isValidSocialUrl) and its colour is one. */
export function validSocialFields(social: SocialSettings): boolean {
  return (
    normalizeHexColor(social.color) !== null && social.links.every(link => isValidSocialUrl(link.network, link.url))
  );
}

/** A network's icon as the email will show it, drawn in the dashboard rather than uploaded. */
function SocialIconPreview({
  network,
  shape,
  color,
  size = 28,
}: {
  network: SocialNetwork;
  shape: SocialShape;
  color: string;
  size?: number;
}) {
  const fill = normalizeHexColor(color) ?? '#000000';
  // As composeSocialIcon draws it: the white icon in the middle of a filled shape
  const inset = shape === 'plain' ? 0 : (ICON_GRID / ICON_IN_SHAPE - ICON_GRID) / 2;
  const box = ICON_GRID + inset * 2;
  return (
    <svg width={size} height={size} viewBox={`${-inset} ${-inset} ${box} ${box}`} aria-label={SOCIAL_NETWORKS[network]}>
      {shape === 'circle' && <circle cx={ICON_GRID / 2} cy={ICON_GRID / 2} r={box / 2} fill={fill} />}
      {shape === 'square' && (
        <rect x={-inset} y={-inset} width={box} height={box} rx={box * SQUARE_RADIUS} fill={fill} />
      )}
      <path d={SOCIAL_ICON_PATHS[network]} fill={shape === 'plain' ? fill : '#ffffff'} />
    </svg>
  );
}

/**
 * The brand's social links (Plunk Lite): the networks in the order they are shown, with their
 * links, and the shape and colour of their icons, which the social links block places in an email.
 */
export function SocialLinksFields({
  value,
  contentColor,
  onChange,
}: {
  value: SocialSettings;
  /** The email's content colour, which an icon alone has to stand out on. */
  contentColor: string;
  onChange: (value: SocialSettings) => void;
}) {
  const {links} = value;
  const setLinks = (next: SocialSettings['links']) => onChange({...value, links: next});
  const move = (index: number, by: number) => {
    const next = [...links];
    const [link] = next.splice(index, 1);
    next.splice(index + by, 0, link!);
    setLinks(next);
  };
  const unused = (Object.keys(SOCIAL_NETWORKS) as SocialNetwork[]).filter(
    network => !links.some(link => link.network === network),
  );
  const color = normalizeHexColor(value.color);
  const lowContrast = value.shape === 'plain' && color !== null && contrastRatio(color, contentColor) < ICON_CONTRAST;

  return (
    <div className="space-y-4">
      {links.length === 0 && (
        <p className="text-sm text-neutral-500">Add the networks your emails link to, in the order to show them.</p>
      )}
      {links.map((link, index) => {
        const valid = isValidSocialUrl(link.network, link.url);
        return (
          <div key={link.network}>
            <div className="flex items-center gap-2">
              <SocialIconPreview network={link.network} shape={value.shape} color={value.color} />
              <Input
                aria-label={`${SOCIAL_NETWORKS[link.network]} link`}
                value={link.url}
                placeholder={PLACEHOLDERS[link.network] ?? `${SOCIAL_NETWORKS[link.network]} profile (https://…)`}
                onChange={e =>
                  setLinks(links.map((other, at) => (at === index ? {...other, url: e.target.value} : other)))
                }
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Move up"
                disabled={index === 0}
                onClick={() => move(index, -1)}
              >
                <ArrowUp className="h-4 w-4" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Move down"
                disabled={index === links.length - 1}
                onClick={() => move(index, 1)}
              >
                <ArrowDown className="h-4 w-4" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Remove ${SOCIAL_NETWORKS[link.network]}`}
                onClick={() => setLinks(links.filter((_, at) => at !== index))}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
            {!valid && link.url.trim() !== '' && (
              <p className="mt-1 text-xs text-red-700">
                {link.network === 'email'
                  ? 'Use a mailto: link, such as mailto:hello@example.com.'
                  : 'Use an https:// link without spaces or {{ }}.'}
              </p>
            )}
          </div>
        );
      })}

      {unused.length > 0 && (
        <OptionSelect
          label="Add a network"
          placeholder="Choose a network"
          value={'' as SocialNetwork}
          options={
            Object.fromEntries(unused.map(network => [network, SOCIAL_NETWORKS[network]])) as Record<
              SocialNetwork,
              string
            >
          }
          onChange={network => setLinks([...links, {network, url: ''}])}
        />
      )}

      <div className="grid grid-cols-2 gap-3">
        <OptionSelect
          label="Icon shape"
          value={value.shape}
          options={SHAPES}
          onChange={shape => onChange({...value, shape})}
        />
        <ColorField
          id="brand-social-color"
          label="Icon color"
          value={value.color}
          onChange={next => onChange({...value, color: next})}
        />
      </div>
      {lowContrast && (
        <p className="text-xs text-amber-700">
          Icons alone in this color are hard to see on the email’s content color. Choose a circle or a square, or
          another color.
        </p>
      )}
    </div>
  );
}
