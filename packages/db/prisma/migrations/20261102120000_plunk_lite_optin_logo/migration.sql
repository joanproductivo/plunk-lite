-- Plunk Lite: the logo at the top of the double opt-in email. Optional columns on a table of its own.
-- AlterTable
ALTER TABLE "plunk_lite_optin_settings" ADD COLUMN "logoUrl" TEXT,
ADD COLUMN "logoWidth" INTEGER;
