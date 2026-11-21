import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { AuthLayout } from "@/components/shell/auth-layout";
import { TelegramMiniApp } from "@/components/telegram-mini-app";
import { clinicPublic } from "@/server/telegram/clinic-bot";

/**
 * Mini App of a CLINIC's own bot (its menu button opens /tg/<slug>).
 * Public by design: who the person is comes from Telegram's launch data, signed
 * with this clinic's bot token and verified on the server by /auth/telegram/webapp.
 */
export const metadata: Metadata = { referrer: "no-referrer", robots: { index: false } };
export const dynamic = "force-dynamic";

export default async function ClinicTelegramAppPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ next?: string }> }) {
  const { slug } = await params;
  const { next } = await searchParams;
  const clinic = await clinicPublic(slug);
  if (!clinic) notFound();
  const t = await getTranslations("telegramApp");
  return (
    <AuthLayout title={clinic.name} subtitle={t("title")}>
      <TelegramMiniApp slug={clinic.slug} next={typeof next === "string" ? next : undefined} />
    </AuthLayout>
  );
}
