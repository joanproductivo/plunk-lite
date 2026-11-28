-- Plunk Lite: opt-out topics in TRANSACTIONAL campaigns (TemplateOptOut). "optOutSegmentId" is the
-- static segment a contact joins to stop getting a campaign's kind of email: a column of Plunk's own
-- "campaigns" table, an id without a foreign key (deleting the segment is refused while a draft,
-- scheduled or sending campaign uses it, or one sent or cancelled and not archived). An earlier
-- Plunk Lite image leaves it unused and sends those campaigns to everyone, so going back means
-- checking them first (PLUNK-LITE.md). Nullable with no default, so Postgres only changes the
-- catalog.
-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN     "optOutSegmentId" TEXT;
