"use client";

import { useTranslations } from "next-intl";
import { usePathname } from "next/navigation";
import { shapeOf, type PageShape as Shape } from "@/lib/page-shape";
import { Skeleton } from "../ui/primitives";

function Title({ action }: { action?: boolean }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4 sm:mb-8">
      <div className="min-w-0 flex-1 space-y-3">
        <Skeleton className="h-9 w-[min(18rem,70%)] sm:h-10" />
        <Skeleton className="h-3.5 w-[min(28rem,90%)]" />
      </div>
      {action ? <Skeleton className="h-11 w-40 rounded-full" /> : null}
    </div>
  );
}

const panel = "rounded-[var(--radius-card)] bg-surface p-5 shadow-card sm:p-6";

function Rows({ count = 6 }: { count?: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="flex items-center gap-4">
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-3.5 w-[min(14rem,60%)]" />
            <Skeleton className="h-2.5 w-20" />
          </div>
          <Skeleton className="hidden h-3.5 w-24 sm:block" />
          <Skeleton className="h-3.5 w-16" />
        </div>
      ))}
    </div>
  );
}

function Figures() {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="rounded-[var(--radius-card)] bg-surface p-4 shadow-card sm:p-5">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="mt-4 h-7 w-24" />
        </div>
      ))}
    </div>
  );
}

function SkeletonBody({ shape }: { shape: Shape }) {
  switch (shape) {
    case "dashboard":
      return (
        <>
          <Title action />
          <Figures />
          <div className={`mt-4 ${panel}`}>
            <Skeleton className="h-4 w-36" />
            <Skeleton className="mt-6 h-40 w-full" />
          </div>
        </>
      );
    case "report":
      return (
        <>
          <Title />
          <div className="mb-4 flex gap-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-9 w-24 rounded-full" />
            ))}
          </div>
          <Figures />
          <div className={`mt-4 ${panel}`}>
            <Rows count={5} />
          </div>
        </>
      );
    case "detail":
      return (
        <>
          <Title action />
          <div className="grid gap-4 xl:grid-cols-3">
            <div className={`${panel} xl:col-span-2`}>
              <Skeleton className="h-4 w-40" />
              <div className="mt-6 grid gap-5 sm:grid-cols-2">
                {[0, 1, 2, 3, 4, 5].map((i) => (
                  <div key={i} className="space-y-2">
                    <Skeleton className="h-2.5 w-20" />
                    <Skeleton className="h-4 w-[70%]" />
                  </div>
                ))}
              </div>
            </div>
            <div className={panel}>
              <Skeleton className="h-4 w-28" />
              <div className="mt-6">
                <Rows count={3} />
              </div>
            </div>
          </div>
        </>
      );
    case "form":
      return (
        <>
          <Title />
          <div className={`max-w-3xl ${panel}`}>
            <Skeleton className="h-4 w-40" />
            <div className="mt-6 grid gap-5 sm:grid-cols-2">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="space-y-2">
                  <Skeleton className="h-3 w-24" />
                  <Skeleton className="h-11 w-full rounded-[var(--radius-control)]" />
                </div>
              ))}
            </div>
            <Skeleton className="ml-auto mt-6 h-11 w-36 rounded-full" />
          </div>
        </>
      );
    default:
      return (
        <>
          <Title action />
          <Skeleton className="mb-3 h-12 w-full rounded-full" />
          <div className="mb-4 flex gap-1.5">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-9 w-20 rounded-full" />
            ))}
          </div>
          <div className={panel}>
            <Rows />
          </div>
        </>
      );
  }
}

/**
 * Placeholder while a page renders on the server, shaped like the page being
 * opened (list, record, form, report, dashboard) so nothing jumps when the
 * content arrives. It fades in only after a short pause: fast pages never flash it.
 */
export function PageSkeleton() {
  const t = useTranslations("a11y");
  const shape = shapeOf(usePathname());
  return (
    <div role="status" aria-live="polite" className="skeleton-page" data-shape={shape}>
      <span className="sr-only">{t("loading")}</span>
      <SkeletonBody shape={shape} />
    </div>
  );
}
