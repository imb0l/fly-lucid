import { NavLink, Outlet } from 'react-router-dom';

const navClass = ({ isActive }: { isActive: boolean }): string => (isActive ? 'nav-link active' : 'nav-link');

export default function App() {
  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark">✈</span>
          <span className="brand-name">Fly-Lucid</span>
          <span className="brand-tag">Actual departures, not schedules</span>
        </div>
        <nav className="app-nav" aria-label="Main">
          <NavLink to="/" end className={navClass}>
            Live map
          </NavLink>
          <NavLink to="/find" className={navClass}>
            Find a flight
          </NavLink>
          <NavLink to="/flight" className={navClass}>
            Flight history
          </NavLink>
          <NavLink to="/watch" className={navClass}>
            Watchlist
          </NavLink>
        </nav>
      </header>
      <main className="app-main">
        <Outlet />
      </main>
      <footer className="app-footer">
        Positions come from a public ADS-B feed. All times WAT (UTC+1). Forecasts are built from observed takeoffs
        only.
      </footer>
    </div>
  );
}
