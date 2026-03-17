import { Link } from "@tanstack/react-router";
import { useOperatorApp } from "../lib/operator-app";

export function OperatorLayout(props: { children: React.ReactNode }) {
  const { apiTargetLabel, approvals, error, loading, notice, repositories, working } =
    useOperatorApp();

  return (
    <div className="page-shell">
      <div className="orb orb-coral"></div>
      <div className="orb orb-teal"></div>

      <header className="hero panel">
        <div>
          <p className="eyebrow">Pi Remote Control App</p>
          <h1>Repo intake, policy controls, and task routing now share one operator surface.</h1>
          <p className="lede">
            Phase 0 realigns the operator UI onto TanStack Start without disturbing the current
            server API. Repository import, policy controls, task routing, and approval resumes now
            live behind route-oriented pages instead of one entry file.
          </p>
        </div>

        <div className="hero-meta">
          <div>
            <p className="eyebrow">API target</p>
            <strong>{apiTargetLabel}</strong>
          </div>
          <div>
            <p className="eyebrow">Migration phase</p>
            <strong>Phase 0</strong>
          </div>
          <div>
            <p className="eyebrow">Live state</p>
            <strong>{working ?? (loading ? "Loading control plane..." : "Ready")}</strong>
          </div>
        </div>
      </header>

      <nav className="app-nav panel">
        <Link
          className="nav-link"
          activeProps={{ className: "nav-link nav-link-active" }}
          to="/repos"
        >
          <span>Repositories</span>
          <strong>{repositories.length}</strong>
        </Link>
        <Link
          className="nav-link"
          activeProps={{ className: "nav-link nav-link-active" }}
          to="/approvals"
        >
          <span>Approvals</span>
          <strong>{approvals.length}</strong>
        </Link>
      </nav>

      {notice || error ? (
        <section className={`banner ${error ? "banner-error" : "banner-notice"}`}>
          {error ?? notice}
        </section>
      ) : null}

      <main className="route-stack">{props.children}</main>
    </div>
  );
}
