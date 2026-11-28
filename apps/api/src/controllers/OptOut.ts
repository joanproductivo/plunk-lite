import {Controller, Get, Post} from '@overnightjs/core';
import type {NextFunction, Request, Response} from 'express';

import {DASHBOARD_URI} from '../app/constants.js';
import {optOutLink, readOptOutSource} from '../services/TemplateOptOut.js';
import {optOut} from '../services/TemplateOptOutAdmin.js';
import {CatchAsync} from '../utils/asyncHandler.js';

/**
 * Plunk Lite: the opt-out link of a transactional template or campaign with an opt-out topic
 * (TemplateOptOut), `/opt-out/<contactId>?t=<templateId>` or `/opt-out/<contactId>?c=<campaignId>`,
 * in its `List-Unsubscribe` header. Like `/unsubscribe/:id`:
 *
 * - `POST` is RFC 8058 one-click (a mailbox provider, no human present) and the dashboard page's
 *   button: it puts the contact in the template's or campaign's topic at once.
 * - `GET` is a person following the header link: it redirects to the dashboard page, which asks
 *   before acting, as mail scanners open every link.
 *
 * Both are public, and the contact id is the secret. The template or campaign must be of the
 * contact's project, TRANSACTIONAL and with a topic, so the link can only ever add the contact to that
 * one segment. A link with both `t` and `c` is 'unavailable': no origin is picked out of two.
 *
 * Exempt from rate limiting on purpose, as `/unsubscribe` is: providers send one-click POSTs in
 * bursts, and a throttled opt-out ends in the spam button.
 */
@Controller('opt-out')
export class OptOut {
  /**
   * POST /opt-out/:id?t=<templateId> (or ?c=<campaignId>)
   * PUBLIC: 200 with `{status: 'opted-out' | 'unavailable'}` whatever happens. A 404 would tell an
   * unauthenticated caller which ids exist, and an error makes providers retry. The
   * `List-Unsubscribe=One-Click` body carries nothing needed, so it is not parsed.
   */
  @Post(':id')
  @CatchAsync
  public async oneClick(req: Request, res: Response, _next: NextFunction) {
    const contactId = req.params.id;
    const source = readOptOutSource(req.query);

    const status = contactId && source ? await optOut(contactId, source) : 'unavailable';

    return res.status(200).json({status});
  }

  /**
   * GET /opt-out/:id?t=<templateId> (or ?c=<campaignId>)
   * PUBLIC: a human followed the header link -- hand them to the dashboard page.
   */
  @Get(':id')
  public redirect(req: Request, res: Response, _next: NextFunction) {
    const contactId = req.params.id;

    if (!contactId) {
      return res.status(400).type('text/plain').send('Contact ID is required');
    }

    const source = readOptOutSource(req.query);

    return res.redirect(
      302,
      source
        ? optOutLink(DASHBOARD_URI, contactId, source)
        : `${DASHBOARD_URI}/opt-out/${encodeURIComponent(contactId)}`,
    );
  }
}
