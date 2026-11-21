-- Optional map link of the clinic (Google / Yandex maps); printed as a QR code on the letterhead.
ALTER TABLE "Tenant" ADD COLUMN "locationUrl" TEXT;
ALTER TABLE "Tenant" ADD CONSTRAINT "Tenant_locationUrl_chk" CHECK ("locationUrl" IS NULL OR ("locationUrl" ~ '^https://' AND length("locationUrl") <= 500));
GRANT UPDATE ("locationUrl") ON "Tenant" TO itopmed_app;
