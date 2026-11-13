import React from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import App from './App';
import LiveMapPage from './pages/LiveMapPage';
import FindPage from './pages/FindPage';
import FlightPage from './pages/FlightPage';
import WatchPage from './pages/WatchPage';
import NotFound from './pages/NotFound';
import './styles.css';

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
