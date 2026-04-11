import loamMark from "./assets/loam.svg";

export function App() {
  return (
    <main className="relative isolate min-h-screen overflow-hidden px-5 py-6 md:px-10 md:py-8">
      <div className="noise-overlay" />
      <div className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-5xl items-center justify-center">
        <section className="grid w-full gap-8 rounded-[2.4rem] border border-black/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.76),rgba(246,237,223,0.86))] p-8 shadow-[0_24px_60px_rgba(92,60,28,0.12)] backdrop-blur-md md:grid-cols-[160px_minmax(0,1fr)] md:p-10">
          <div className="flex items-center justify-center">
            <img src={loamMark} alt="LOAM mark" className="size-28 rounded-[2rem] shadow-[0_18px_40px_rgba(209,73,0,0.18)]" />
          </div>
          <div className="flex flex-col gap-6">
            <div>
              <p className="mb-3 text-[11px] tracking-[0.3em] uppercase text-black/55">LOAM Client</p>
              <h1 className="max-w-2xl text-4xl leading-none tracking-[-0.04em] md:text-6xl">
                The app shell is clear again. The avatar sandbox now lives with the package.
              </h1>
            </div>
            <p className="max-w-2xl text-base leading-7 text-black/68">
              This app can now move on to real product work without carrying the avatar playground in its main route.
              The demo still exists and is runnable from the avatar package.
            </p>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="rounded-[1.6rem] border border-black/10 bg-white/60 p-5">
                <p className="text-[11px] tracking-[0.24em] uppercase text-black/45">Avatar Demo</p>
                <p className="mt-2 text-sm leading-6 text-black/68">
                  Run <code className="rounded bg-black/6 px-1.5 py-0.5 text-[0.95em]">pnpm --filter @loam/avatar demo</code>
                  to open the package-owned sandbox.
                </p>
              </div>
              <div className="rounded-[1.6rem] border border-black/10 bg-white/60 p-5">
                <p className="text-[11px] tracking-[0.24em] uppercase text-black/45">Current Direction</p>
                <p className="mt-2 text-sm leading-6 text-black/68">
                  The client app is now free to become the actual LOAM PWA while avatars and display-name tooling stay reusable.
                </p>
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
