/**
 * Printed document text with light, safe formatting (no HTML from users):
 *  - "# Title" lines are centred headings;
 *  - "Label: text" lines show the label in bold ("Tashxis:", "Bemor:") when the
 *    label is short and has no digits;
 *  - "1. ..." lines are a numbered list with a hanging indent;
 *  - "!! ..." lines are highlighted like a marker pen (lab tests the patient
 *    still has to take — doctors colour them so patients do not skip them);
 *  - empty lines are paragraph breaks.
 */
export function DocumentText({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <div className="space-y-1 [overflow-wrap:anywhere]">
      {lines.map((line, i) => {
        if (!line.trim()) return <div key={i} className="h-2" aria-hidden />;
        if (line.startsWith("!! ")) {
          return (
            <p key={i} data-highlight className="border-l-4 border-warning bg-warning-soft px-2 py-0.5 font-semibold [print-color-adjust:exact] [-webkit-print-color-adjust:exact]">
              {line.slice(3)}
            </p>
          );
        }
        if (line.startsWith("# ")) return <p key={i} className="pt-1 text-center text-[17px] font-bold uppercase tracking-[0.03em]">{line.slice(2)}</p>;
        const numbered = /^(\d{1,2})[.)]\s+(.*)$/.exec(line);
        if (numbered) {
          return (
            <p key={i} className="grid grid-cols-[1.6em_1fr] pl-2">
              <span>{numbered[1]}.</span>
              <span>{numbered[2]}</span>
            </p>
          );
        }
        const label = /^([^:\d\n]{2,40}):(.*)$/.exec(line);
        if (label) {
          return (
            <p key={i} className="whitespace-pre-wrap">
              <strong className="font-semibold">{label[1]}:</strong>
              {label[2]}
            </p>
          );
        }
        return (
          <p key={i} className="whitespace-pre-wrap">
            {line}
          </p>
        );
      })}
    </div>
  );
}
