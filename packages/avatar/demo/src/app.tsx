import { useMemo, useState } from "preact/hooks";

import { generateAvatar, getAvatarColors, getAvatarCounts } from "./avatar";
import { generateDisplayName } from "./display-name";
import type { AvatarMode } from "./avatar";

const EXAMPLES = [
  "Qm9yZWFsLXVzZXItMDE=",
  "c2F0dXJuLmJhc2U2NA==",
  "d2F2ZS1jb3JlLTAyNA==",
  "bW9zcy1sYWtlLXV1aWQ=",
  "ZW1iZXItd3Jlbi0xNw==",
];
const FACE_SURFACE = "#f7f2eb";
const DARK_SURFACE = "#171a20";

interface AvatarProps {
  id: string;
  className?: string;
  mode?: AvatarMode;
  label?: string;
}

function Avatar({ id, className, mode = "face", label }: AvatarProps) {
  const avatar = useMemo(() => generateAvatar(id, { mode, label }), [id, label, mode]);
  const wrapperClassName = [
    "inline-grid aspect-square shrink-0 overflow-hidden rounded-[28%] ring-1 ring-black/8 [&>svg]:block [&>svg]:size-full",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <span
      aria-hidden="true"
      className={wrapperClassName}
      dangerouslySetInnerHTML={{ __html: avatar.html }}
    />
  );
}

function ModeButton({
  current,
  label,
  onClick,
  value,
}: {
  current: AvatarMode;
  label: string;
  onClick: (mode: AvatarMode) => void;
  value: AvatarMode;
}) {
  const selected = current === value;

  return (
    <button
      type="button"
      onClick={() => onClick(value)}
      className={[
        "rounded-full border px-4 py-2 text-xs tracking-[0.26em] uppercase transition",
        selected
          ? "border-black/75 bg-black text-[#fbf6ee]"
          : "border-black/10 bg-white/50 text-black/70 hover:border-black/25 hover:bg-white/80",
      ].join(" ")}
    >
      {label}
    </button>
  );
}

export function App() {
  const [value, setValue] = useState("Qm9yZWFsLXVzZXItMDE=");
  const [mode, setMode] = useState<AvatarMode>("face");
  const colors = useMemo(() => getAvatarColors(value), [value]);
  const displayName = useMemo(() => generateDisplayName(value), [value]);
  const counts = getAvatarCounts();

  return (
    <main className="relative isolate min-h-screen overflow-hidden px-5 py-6 md:px-10 md:py-8">
      <div className="noise-overlay" />
      <div className="mx-auto flex max-w-6xl flex-col gap-8">
        <header className="flex flex-col gap-5 border-b border-black/10 pb-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-2xl">
            <p className="mb-3 text-[11px] tracking-[0.3em] uppercase text-black/55">
              Avatar Package Demo
            </p>
            <h1 className="max-w-xl text-4xl leading-none tracking-[-0.04em] md:text-6xl">
              Deterministic avatars and display names from one stable id.
            </h1>
          </div>
          <div className="grid gap-2 text-sm text-black/65 md:grid-cols-2">
            <div className="rounded-3xl border border-black/10 bg-white/55 px-4 py-3 backdrop-blur-sm">
              <p className="text-[11px] tracking-[0.22em] uppercase text-black/45">SVG Catalog</p>
              <p className="mt-1">
                {counts.mouths} mouths, {counts.eyes} eyes, {counts.eyebrows} brows, {counts.noses} noses
              </p>
            </div>
            <div className="rounded-3xl border border-black/10 bg-white/55 px-4 py-3 backdrop-blur-sm">
              <p className="text-[11px] tracking-[0.22em] uppercase text-black/45">Palette Output</p>
              <div className="mt-2 flex gap-2">
                {[colors.bg, colors.shade, colors.accent, colors.tertiary].map((color) => (
                  <span
                    key={color}
                    className="h-9 flex-1 rounded-full ring-1 ring-black/10"
                    style={{ backgroundColor: color }}
                    title={color}
                  />
                ))}
              </div>
            </div>
          </div>
        </header>

        <section className="grid gap-6 lg:grid-cols-[minmax(0,1.25fr)_minmax(320px,0.75fr)]">
          <div className="rounded-[2rem] border border-black/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.68),rgba(248,239,226,0.82))] p-6 shadow-[0_24px_60px_rgba(92,60,28,0.12)] backdrop-blur-md">
            <div className="grid gap-8 xl:grid-cols-[220px_minmax(0,1fr)] xl:items-center">
              <div className="mx-auto flex w-full max-w-[220px] flex-col items-center gap-4">
                <div className="relative w-full rounded-[2rem] border border-black/10 bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.9),rgba(244,230,212,0.9))] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)]">
                  <Avatar id={value} label={displayName} mode={mode} className="w-full" />
                </div>
                <div className="flex flex-wrap justify-center gap-2">
                  <ModeButton current={mode} value="face" label="Face" onClick={setMode} />
                  <ModeButton current={mode} value="initial" label="Initial" onClick={setMode} />
                  <ModeButton current={mode} value="pattern" label="Pattern" onClick={setMode} />
                </div>
              </div>

              <div className="flex flex-col gap-6">
                <div>
                  <p className="text-[11px] tracking-[0.3em] uppercase text-black/45">Seed String</p>
                  <input
                    value={value}
                    onInput={(event) => setValue(event.currentTarget.value)}
                    className="mt-3 w-full rounded-[1.4rem] border border-black/10 bg-white/85 px-5 py-4 text-lg outline-none transition placeholder:text-black/30 focus:border-black/35 focus:bg-white"
                    placeholder="type any uuid or base64 id"
                  />
                  <p className="mt-3 text-sm text-black/55">
                    Generated display name: <span className="font-medium text-black/75">{displayName}</span>
                  </p>
                </div>

                <div className="grid gap-3">
                  <p className="text-[11px] tracking-[0.3em] uppercase text-black/45">Quick Seeds</p>
                  <div className="flex flex-wrap gap-2">
                    {EXAMPLES.map((example) => (
                      <button
                        key={example}
                        type="button"
                        onClick={() => setValue(example)}
                        className="rounded-full border border-black/10 bg-white/60 px-4 py-2 text-sm text-black/70 transition hover:border-black/20 hover:bg-white/90"
                      >
                        {example}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <div
                    className="rounded-[1.6rem] border border-black/10 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.75)]"
                    style={{ backgroundColor: FACE_SURFACE }}
                  >
                    <p className="text-[11px] tracking-[0.26em] uppercase text-black/45">Light Surface</p>
                    <div className="mt-4 flex items-center gap-3">
                      <Avatar id={value} label={displayName} mode={mode} className="size-14" />
                      <div>
                        <p className="text-xs uppercase tracking-[0.22em] text-black/35">username</p>
                        <p className="text-xl" style={{ color: colors.lightMode }}>
                          {displayName}
                        </p>
                      </div>
                    </div>
                  </div>

                  <div
                    className="rounded-[1.6rem] border border-black/10 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]"
                    style={{ backgroundColor: DARK_SURFACE }}
                  >
                    <p className="text-[11px] tracking-[0.26em] uppercase text-white/45">Dark Surface</p>
                    <div className="mt-4 flex items-center gap-3">
                      <Avatar id={value} label={displayName} mode={mode} className="size-14" />
                      <div>
                        <p className="text-xs uppercase tracking-[0.22em] text-white/35">username</p>
                        <p className="text-xl" style={{ color: colors.darkMode }}>
                          {displayName}
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <aside className="grid gap-5">
            <div className="rounded-[2rem] border border-black/10 bg-black/[0.03] p-5">
              <p className="text-[11px] tracking-[0.28em] uppercase text-black/45">What This Ships</p>
              <ul className="mt-4 space-y-3 text-sm leading-6 text-black/68">
                <li>Parses the SVG template once and caches direct-child counts for every facial feature.</li>
                <li>Generates deterministic face variants with one active mouth, eye, brow and nose per id.</li>
                <li>Supports initial and mirrored pattern modes using the same seeded colour system.</li>
              </ul>
            </div>

            <div className="rounded-[2rem] border border-black/10 bg-white/55 p-5 backdrop-blur-sm">
              <p className="text-[11px] tracking-[0.28em] uppercase text-black/45">Current Seed</p>
              <dl className="mt-4 grid gap-3 text-sm text-black/70">
                <div className="flex items-center justify-between gap-4 border-b border-black/8 pb-3">
                  <dt>Mode</dt>
                  <dd className="uppercase tracking-[0.2em]">{mode}</dd>
                </div>
                <div className="flex items-center justify-between gap-4 border-b border-black/8 pb-3">
                  <dt>Avatar Background</dt>
                  <dd>{colors.bg}</dd>
                </div>
                <div className="flex items-center justify-between gap-4 border-b border-black/8 pb-3">
                  <dt>Display Name</dt>
                  <dd>{displayName}</dd>
                </div>
                <div className="flex items-center justify-between gap-4 border-b border-black/8 pb-3">
                  <dt>Light Username</dt>
                  <dd>{colors.lightMode}</dd>
                </div>
                <div className="flex items-center justify-between gap-4 border-b border-black/8 pb-3">
                  <dt>Tertiary</dt>
                  <dd>{colors.tertiary}</dd>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <dt>Dark Username</dt>
                  <dd>{colors.darkMode}</dd>
                </div>
              </dl>
            </div>
          </aside>
        </section>
      </div>
    </main>
  );
}
