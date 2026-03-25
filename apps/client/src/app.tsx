import loamLogo from "./assets/loam.svg";

export function App() {
  return (
    <>
      <div className="h-full">
        <header className="p-4 flex justify-between gap-4">
          <img src={loamLogo} className="size-12" alt="LOAM Logo" />
          <button className="ml-auto">Notifications</button>
          <button>
            Menu
          </button>
        </header>
      </div>
    </>
  );
}
