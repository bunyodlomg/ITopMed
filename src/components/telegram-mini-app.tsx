"use client";

import { Phone, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, buttonClass } from "./ui/primitives";

/**
 * Inside Telegram (the central bot's Mini App). Telegram puts the signed launch
 * data in the URL fragment (#tgWebAppData=…); it is sent to our server, which
 * verifies it and decides where this person belongs. No Telegram script is
 * loaded: the two events needed are posted the way Telegram documents them.
 */

type Choice = { key: string; kind: "patient"; clinic: string | null };
type State =
  | { s: "loading" }
  | { s: "outside" }
  | { s: "choose"; choices: Choice[] }
  | { s: "patient"; phoneKnown: boolean; waiting: boolean }
  | { s: "error"; reason: string };

const STORE = "itm_tg_init";

function readInitData(): string | null {
  const fromHash = new URLSearchParams(window.location.hash.slice(1)).get("tgWebAppData");
  try {
    if (fromHash) sessionStorage.setItem(STORE, fromHash);
    return fromHash ?? sessionStorage.getItem(STORE);
  } catch {
    return fromHash;
  }
}

/** https://core.telegram.org/api/web-events — mobile/desktop apps expose a proxy; Telegram Web listens for postMessage. */
function postEvent(eventType: string, eventData: Record<string, unknown> = {}) {
  const w = window as unknown as { TelegramWebviewProxy?: { postEvent: (t: string, d: string) => void } };
  if (w.TelegramWebviewProxy) w.TelegramWebviewProxy.postEvent(eventType, JSON.stringify(eventData));
  else if (window.parent !== window) window.parent.postMessage(JSON.stringify({ eventType, eventData }), "https://web.telegram.org");
}

/** Portal pages a bot button may open directly after sign-in (anything else: the portal home). */
const NEXT_PAGES = new Set(["medicines", "readings"]);

export function TelegramMiniApp({ slug, next }: { slug?: string; next?: string }) {
  const t = useTranslations("telegramApp");
  const [state, setState] = useState<State>({ s: "loading" });
  const initData = useRef<string | null>(null);
  const polls = useRef(0);

  const resolve = useCallback(async (choice: string | null = null): Promise<State | null> => {
    const res = await fetch("/auth/telegram/webapp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ initData: initData.current, choice, slug }),
      cache: "no-store",
    }).catch(() => null);
    const r = (await res?.json().catch(() => null)) as
      | { status: "signed_in"; go: string }
      | { status: "choose"; choices: Choice[] }
      | { status: "patient"; phoneKnown: boolean }
      | { status: "error"; reason: string }
      | null;
    if (!r) return { s: "error", reason: "network" };
    if (r.status === "signed_in") {
      // Only a patient portal address gets a page appended, and only an allowed one.
      window.location.replace(next && NEXT_PAGES.has(next) && /^\/p\/[a-z0-9-]+$/.test(r.go) ? `${r.go}/${next}` : r.go);
      return null;
    }
    if (r.status === "choose") return { s: "choose", choices: r.choices };
    if (r.status === "patient") return { s: "patient", phoneKnown: r.phoneKnown, waiting: false };
    return { s: "error", reason: r.reason };
  }, [slug, next]);

  useEffect(() => {
    initData.current = readInitData();
    if (!initData.current) {
      setState({ s: "outside" });
      return;
    }
    postEvent("web_app_ready");
    postEvent("web_app_expand");
    void resolve().then((next) => next && setState(next));
  }, [resolve]);

  // After "Share my number": Telegram sends the contact to the bot; check again for a while.
  useEffect(() => {
    if (state.s !== "patient" || !state.waiting) return;
    const id = window.setInterval(async () => {
      polls.current += 1;
      const next = await resolve();
      if (!next) return;
      if (next.s !== "patient" || next.phoneKnown || polls.current >= 20) {
        window.clearInterval(id);
        setState(next.s === "patient" ? { ...next, waiting: false } : next);
      }
    }, 2500);
    return () => window.clearInterval(id);
  }, [state, resolve]);

  const sharePhone = () => {
    polls.current = 0;
    postEvent("web_app_request_phone");
    setState({ s: "patient", phoneKnown: false, waiting: true });
  };

  if (state.s === "loading") return <p className="text-center text-[15px] text-text-2" role="status">{t("loading")}</p>;

  if (state.s === "outside")
    return (
      <div className="space-y-4">
        <Alert tone="neutral">{t("outside")}</Alert>
        <Link href="/login" className={buttonClass("primary", "md", "w-full")}>
          {t("openWebsite")}
        </Link>
      </div>
    );

  if (state.s === "choose")
    return (
      <div className="space-y-3">
        <p className="text-[15px] text-text-2">{t("chooseIntro")}</p>
        {state.choices.map((c) => (
          <button
            key={c.key}
            type="button"
            className={buttonClass("secondary", "lg", "w-full")}
            onClick={() => {
              setState({ s: "loading" });
              void resolve(c.key).then((next) => next && setState(next));
            }}
          >
            {t("asPatient", { clinic: c.clinic ?? "" })}
          </button>
        ))}
      </div>
    );

  if (state.s === "patient")
    return state.phoneKnown ? (
      <div className="space-y-4">
        <Alert tone="neutral">{t("notFound")}</Alert>
        <p className="text-[14px] leading-relaxed text-text-2">{t("notFoundHint")}</p>
      </div>
    ) : (
      <div className="space-y-4">
        <p className="text-[15px] leading-relaxed text-text-2">{t("shareIntro")}</p>
        <button type="button" onClick={sharePhone} disabled={state.waiting} className={buttonClass("primary", "lg", "w-full")}>
          <Phone aria-hidden className="size-4" />
          {state.waiting ? t("waiting") : t("share")}
        </button>
        <p className="text-[13px] leading-relaxed text-text-3">{t("sharePrivacy")}</p>
      </div>
    );

  return (
    <div className="space-y-4">
      <Alert tone="warning">{t(state.reason === "disabled" ? "disabled" : state.reason === "locked" ? "locked" : "error")}</Alert>
      <button
        type="button"
        className={buttonClass("secondary", "md", "w-full")}
        onClick={() => {
          setState({ s: "loading" });
          void resolve().then((next) => next && setState(next));
        }}
      >
        <RefreshCw aria-hidden className="size-4" />
        {t("retry")}
      </button>
    </div>
  );
}
