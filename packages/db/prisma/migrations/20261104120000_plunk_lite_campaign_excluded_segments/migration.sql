-- Plunk Lite: segments a campaign leaves out (CampaignService.buildExclusionWhereAsync). A column of
-- Plunk's own "campaigns" table: Plunk Lite no longer goes back to the official image (2026-11-04).
-- An earlier Plunk Lite image leaves it unused and sends those campaigns to their whole audience,
-- so going back means checking them first (PLUNK-LITE.md). With a constant default, Postgres only
-- changes the catalog: the table is not rewritten.
-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN     "excludedSegmentIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
