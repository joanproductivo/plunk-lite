import {
  BRAND_DEFAULTS,
  type FooterKind,
  footerParagraph,
  type FooterSchemas,
  isPlunkFooter,
  plunkFooterTemplate,
  type ProjectBrand,
  type ProjectFooter,
  type ProjectFooters,
  resolveContactLanguage,
  SUPPORTED_LANGUAGES,
  toProjectFooters,
} from '@plunk/shared';
import {Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, Textarea} from '@plunk/ui';
import {useState} from 'react';
import {toast} from 'sonner';
import useSWR from 'swr';

import {wrapEmailWithFooter} from '../lib/emailStyles';
import {network} from '../lib/network';

import {OptionSelect} from './EmailEditor/BlockFields';
import {brandUrl} from './EmailEditor/useEmailBrand';

/** The URL a project's own footers are read from and saved to (Plunk Lite: of each kind). */
export const footersUrl = (projectId: string, kind: FooterKind = 'unsubscribe') =>
  `/projects/${projectId}/${kind === 'optOut' ? 'opt-out-footers' : 'footers'}`;

/** Plunk Lite: what tells each kind of footer apart on the page */
const COPY: Record<FooterKind, {title: string; description: string; link: string; idPrefix: string}> = {
  unsubscribe: {
    title: 'Unsubscribe footer',
    description:
      "The text at the end of every marketing email, in each contact's language. Languages without a text of their own use Plunk's.",
    link: 'the link to update preferences',
    idPrefix: 'footer',
  },
  optOut: {
    title: 'Notices footer (transactional templates and campaigns with an opt-out topic)',
    description:
      "The text at the end of every email of a transactional template or campaign with an opt-out topic, in each contact's language, unless its body has its own {{optOutUrl}} link. Languages without a text of their own use Plunk's.",
    link: 'the link to stop these notices',
    idPrefix: 'optout-footer',
  },
};

// What the preview shows above the footer
const SAMPLE = '<p>Hi Ana, this is the end of an email.</p>';

// The footers as JSON whatever order their languages were added in, to tell whether they changed
const canonical = (footers: ProjectFooters) =>
  JSON.stringify(Object.entries(footers).sort(([a], [b]) => a.localeCompare(b)));

interface FooterSettingsProps {
  projectId: string;
  projectName: string;
  language: string;
  canEdit: boolean;
  /** Plunk Lite: which footer, the marketing one by default */
  kind?: FooterKind;
}

export function FooterSettings(props: FooterSettingsProps) {
  const kind = props.kind ?? 'unsubscribe';
  const {data, error} = useSWR<ProjectFooters>(footersUrl(props.projectId, kind), {revalidateOnFocus: false});

  return (
    <Card>
      <CardHeader>
        <CardTitle>{COPY[kind].title}</CardTitle>
        <CardDescription>{COPY[kind].description}</CardDescription>
      </CardHeader>
      <CardContent>
        {data ? (
          // Mounted once the footers load, so the form starts from them, and again for another project
          <FooterForm key={props.projectId} {...props} saved={data} />
        ) : error ? (
          <p className="text-sm text-red-700">{error instanceof Error ? error.message : String(error)}</p>
        ) : (
          <p className="text-sm text-neutral-500">Loading…</p>
        )}
      </CardContent>
    </Card>
  );
}

function FooterForm({
  projectId,
  projectName,
  language,
  canEdit,
  kind = 'unsubscribe',
  saved,
}: FooterSettingsProps & {saved: ProjectFooters}) {
  // Only languages with a footer of their own are here: the others show Plunk's and stay Plunk's
  const [footers, setFooters] = useState<ProjectFooters>(saved);
  const [code, setCode] = useState(resolveContactLanguage(null, language));
  const [saving, setSaving] = useState(false);
  const {mutate} = useSWR<ProjectFooters>(footersUrl(projectId, kind), {revalidateOnFocus: false});
  const {data: brand} = useSWR<ProjectBrand>(brandUrl(projectId), {revalidateOnFocus: false});
  const {link, idPrefix} = COPY[kind];

  const own = Object.hasOwn(footers, code) ? footers[code] : undefined;
  const shown = own ?? plunkFooterTemplate(code, kind);
  const {errors} = toProjectFooters(footers);
  const changed = canonical(footers) !== canonical(saved);

  const restore = () =>
    setFooters(prev => Object.fromEntries(Object.entries(prev).filter(([key]) => key !== code)) as ProjectFooters);
  // Edited back to just what Plunk's says, a language needs no footer of its own
  const edit = (field: keyof ProjectFooter, value: string) => {
    const next = {...shown, [field]: value};
    if (isPlunkFooter(next, code, kind)) restore();
    else setFooters(prev => ({...prev, [code]: next}));
  };

  const languages = Object.fromEntries(
    SUPPORTED_LANGUAGES.map(({code: key, nativeName}) => [
      key,
      Object.hasOwn(footers, key) ? `${nativeName} · own text` : nativeName,
    ]),
  );

  const save = async () => {
    setSaving(true);
    try {
      const next = await network.fetch<ProjectFooters, typeof FooterSchemas.update>(
        'PUT',
        footersUrl(projectId, kind),
        footers,
      );
      setFooters(next);
      await mutate(next, {revalidate: false});
      toast.success('Footer saved');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Couldn’t save the footer. Try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="space-y-4">
        <OptionSelect label="Language" value={code} options={languages} onChange={setCode} />
        <div>
          <Label htmlFor={`${idPrefix}-text`} className="text-sm font-medium mb-2 block">
            Text
          </Label>
          <Textarea
            id={`${idPrefix}-text`}
            rows={5}
            value={shown.text}
            disabled={!canEdit}
            onChange={e => edit('text', e.target.value)}
          />
          <p className="mt-1 text-xs text-neutral-500">
            {'{projectName}'} becomes the project&apos;s name, and {'{link}'} {link}. Without {'{link}'}, the link goes
            at the end: it is always added.
          </p>
        </div>
        <div>
          <Label htmlFor={`${idPrefix}-link`} className="text-sm font-medium mb-2 block">
            Link text
          </Label>
          <Input
            id={`${idPrefix}-link`}
            value={shown.linkText}
            disabled={!canEdit}
            onChange={e => edit('linkText', e.target.value)}
          />
        </div>
        {errors.length > 0 && <p className="text-xs text-red-700">{errors.join(' ')}</p>}

        <div className="flex items-center justify-end gap-3 border-t border-neutral-200 pt-4">
          {canEdit ? (
            <>
              <Button type="button" variant="outline" onClick={restore} disabled={!own}>
                Restore Plunk&apos;s text
              </Button>
              <Button type="button" onClick={save} disabled={!changed || errors.length > 0 || saving}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
            </>
          ) : (
            <p className="text-sm text-neutral-500">Only admins can change the footer.</p>
          )}
        </div>
      </div>

      <div>
        <p className="mb-2 text-sm font-medium text-neutral-900">Preview</p>
        <iframe
          title="Footer preview"
          sandbox=""
          srcDoc={wrapEmailWithFooter(
            SAMPLE,
            brand ?? BRAND_DEFAULTS,
            footerParagraph({language: code, projectName, href: '#', footers, kind}),
          )}
          className="h-[320px] w-full rounded border border-neutral-200 bg-white"
        />
      </div>
    </div>
  );
}
