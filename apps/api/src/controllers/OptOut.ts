import {Controller, Get, Post} from '@overnightjs/core';
import type {NextFunction, Request, Response} from 'express';

import {DASHBOARD_URI} from '../app/constants.js';
import {readTemplateParam} from '../services/TemplateOptOut.js';
import {optOut} from '../services/TemplateOptOutAdmin.js';
import {CatchAsync} from '../utils/asyncHandler.js';

/**
 * Plunk Lite: the opt-out link of a transactional template with an opt-out topic (TemplateOptOut),
 * `/opt-out/<contactId>?t=<templateId>`, in its `List-Unsubscribe` header. Like `/unsubscribe/:id`:
 *
 * - `POST` is RFC 8058 one-click (a mailbox provider, no human present) and the dashboard page's
 *   button: it puts the contact in the template's topic at once.
 * - `GET` is a person following the header link: it redirects to the dashboard page, which asks
 *   before acting, as mail scanners open every link.
 *
 * Both are public, and the contact id is the secret. The template must be of the contact's project,
 * TRANSACTIONAL and with a topic, so the link can only ever add the contact to that one segment.
 *
 * Exempt from rate limiting on purpose, as `/unsubscribe` is: providers send one-click POSTs in
 * bursts, and a throttled opt-out ends in the spam button.
 */
@Controller('opt-out')
export class OptOut {
  /**
   * POST /opt-out/:id?t=<templateId>
   * PUBLIC: 200 with `{status: 'opted-out' | 'unavailable'}` whatever happens. A 404 would tell an
   * unauthenticated caller which ids exist, and an error makes providers retry. The
   * `List-Unsubscribe=One-Click` body carries nothing needed, so it is not parsed.
   */
  @Post(':id')
  @CatchAsync
  public async oneClick(req: Request, res: Response, _next: NextFunction) {
    const contactId = req.params.id;
    const templateId = readTemplateParam(req.query);

    const status = contactId && templateId ? await optOut(contactId, templateId) : 'unavailable';

    return res.status(200).json({status});
  }

  /**
   * GET /opt-out/:id?t=<templateId>
   * PUBLIC: a human followed the header link -- hand them to the dashboard page.
   */
  @Get(':id')
  public redirect(req: Request, res: Response, _next: NextFunction) {
    const contactId = req.params.id;

    if (!contactId) {
      return res.status(400).type('text/plain').send('Contact ID is required');
    }

    const templateId = readTemplateParam(req.query);
    const query = templateId ? `?t=${encodeURIComponent(templateId)}` : '';

    return res.redirect(302, `${DASHBOARD_URI}/opt-out/${encodeURIComponent(contactId)}${query}`);
  }
}
