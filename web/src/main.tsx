import React, { lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import App from './App';
import NotFound from './pages/NotFound';
import './styles.css';

// Route-level code splitting: the MapLibre map (the heaviest dependency) lives only
// in the LiveMapPage chunk, so Find/Flight/Watch never download it.
const LiveMapPage = lazy(() => import('./pages/LiveMapPage'));
const FindPage = lazy(() => import('./pages/FindPage'));
const FlightPage = lazy(() => import('./pages/FlightPage'));
const WatchPage = lazy(() => import('./pages/WatchPage'));

const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <LiveMapPage /> },
      { path: 'find', element: <FindPage /> },
      { path: 'flight', element: <FlightPage /> },
      { path: 'flight/:flt', element: <FlightPage /> },
      { path: 'watch', element: <WatchPage /> },
      { path: '*', element: <NotFound /> },
    ],
  },
]);

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(
    <React.StrictMode>
      <RouterProvider router={router} />
    </React.StrictMode>,
  );
}
