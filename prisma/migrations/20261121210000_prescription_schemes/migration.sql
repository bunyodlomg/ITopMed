-- Ready-made prescription schemes: a new kind of clinic template (content = JSON list of medicines).
-- ClinicTemplate already has grants, RLS and the text check constraint; nothing else changes.
ALTER TYPE "TemplateKind" ADD VALUE IF NOT EXISTS 'PRESCRIPTION';
