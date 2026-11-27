import type { ReactNode } from "react";

/** A numbered section heading of a printed paper ("1. SHIKOYATLAR"). */
export function PaperHeading({ no, children }: { no: number; children: ReactNode }) {
  return (
    <h2 className="mb-1.5 border-b-2 border-text pb-0.5 text-[14.5px] font-bold uppercase tracking-[0.03em]">
      {no}. {children}
    </h2>
  );
}

/** Free text of a paper, line breaks kept. */
export function PaperText({ text }: { text: string | null | undefined }) {
  return <p className="whitespace-pre-wrap text-pretty">{(text ?? "").trim()}</p>;
}
