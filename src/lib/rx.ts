/**
 * How a prescribed medicine is shown everywhere (screen, printed prescription,
 * visit summary, export): trade name with the international non-proprietary
 * name in brackets — "Trombonet 75 mg (klopidogrel)" — so the pharmacy can
 * dispense an equivalent when that brand is out of stock. The INN is left out
 * when the doctor already wrote it into the name.
 */
export function rxDrugLabel(p: { drug: string; inn?: string | null }): string {
  const inn = p.inn?.trim();
  if (!inn) return p.drug;
  if (p.drug.toLocaleLowerCase().includes(inn.toLocaleLowerCase())) return p.drug;
  return `${p.drug} (${inn})`;
}
