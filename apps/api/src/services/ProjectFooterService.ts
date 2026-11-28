import {type FooterKind, type ProjectFooters, toProjectFooters} from '@plunk/shared';
import {toPrismaJson} from '@plunk/types';
import signale from 'signale';

import {prisma} from '../database/prisma.js';

// Every marketing email reads its project's footers (Plunk Lite: and every email with an opt-out
// topic, its notices footers), so each process keeps them for a minute: one
// read per project and minute however large the campaign, and a saved change reaches emails within
// a minute. Projects without footers of their own are remembered too. Both kinds come from one row
// and are remembered together, so saving one never serves the other as empty.
const TTL_MS = 60_000;
const MAX_ENTRIES = 1000;
type FooterSets = Record<FooterKind, ProjectFooters>;
const remembered = new Map<string, {sets: FooterSets; until: number}>();

const COLUMN = {unsubscribe: 'footers', optOut: 'optOutFooters'} as const;

function toSets(row: {footers: unknown; optOutFooters: unknown} | null): FooterSets {
  return {
    unsubscribe: toProjectFooters(row?.footers).footers,
    optOut: toProjectFooters(row?.optOutFooters).footers,
  };
}

/**
 * A project's own footers, by language (Plunk Lite): the unsubscribe footer of marketing emails, and
 * the notices footer of transactional templates and campaigns with an opt-out topic (`optOut`).
 */
export class ProjectFooterService {
  /** The project's footers of `kind`, read through the same checks as a request; {} if it has none. */
  public static async get(projectId: string, kind: FooterKind = 'unsubscribe'): Promise<ProjectFooters> {
    const hit = remembered.get(projectId);
    if (hit && hit.until > Date.now()) {
      return hit.sets[kind];
    }

    let row;
    try {
      row = await prisma.plunkLiteProjectFooters.findUnique({where: {projectId}});
    } catch (error) {
      // The last footers read, however old, beat none: only a project never read fails the email
      if (hit) {
        signale.warn(`[FOOTERS] Failed to read the footers of project ${projectId}, using the last read:`, error);
        return hit.sets[kind];
      }
      throw error;
    }
    const sets = toSets(row);
    this.remember(projectId, sets);
    return sets[kind];
  }

  /**
   * The unsubscribe footers a marketing email is sent with; none for other emails, which carry no
   * footer. A failed read with nothing read before throws: the worker reads them before marking the
   * email, so the job is retried rather than the email sent without the project's footer. (An email
   * with an opt-out topic reads its notices footers with `get(projectId, 'optOut')`, the same way.)
   */
  public static async forEmail(emailClass: string, projectId: string): Promise<ProjectFooters | undefined> {
    return emailClass === 'marketing' ? this.get(projectId) : undefined;
  }

  /** Replaces the project's footers of `kind` with `footers`, already checked, leaving the other kind. */
  public static async save(
    projectId: string,
    footers: ProjectFooters,
    kind: FooterKind = 'unsubscribe',
  ): Promise<ProjectFooters> {
    const value = toPrismaJson(footers);
    // `footers` is required, so a row first written for the notices footer starts with none of its own
    const row = await prisma.plunkLiteProjectFooters.upsert({
      where: {projectId},
      create: kind === 'optOut' ? {projectId, footers: {}, optOutFooters: value} : {projectId, footers: value},
      update: {[COLUMN[kind]]: value},
    });
    this.remember(projectId, toSets(row));
    return footers;
  }

  /** Test seam: forget what was remembered. */
  public static clearCache(): void {
    remembered.clear();
  }

  private static remember(projectId: string, sets: FooterSets): void {
    if (remembered.size >= MAX_ENTRIES) {
      remembered.clear();
    }
    remembered.set(projectId, {sets, until: Date.now() + TTL_MS});
  }
}
