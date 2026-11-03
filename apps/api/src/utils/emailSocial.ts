import {declarations, SOCIAL_GAP, SOCIAL_SIZES, socialSizeOf} from '@plunk/shared';
import type {CheerioAPI} from 'cheerio/slim';

/**
 * Editor social links as every client lays them out (see @plunk/shared emailSocial): a one-row
 * table with an icon per cell, as Outlook for Windows ignores an image's margins and inline
 * display. Only visual editor content gets here, whose blocks are as the editor writes them (see
 * hasForeignSocial); one that still is not (no icon, an image without an http(s) source) is left
 * as it is, a paragraph the inlined prose styles lay out in a row. Runs after the prose styles are
 * inlined, replacing what they wrote on the links and images.
 */
export function convertSocial($: CheerioAPI): void {
  $('p.email-social').each((_, element) => {
    const paragraph = $(element);
    const links = paragraph.children();
    const blankText = paragraph
      .contents()
      .toArray()
      .every(node => node.type === 'tag' || (node.type === 'text' && !/[^ \t\n\r\f]/.test($(node).text())));
    const canonical =
      blankText &&
      links.toArray().every(link => {
        const node = $(link);
        return (
          node.is('a') &&
          node.contents().length === 1 &&
          node.children().first().is('img[src]') &&
          /^https?:\/\//i.test(node.children().first().attr('src') ?? '')
        );
      });
    if (!canonical) return;
    // An empty block (written by the API, as the editor never saves one) would be a blank gap
    if (links.length === 0) {
      paragraph.remove();
      return;
    }

    // The paragraph's own space above and below, as inlined (none as the first or last block)
    const style = declarations(paragraph.attr('style'));
    const align = style.get('text-align');
    const [top, bottom] = ['margin-top', 'margin-bottom'].map(side => style.get(side) ?? '16px');
    const sides = align === 'center' ? ['auto', 'auto'] : align === 'right' ? ['0', 'auto'] : ['0', '0'];
    const table = $(
      `<table role="presentation" data-plunk-social${align === 'center' || align === 'right' ? ` align="${align}"` : ''} ` +
        `cellpadding="0" cellspacing="0" border="0" style="margin: ${top} ${sides[0]} ${bottom} ${sides[1]}; border-collapse: collapse;"><tr></tr></table>`,
    );

    // Built from copies, so the paragraph stays whole until the table replaces it
    links.each((__, link) => {
      const anchor = $(link).clone();
      const image = anchor.children().first();
      // The size the editor offers closest to the image's own width: never one copied from the body
      const px = SOCIAL_SIZES[socialSizeOf(Number.parseInt(image.attr('width') ?? '', 10) || 0)];
      image
        .attr('width', String(px))
        .attr('height', String(px))
        .attr('style', `display: block; border: 0; width: ${px}px; height: ${px}px; margin: 0;`)
        .removeAttr('class');
      // Marked so the plain-text part names the network (see htmlToPlainText)
      anchor.attr('style', 'text-decoration: none;').attr('data-plunk-social', '');

      const cell = $(`<td style="padding: 0 ${SOCIAL_GAP / 2}px; line-height: 0; font-size: 0;"></td>`);
      cell.append(anchor);
      table.find('tr').append(cell);
    });
    paragraph.replaceWith(table);
  });
}
