import {
  SOCIAL_DEFAULT_SIZE,
  SOCIAL_NETWORKS,
  SOCIAL_SIZES,
  type SocialItem,
  type SocialSettings,
  type SocialSize,
} from '@plunk/shared';
import {Button, Checkbox, Dialog, DialogContent, DialogHeader, DialogTitle, Label} from '@plunk/ui';
import Link from 'next/link';
import {useState} from 'react';

import {OptionSelect} from './BlockFields';
import type {SocialAttrs} from './EmailSocial';
import type {BlockDialogProps} from './useBlockDialog';

const SIZES: Record<SocialSize, string> = {
  small: `Small (${SOCIAL_SIZES.small}px)`,
  medium: `Medium (${SOCIAL_SIZES.medium}px)`,
  large: `Large (${SOCIAL_SIZES.large}px)`,
};

type Alignment = 'left' | 'center' | 'right';
const ALIGNMENTS: Record<Alignment, string> = {left: 'Left', center: 'Center', right: 'Right'};

/** What the dialog submits: the block's items and size, and its alignment (see EmailTextAlign). */
export type SocialDialogAttrs = SocialAttrs & {textAlign: 'center' | 'right' | null};

/**
 * What the block may show: its own items, which keep their link and icon (an email keeps what it
 * was given), then the brand's other networks that have an icon, with the brand's.
 */
export function socialChoices(social: SocialSettings | undefined, current: readonly SocialItem[]): SocialItem[] {
  const fromBrand = (social?.links ?? []).flatMap(({network, url}) => {
    const icon = social?.icons[network];
    return icon && !current.some(item => item.network === network) ? [{network, url, icon}] : [];
  });
  return [...current, ...fromBrand];
}

/** Places the brand's social links in an email, or edits a block of them. */
export function SocialDialog({
  open,
  onOpenChange,
  initial,
  onSubmit,
  social,
}: BlockDialogProps<SocialDialogAttrs> & {social: SocialSettings | undefined}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{initial ? 'Edit social links' : 'Social links'}</DialogTitle>
        </DialogHeader>
        {/* The content unmounts when the dialog closes, so each opening starts from `initial` */}
        <SocialForm
          initial={initial}
          choices={socialChoices(social, initial?.items ?? [])}
          onSubmit={onSubmit}
          onCancel={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

function SocialForm(props: {
  initial: SocialDialogAttrs | null;
  choices: SocialItem[];
  onSubmit: (attrs: SocialDialogAttrs) => void;
  onCancel: () => void;
}) {
  const {initial, choices} = props;
  // A new block shows every network; an edited one, those it has
  const [chosen, setChosen] = useState(
    () =>
      new Set(
        choices
          .filter(item => !initial || initial.items.some(own => own.network === item.network))
          .map(item => item.network),
      ),
  );
  const [size, setSize] = useState<SocialSize>(initial?.size ?? SOCIAL_DEFAULT_SIZE);
  const [alignment, setAlignment] = useState<Alignment>(initial ? (initial.textAlign ?? 'left') : 'center');

  if (choices.length === 0) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-neutral-600">
          Add your networks in{' '}
          <Link href="/settings?tab=brand" className="underline">
            Settings → Brand
          </Link>{' '}
          and save, then place them here.
        </p>
        <div className="flex justify-end">
          <Button type="button" variant="outline" onClick={props.onCancel}>
            Close
          </Button>
        </div>
      </div>
    );
  }

  const toggle = (network: SocialItem['network'], on: boolean) =>
    setChosen(prev => {
      const next = new Set(prev);
      if (on) next.add(network);
      else next.delete(network);
      return next;
    });

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        {choices.map(item => (
          <div key={item.network} className="flex items-center gap-2">
            <Checkbox
              id={`social-${item.network}`}
              checked={chosen.has(item.network)}
              onCheckedChange={checked => toggle(item.network, checked === true)}
            />
            {/* eslint-disable-next-line @next/next/no-img-element -- an icon in the project's storage */}
            <img src={item.icon} alt="" width={20} height={20} />
            <Label htmlFor={`social-${item.network}`} className="text-sm">
              {SOCIAL_NETWORKS[item.network]}
            </Label>
          </div>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <OptionSelect label="Size" value={size} options={SIZES} onChange={setSize} />
        <OptionSelect label="Alignment" value={alignment} options={ALIGNMENTS} onChange={setAlignment} />
      </div>
      <div className="flex gap-2 justify-end">
        <Button type="button" variant="outline" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button
          type="button"
          disabled={chosen.size === 0}
          onClick={() =>
            props.onSubmit({
              items: choices.filter(item => chosen.has(item.network)),
              size,
              textAlign: alignment === 'left' ? null : alignment,
            })
          }
        >
          {initial ? 'Save' : 'Insert'}
        </Button>
      </div>
    </div>
  );
}
