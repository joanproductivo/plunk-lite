import {type ProjectBrand, toProjectBrand} from '@plunk/shared';
import {toPrismaJson} from '@plunk/types';

import {prisma} from '../database/prisma.js';

/**
 * A project's brand (Plunk Lite): the font, colours, background and width new emails are written
 * in, and the look of new buttons. Each email keeps its own brand in its body, so sending never
 * reads this, and changing it never changes an email already written.
 */
export class BrandService {
  /** The project's brand, or the defaults (the look emails always had) if it has none. */
  public static async get(projectId: string): Promise<ProjectBrand> {
    const row = await prisma.plunkLiteProjectBrand.findUnique({where: {projectId}});
    // Read through the same allowlist as a request, whatever the row holds
    return toProjectBrand(row?.brand);
  }

  /**
   * Saves the project's brand from untrusted data, keeping only known values. Without `social`
   * (a panel from before the social links), the saved networks stay as they are.
   */
  public static async save(projectId: string, value: unknown): Promise<ProjectBrand> {
    const lacksSocial = typeof value === 'object' && value !== null && !('social' in value);
    const brand = toProjectBrand(value);
    if (lacksSocial) brand.social = (await BrandService.get(projectId)).social;
    await prisma.plunkLiteProjectBrand.upsert({
      where: {projectId},
      create: {projectId, brand: toPrismaJson(brand)},
      update: {brand: toPrismaJson(brand)},
    });
    return brand;
  }
}
