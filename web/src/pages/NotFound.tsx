import { Link } from 'react-router-dom';

export default function NotFound() {
  return (
    <section className="page">
      <h1>Page not found</h1>
      <p className="muted">
        That route does not exist. Try the <Link to="/">live map</Link> or <Link to="/find">a forecast</Link>.
      </p>
    </section>
  );
}
