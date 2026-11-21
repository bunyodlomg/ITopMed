import { getFormatter, getTranslations } from "next-intl/server";
import { readingBand } from "@/lib/bp";
import { Badge, Card, CardHeader, Table, Td, Th } from "@/components/ui/primitives";

export type HomeReading = { id: string; systolic: number; diastolic: number; pulse: number | null; measuredAt: Date; source: "TELEGRAM" | "PORTAL" };

const BAND_TONE = { low: "warning", normal: "success", high: "warning", veryHigh: "danger" } as const;

/** Blood pressure / pulse the patient measured at home (patient-reported; colour bands are a cue, not advice). */
export async function HomeReadingsTable({ readings, timeZone, caption }: { readings: HomeReading[]; timeZone: string; caption: string }) {
  const [t, format] = await Promise.all([getTranslations("homeReadings"), getFormatter()]);
  return (
    <Table caption={caption}>
      <thead>
        <tr>
          <Th>{t("when")}</Th>
          <Th>{t("bp")}</Th>
          <Th>{t("pulse")}</Th>
          <Th>{t("source")}</Th>
        </tr>
      </thead>
      <tbody>
        {readings.map((r) => {
          const band = readingBand(r);
          return (
            <tr key={r.id}>
              <Td className="tabular-nums">{format.dateTime(r.measuredAt, { dateStyle: "short", timeStyle: "short", timeZone })}</Td>
              <Td label={t("bp")} className="tabular-nums">
                <span className="font-semibold">
                  {r.systolic}/{r.diastolic}
                </span>{" "}
                <Badge tone={BAND_TONE[band]}>{t(`band.${band}`)}</Badge>
              </Td>
              <Td label={t("pulse")} className="tabular-nums">
                {r.pulse ?? "—"}
              </Td>
              <Td label={t("source")} className="text-text-2">
                {t(`via.${r.source}`)}
              </Td>
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}

/** The visit's card: home readings sent by the patient, and their answer to the check-in after the visit. */
export async function HomeReadingsCard({
  readings,
  timeZone,
  checkIn,
}: {
  readings: HomeReading[];
  timeZone: string;
  checkIn: { askAt: Date; answer: "BETTER" | "SAME" | "WORSE" | null; answeredAt: Date | null } | null;
}) {
  const [t, format] = await Promise.all([getTranslations("homeReadings"), getFormatter()]);
  const day = (d: Date) => format.dateTime(d, { dateStyle: "medium", timeZone });
  return (
    <Card>
      <CardHeader title={t("title")} description={t("hint")} />
      {checkIn ? (
        <p className="px-5 pt-3 text-[14px] sm:px-6">
          <span className="font-medium">{t("checkIn")}:</span>{" "}
          {checkIn.answer ? (
            <>
              <Badge tone={CHECKIN_TONE[checkIn.answer]}>{t(`answer.${checkIn.answer}`)}</Badge>
              <span className="text-text-3"> · {day(checkIn.answeredAt!)}</span>
            </>
          ) : (
            <span className="text-text-2">{checkIn.askAt > new Date() ? t("checkInPlanned", { date: day(checkIn.askAt) }) : t("checkInNoAnswer")}</span>
          )}
        </p>
      ) : null}
      {readings.length === 0 ? <p className="px-5 py-5 text-[14px] text-text-2 sm:px-6">{t("none")}</p> : <HomeReadingsTable readings={readings} timeZone={timeZone} caption={t("title")} />}
    </Card>
  );
}

export const CHECKIN_TONE = { WORSE: "danger", SAME: "warning", BETTER: "success" } as const;
