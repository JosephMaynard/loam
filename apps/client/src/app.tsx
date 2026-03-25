import loamLogo from './assets/loam.svg'
import "./app.css";

export function App() {
  return (
    <>
      <div className="h-full">
        <header className="p-4 flex justify-between gap-4">
          <img src={loamLogo} className="size-12" alt="LOAM Logo" />
          <button class="ml-auto">
            Notifiactions
          </button>
          <button>
            Menu
          </button>
        </header>
      </div>
    </>
  );
}
