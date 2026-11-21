import {
  Network, Pill,
  ConciergeBell, BadgeCheck, Cable, Package, Activity, BarChart3, Building2, FlaskConical, HeartPulse, Receipt, TrendingDown, Wallet, CalendarDays, CalendarPlus, ClipboardList, Contact, ListOrdered, DoorOpen, KeyRound, LifeBuoy, Stethoscope, UserRound, GitBranch, LayoutDashboard, ScrollText, Settings, ShieldCheck, Users } from "lucide-react";

/** Icons are referenced by name so server components can pass them to client nav. */
const ICONS = {
  dashboard: LayoutDashboard,
  clinics: Building2,
  staff: Users,
  audit: ScrollText,
  settings: Settings,
  branches: GitBranch,
  shield: ShieldCheck,
  activity: Activity,
  roles: KeyRound,
  support: LifeBuoy,
  calendar: CalendarDays,
  doctors: UserRound,
  services: Stethoscope,
  facilities: DoorOpen,
  patients: Contact,
  booking: CalendarPlus,
  queue: ListOrdered,
  visits: ClipboardList,
  billing: Receipt,
  cash: Wallet,
  reports: BarChart3,
  expenses: TrendingDown,
  lab: FlaskConical,
  nurse: HeartPulse,
  inventory: Package,
  hr: BadgeCheck,
  integrations: Cable,
  networks: Network,
  desk: ConciergeBell,
  pill: Pill,
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name, className }: { name: IconName; className?: string }) {
  const C = ICONS[name];
  return <C aria-hidden className={className} strokeWidth={1.75} />;
}
