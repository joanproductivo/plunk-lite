-- Plunk Lite: opt-out topics (TemplateOptOut). "optOutSegmentId" is the static segment a contact
-- joins to stop getting a TRANSACTIONAL template: a column of Plunk's own "templates" table, an id
-- without a foreign key (deleting the segment is refused while a template uses it). An earlier
-- Plunk Lite image leaves it unused and sends those templates to everyone, so going back means
-- checking them first (PLUNK-LITE.md). "optOutFooters" is the notices footer by language, in Plunk
-- Lite's own footers table. Both are nullable with no default, so Postgres only changes the catalog.
-- AlterTable
ALTER TABLE "templates" ADD COLUMN     "optOutSegmentId" TEXT;

-- AlterTable
ALTER TABLE "plunk_lite_project_footers" ADD COLUMN     "optOutFooters" JSONB;
