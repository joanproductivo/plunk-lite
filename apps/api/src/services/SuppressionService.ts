import type {Prisma} from '@plunk/db';
import type {ContactSuppression, SuppressionLift, SuppressionReason} from '@plunk/types';
import signale from 'signale';

import {prisma} from '../database/prisma.js';
import {ConflictError, ErrorCode, HttpException} from '../exceptions/index.js';
import {normalizeEmail} from '../utils/emailAddress.js';
import {removeFromAccountSuppressionList} from './SESService.js';

type Suppression = ContactSuppression;

type Db = Prisma.TransactionClient | typeof prisma;

/**
 * Most addresses the contact list can filter on. They are bound one by one, next to up to 10,000
 * `excludeIds` of a bulk action, and Postgres takes 32,767 parameters in a query.
 */
export const MAX_FILTERED_SUPPRESSIONS = 20_000;

const SUPPRESSED_BECAUSE: Record<SuppressionReason, string> = {
  BOUNCE: 'bounced',
  SOFT_BOUNCE: 'kept bouncing temporarily',
  COMPLAINT: 'reported an email as spam',
};

/** What an address suppressed for this reason did, in a few words, for logs and errors */
export const suppressionCause = (reason: string): string =>
  reason === 'COMPLAINT' ? 'complaint' : reason === 'SOFT_BOUNCE' ? 'repeated temporary bounces' : 'bounce';

/**
 * A request to subscribe an address that is suppressed, made by someone who asked for exactly
 * that: the contact page, an update of that contact, or the dashboard's add-contact form
 */
export class SuppressedAddressError extends ConflictError {
  public constructor(email: string, suppression: Suppression) {
    super(
      `${email} cannot be subscribed: it ${SUPPRESSED_BECAUSE[suppression.reason]} on ${suppression.createdAt.toISOString().slice(0, 10)}. Remove the suppression on its contact page (adding the contact unsubscribed first, if there is none) to subscribe it again.`,
      {suppression},
      ErrorCode.ADDRESS_SUPPRESSED,
    );
  }
}

/**
 * Plunk Lite's own suppression list: addresses a project must not email again after a permanent
 * bounce or a complaint. Plunk only unsubscribes the contact, which many paths can undo; this is
 * kept by address and checked wherever a contact is subscribed and before every send.
 */
export class SuppressionService {
  /**
   * Record addresses as suppressed, from the email whose bounce or complaint it was -- or none,
   * for an import that says the address bounced or complained elsewhere. A complaint on an
   * address suppressed for a bounce replaces the reason, and a bounce or complaint one suppressed
   * for temporary bounces: `isAttemptedBounce` and the export read the stronger one. Anything else
   * recorded stays as it is.
   */
  public static async record(
    db: Db,
    projectId: string,
    addresses: string[],
    reason: SuppressionReason,
    emailId: string | null,
  ): Promise<void> {
    for (const email of new Set(addresses.map(normalizeEmail).filter(Boolean))) {
      await db.$executeRaw`
        INSERT INTO "plunk_lite_suppressions" ("projectId", "email", "reason", "emailId")
        VALUES (${projectId}, ${email}, ${reason}, ${emailId})
        ON CONFLICT ("projectId", "email") DO UPDATE
          SET "reason" = EXCLUDED."reason", "emailId" = EXCLUDED."emailId", "createdAt" = now()
        WHERE ("plunk_lite_suppressions"."reason", EXCLUDED."reason") IN
          (('BOUNCE', 'COMPLAINT'), ('SOFT_BOUNCE', 'BOUNCE'), ('SOFT_BOUNCE', 'COMPLAINT'))`;
    }
  }

  /** The suppressed ones among these addresses, by normalized address */
  public static async suppressedAmong(projectId: string, addresses: string[]): Promise<Map<string, Suppression>> {
    const emails = [...new Set(addresses.map(normalizeEmail))];
    if (emails.length === 0) {
      return new Map();
    }

    const rows = await prisma.plunkLiteSuppression.findMany({
      where: {projectId, email: {in: emails}},
      select: {email: true, reason: true, createdAt: true},
    });

    return new Map(rows.map(row => [row.email, {reason: row.reason as SuppressionReason, createdAt: row.createdAt}]));
  }

  /** Split contacts, of one project or several, into those that may be subscribed and those that may not */
  public static async partition<T extends {projectId: string; email: string}>(
    contacts: T[],
  ): Promise<{allowed: T[]; suppressed: T[]}> {
    const byProject = new Map<string, T[]>();
    for (const contact of contacts) {
      byProject.set(contact.projectId, [...(byProject.get(contact.projectId) ?? []), contact]);
    }

    const allowed: T[] = [];
    const suppressed: T[] = [];
    for (const [projectId, group] of byProject) {
      const listed = await this.suppressedAmong(
        projectId,
        group.map(contact => contact.email),
      );
      for (const contact of group) {
        (listed.has(normalizeEmail(contact.email)) ? suppressed : allowed).push(contact);
      }
    }

    if (suppressed.length > 0) {
      signale.info(`[SUPPRESSION] ${suppressed.length} suppressed contact(s) left unsubscribed`);
    }

    return {allowed, suppressed};
  }

  /**
   * The suppressed addresses that have a contact, which is all the contact list can show: the
   * others would only use up parameters. Over MAX_FILTERED_SUPPRESSIONS, a 400.
   */
  public static async addressesOfContacts(projectId: string): Promise<string[]> {
    const rows = await prisma.$queryRaw<{email: string}[]>`
      SELECT s."email" FROM "plunk_lite_suppressions" s
      JOIN "contacts" c ON c."projectId" = s."projectId" AND c."email" = s."email"
      WHERE s."projectId" = ${projectId}
      LIMIT ${MAX_FILTERED_SUPPRESSIONS + 1}`;

    if (rows.length > MAX_FILTERED_SUPPRESSIONS) {
      throw new HttpException(
        400,
        `This project has more than ${MAX_FILTERED_SUPPRESSIONS.toLocaleString('en')} suppressed contacts, too many to filter on.`,
        ErrorCode.BAD_REQUEST,
      );
    }
    return rows.map(row => row.email);
  }

  public static async find(projectId: string, address: string): Promise<Suppression | null> {
    return (await this.suppressedAmong(projectId, [address])).get(normalizeEmail(address)) ?? null;
  }

  /**
   * Whether a write may subscribe this address. An explicit request (`explicit`) for a suppressed
   * address is refused with SuppressedAddressError; any other gets `false`, so the caller leaves
   * the contact unsubscribed -- an event, an import, a workflow subscribing in passing.
   */
  public static async maySubscribe(projectId: string, address: string, {explicit = false} = {}): Promise<boolean> {
    const suppression = await this.find(projectId, address);
    if (!suppression) {
      return true;
    }
    if (explicit) {
      throw new SuppressedAddressError(normalizeEmail(address), suppression);
    }

    signale.info(
      `[SUPPRESSION] ${normalizeEmail(address)} stays unsubscribed: suppressed after ${suppressionCause(suppression.reason)}`,
    );
    return false;
  }

  /**
   * Remove an address from the list, so it can be subscribed and emailed again, and from the
   * account's list at SES too: left there, the next email bounces without being attempted and that
   * bounce puts the address back on this list. That list protects the whole account, so it is
   * touched only for an address this project sent to, and:
   * - `ses: 'any'`, for the contact page, where someone chose this knowing the reason;
   * - `ses: 'own_bounce'`, for the public page, only after a bounce SES really attempted. SES does
   *   not say why it blocks an address: its bounce for one already blocked is recorded here as a
   *   bounce, and may well be a complaint, which one click from a forwarded email must not undo.
   *
   * SES goes first, as the contact page offers this only while the row exists: if SES does not
   * answer the row stays, so it can be tried again. Without the IAM permission, the row goes anyway
   * and the result says so; otherwise an installation without it could never lift one. Temporary
   * bounces never put the address on SES's list: if it is there it is for something else, and left.
   */
  public static async lift(
    projectId: string,
    address: string,
    {ses}: {ses: 'any' | 'own_bounce'},
  ): Promise<SuppressionLift> {
    const email = normalizeEmail(address);
    const row = await prisma.plunkLiteSuppression.findUnique({
      where: {projectId_email: {projectId, email}},
      select: {reason: true, emailId: true},
    });
    if (!row) {
      return {lifted: false};
    }

    const touchesSes =
      ses === 'any' ? row.emailId !== null && row.reason !== 'SOFT_BOUNCE' : await this.isAttemptedBounce(projectId, row);
    const atSes = touchesSes ? await removeFromAccountSuppressionList(email) : undefined;
    if (atSes === 'unavailable') {
      throw new HttpException(503, 'SES did not answer. Try again.', ErrorCode.EXTERNAL_SERVICE_ERROR);
    }

    const removed = await prisma.plunkLiteSuppression.deleteMany({where: {projectId, email}});
    if (removed.count > 0) {
      signale.info(
        `[SUPPRESSION] Lifted the suppression of ${email} in project ${projectId}${atSes ? ` (SES: ${atSes})` : ''}`,
      );
      await this.markLifted(projectId, email);
    }
    return {lifted: removed.count > 0, ...(atSes && {ses: atSes})};
  }

  /**
   * Where SoftBounceService starts counting again, or the next temporary bounce would suppress the
   * address right back. The lift stands if it cannot be written.
   */
  private static async markLifted(projectId: string, email: string): Promise<void> {
    try {
      const contact = await prisma.contact.findUnique({
        where: {projectId_email: {projectId, email}},
        select: {id: true},
      });
      if (contact) {
        await prisma.event.create({data: {projectId, contactId: contact.id, name: 'contact.suppression_lifted'}});
      }
    } catch (error) {
      signale.warn(`[SUPPRESSION] Could not mark the lift of ${email} in project ${projectId}:`, error);
    }
  }

  /** Whether a row comes from a bounce SES attempted: one already blocked records no `bouncedAt` */
  private static async isAttemptedBounce(
    projectId: string,
    row: {reason: string; emailId: string | null},
  ): Promise<boolean> {
    if (row.reason !== 'BOUNCE' || !row.emailId) {
      return false;
    }
    const email = await prisma.email.findFirst({
      where: {id: row.emailId, projectId, bouncedAt: {not: null}},
      select: {id: true},
    });
    return email !== null;
  }
}
