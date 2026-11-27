"use client";

import { ArrowRight, Volume2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Board } from "@/server/queue/board";

interface Labels {
  title: string;
  now: string;
  waiting: string;
  number: string;
  cabinet: string;
  inVisit: string;
  empty: string;
  soundOn: string;
  soundHint: string;
  /** "{number}-raqam. {name}. {cabinet}ga kiring." */
  spoken: string;
  spokenNoCabinet: string;
  offline: string;
}

const POLL_MS = 4000;

/** A short two-tone chime (no audio file needed). */
function chime(ctx: AudioContext) {
  const now = ctx.currentTime;
  for (const [i, f] of [880, 660].entries()) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, now + i * 0.35);
    g.gain.exponentialRampToValueAtTime(0.35, now + i * 0.35 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.35 + 0.32);
    o.connect(g).connect(ctx.destination);
    o.start(now + i * 0.35);
    o.stop(now + i * 0.35 + 0.34);
  }
}

/**
 * Speaks the call with the best available voice: Uzbek, then Turkish (reads
 * Latin Uzbek closely), then Russian. Browsers ship different voices; where
 * none fits, the chime and the screen still work.
 */
function speak(text: string) {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  const voices = window.speechSynthesis.getVoices();
  const pick = ["uz", "tr", "ru"].map((l) => voices.find((v) => v.lang.toLowerCase().startsWith(l))).find(Boolean);
  const u = new SpeechSynthesisUtterance(text);
  if (pick) {
    u.voice = pick;
    u.lang = pick.lang;
  }
  u.rate = 0.9;
  window.speechSynthesis.speak(u);
}

const fill = (tpl: string, v: Record<string, string>) => tpl.replace(/\{(\w+)\}/g, (_, k: string) => v[k] ?? "");

export function WaitingRoomBoard({ token, initial, labels }: { token: string; initial: Board; labels: Labels }) {
  const [board, setBoard] = useState(initial);
  const [online, setOnline] = useState(true);
  const [sound, setSound] = useState(false);
  const audio = useRef<AudioContext | null>(null);
  // Calls already announced: "<id>:<count>" (a recall has a higher count and is announced again).
  const announced = useRef(new Set(initial.calls.map((c) => `${c.id}:${c.calls}`)));

  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const r = await fetch(`/api/tv/${token}`, { cache: "no-store" });
        if (!r.ok) throw new Error(String(r.status));
        const next = (await r.json()) as Board;
        if (stop) return;
        setOnline(true);
        setBoard(next);
        const fresh = next.calls.filter((c) => c.state === "called" && !announced.current.has(`${c.id}:${c.calls}`));
        for (const c of fresh) announced.current.add(`${c.id}:${c.calls}`);
        if (fresh.length && sound && next.voice && audio.current) {
          chime(audio.current);
          for (const c of fresh.reverse()) {
            const v = { number: String(c.number ?? ""), name: c.spoken, cabinet: c.cabinet ?? "" };
            window.setTimeout(() => speak(fill(c.cabinet ? labels.spoken : labels.spokenNoCabinet, v)), 800);
          }
        }
      } catch {
        if (!stop) setOnline(false);
      }
    };
    const id = window.setInterval(tick, POLL_MS);
    return () => {
      stop = true;
      window.clearInterval(id);
    };
  }, [token, sound, labels.spoken, labels.spokenNoCabinet]);

  const enableSound = () => {
    audio.current = audio.current ?? new AudioContext();
    void audio.current.resume();
    chime(audio.current);
    window.speechSynthesis?.getVoices();
    setSound(true);
  };

  const [latest, ...earlier] = board.calls;
  return (
    // "Yumshoq" board: soft ground, the current call on the ink panel, the queue on white cards.
    // Colours come from the theme tokens, so a TV set to dark mode gets the dark palette.
    <main className="min-h-dvh bg-sunken p-5 text-text md:p-8">
      <header className="mb-5 flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-4">
          <span aria-hidden className="grid size-14 shrink-0 place-items-center rounded-[18px] bg-accent-solid text-on-accent">
            <svg viewBox="0 0 24 24" className="size-7" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </span>
          <div className="min-w-0">
            <h1 className="text-balance text-[30px] font-extrabold leading-tight tracking-[-0.02em] md:text-[40px]">{labels.title}</h1>
            <p className="text-[18px] text-text-2 md:text-[20px]">
              {board.clinic} · {board.branch}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {!online ? <span className="rounded-full bg-danger-solid px-5 py-2.5 text-[18px] font-bold text-white">{labels.offline}</span> : null}
          {board.voice && !sound ? (
            <button type="button" onClick={enableSound} className="inline-flex min-h-14 items-center gap-3 rounded-full bg-accent-solid px-6 text-[20px] font-bold text-on-accent" title={labels.soundHint}>
              <Volume2 aria-hidden className="size-6" />
              {labels.soundOn}
            </button>
          ) : null}
        </div>
      </header>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <section aria-live="polite" aria-label={labels.now} className="flex flex-col rounded-[32px] bg-accent-solid p-7 text-on-accent md:p-10">
          <p className="text-[22px] font-semibold opacity-80 md:text-[26px]">{labels.now}</p>
          {latest ? (
            <>
              <div className="mt-4 flex flex-wrap items-baseline gap-x-8 gap-y-2">
                <span className="text-[120px] font-extrabold leading-[0.95] tracking-[-0.05em] tabular-nums md:text-[180px]">{latest.number ?? "—"}</span>
                <span className="min-w-0 break-words text-[40px] font-bold md:text-[52px]">{latest.name}</span>
              </div>
              <div className="mt-auto flex flex-wrap items-center gap-4 pt-6">
                <ArrowRight aria-hidden className="size-12 shrink-0" />
                <span className="text-[40px] font-extrabold leading-tight md:text-[56px]">{latest.cabinet ? `${labels.cabinet}: ${latest.cabinet}` : latest.doctor}</span>
                {latest.state === "inVisit" ? <span className="rounded-full border-2 border-current px-4 py-1 text-[22px] font-semibold">{labels.inVisit}</span> : null}
              </div>
            </>
          ) : (
            <p className="mt-4 text-[30px] opacity-80">{labels.empty}</p>
          )}
        </section>

        <div className="flex min-w-0 flex-col gap-5">
          {earlier.length ? (
            <section aria-label={labels.number} className="rounded-[32px] bg-surface-2 p-5 md:p-6">
              <ul className="space-y-3">
                {earlier.map((c) => (
                  <li key={c.id} className="flex items-center gap-4 rounded-[22px] bg-surface px-5 py-4">
                    <span className="text-[44px] font-extrabold leading-none tracking-[-0.03em] tabular-nums">{c.number ?? "—"}</span>
                    <span className="min-w-0 flex-1 break-words text-[22px] text-text-2">{c.name}</span>
                    <span className="text-[24px] font-bold">{c.state === "inVisit" ? labels.inVisit : (c.cabinet ?? "")}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <section aria-label={labels.waiting} className="flex-1 rounded-[32px] bg-surface-2 p-5 md:p-6">
            <p className="mb-4 px-1 text-[22px] font-bold text-text-2">{labels.waiting}</p>
            {board.waiting.length ? (
              <ul className="grid grid-cols-3 gap-3">
                {board.waiting.map((w, i) => (
                  <li key={`${w.number}-${i}`} className="rounded-[20px] bg-surface py-4 text-center tabular-nums">
                    <span className="block text-[40px] font-extrabold leading-none tracking-[-0.03em]">{w.number ?? "—"}</span>
                    {w.eta ? <span className="mt-1 block text-[18px] font-semibold text-text-2">≈ {w.eta}</span> : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-1 text-[24px] text-text-2">—</p>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}
