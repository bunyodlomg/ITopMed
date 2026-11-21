import type { Letterhead as Data } from "@/server/clinic/branding";

/**
 * Clinic letterhead on printed pages: logo, name, licence line, address and
 * phone, and the map QR code when the clinic set a location link. `compact`
 * is for narrow receipt and ticket printers (58/80 mm).
 */
export function Letterhead({ data, compact = false, locationLabel }: { data: Data; compact?: boolean; locationLabel?: string }) {
  const name = data.legalName ?? data.name;
  if (compact) {
    return (
      <header className="border-b border-dashed border-border pb-2 text-center">
        {data.logo ? (
          // eslint-disable-next-line @next/next/no-img-element -- inline data URL uploaded by the clinic
          <img src={data.logo} alt="" className="mx-auto mb-1 max-h-12 w-auto" />
        ) : null}
        <p className="text-[15px] font-semibold leading-tight">{name}</p>
        {data.address ? <p className="text-[11px] leading-snug text-text-2">{data.address}</p> : null}
        {data.phone ? <p className="text-[11px] text-text-2">{data.phone}</p> : null}
      </header>
    );
  }
  return (
    <header className="flex items-center gap-4 border-b-2 border-accent pb-3">
      {data.logo ? (
        // eslint-disable-next-line @next/next/no-img-element -- inline data URL uploaded by the clinic
        <img src={data.logo} alt="" className="max-h-20 w-auto max-w-[30%] shrink-0 object-contain" />
      ) : null}
      <div className="min-w-0 flex-1 text-center">
        <p className="text-[19px] font-bold uppercase leading-tight tracking-[0.02em] text-accent">{name}</p>
        {data.license ? <p className="mt-0.5 text-[11.5px] leading-snug text-text-2">{data.license}</p> : null}
        {data.address ? <p className="text-[11.5px] leading-snug text-text-2">{data.address}</p> : null}
        {data.phone ? <p className="text-[11.5px] text-text-2">{data.phone}</p> : null}
      </div>
      {data.locationQr ? (
        <figure className="shrink-0 text-center">
          {/* eslint-disable-next-line @next/next/no-img-element -- QR code generated on the server */}
          <img src={data.locationQr} alt={locationLabel ?? ""} width={64} height={64} className="mx-auto" />
          {locationLabel ? <figcaption className="text-[10px] text-text-2">{locationLabel}</figcaption> : null}
        </figure>
      ) : null}
    </header>
  );
}
