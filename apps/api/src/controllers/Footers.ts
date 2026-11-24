import {Controller, Get, Middleware, Put} from '@overnightjs/core';
import {type FooterKind, FooterSchemas, type ProjectFooters, toProjectFooters, UtilitySchemas} from '@plunk/shared';
import type {NextFunction, Request, Response} from 'express';

import {ErrorCode, HttpException} from '../exceptions/index.js';
import {requireAuth, requireEmailVerified} from '../middleware/auth.js';
import {MembershipService} from '../services/MembershipService.js';
import {ProjectFooterService} from '../services/ProjectFooterService.js';
import {CatchAsync} from '../utils/asyncHandler.js';

/**
 * A project's own footers (Plunk Lite), which only the dashboard reads and its admins change: the
 * unsubscribe footers of marketing emails (`/footers`) and the notices footers of transactional
 * templates with an opt-out topic (`/opt-out-footers`). Each kind has its own endpoint, with the
 * same map of languages, so a dashboard or image that only knows `/footers` is unaffected.
 */
@Controller('projects')
export class Footers {
  /**
   * GET /projects/:id/footers
   * The project's own footers by language, and only those: the dashboard has Plunk's texts.
   */
  @Get(':id/footers')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async getFooters(req: Request, res: Response, _next: NextFunction) {
    return res.status(200).json(await readFooters(req, res, 'unsubscribe'));
  }

  /**
   * PUT /projects/:id/footers
   * Replaces the project's own footers. Anything that cannot be kept is refused with the reason,
   * rather than dropped.
   */
  @Put(':id/footers')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async saveFooters(req: Request, res: Response, _next: NextFunction) {
    return res.status(200).json(await writeFooters(req, res, 'unsubscribe'));
  }

  /**
   * GET /projects/:id/opt-out-footers
   * The project's own notices footers by language, as `/footers`.
   */
  @Get(':id/opt-out-footers')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async getOptOutFooters(req: Request, res: Response, _next: NextFunction) {
    return res.status(200).json(await readFooters(req, res, 'optOut'));
  }

  /**
   * PUT /projects/:id/opt-out-footers
   * Replaces the project's own notices footers, as `/footers`; the unsubscribe footers stay.
   */
  @Put(':id/opt-out-footers')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async saveOptOutFooters(req: Request, res: Response, _next: NextFunction) {
    return res.status(200).json(await writeFooters(req, res, 'optOut'));
  }
}

async function readFooters(req: Request, res: Response, kind: FooterKind): Promise<ProjectFooters> {
  const auth = res.locals.auth;
  if (auth.type !== 'jwt') {
    throw new HttpException(403, "A project's footers are only available in the dashboard", ErrorCode.FORBIDDEN);
  }
  const {id} = UtilitySchemas.id.parse(req.params);

  await MembershipService.requireAccess(auth.userId!, id);

  return ProjectFooterService.get(id, kind);
}

async function writeFooters(req: Request, res: Response, kind: FooterKind): Promise<ProjectFooters> {
  const auth = res.locals.auth;
  if (auth.type !== 'jwt') {
    throw new HttpException(403, "A project's footers can only be changed in the dashboard", ErrorCode.FORBIDDEN);
  }
  const {id} = UtilitySchemas.id.parse(req.params);

  await MembershipService.requireAdminAccess(auth.userId!, id);

  const body = FooterSchemas.update.safeParse(req.body);
  if (!body.success) {
    throw new HttpException(400, 'The footers must be an object', ErrorCode.INVALID_REQUEST_BODY);
  }
  const {footers, errors} = toProjectFooters(body.data);
  if (errors.length > 0) {
    throw new HttpException(400, errors.join('; '), ErrorCode.VALIDATION_ERROR);
  }

  return ProjectFooterService.save(id, footers, kind);
}
