import { initialMigration, schemaTables } from "db";
import { apiRouteCatalog, deliveryMilestones, workspacePackages } from "shared";
import "./style.css";

function renderPills(items: readonly string[]) {
  return items.map((item) => `<li>${item}</li>`).join("");
}

function renderWorkspace() {
  return workspacePackages
    .map(
      (entry) => `
        <article class="card workspace-card">
          <p class="eyebrow">${entry.kind}</p>
          <h3>${entry.path}</h3>
          <p>${entry.responsibility}</p>
        </article>
      `,
    )
    .join("");
}

function renderSchema() {
  return schemaTables
    .map(
      (table) => `
        <article class="card schema-card">
          <div class="card-header">
            <div>
              <p class="eyebrow">table</p>
              <h3>${table.name}</h3>
            </div>
            <span class="badge">${table.key_columns.length} fields</span>
          </div>
          <p>${table.purpose}</p>
          <ul class="pill-list">${renderPills(table.key_columns)}</ul>
        </article>
      `,
    )
    .join("");
}

function renderRoutes() {
  return apiRouteCatalog
    .map(
      (route) => `
        <tr>
          <td><span class="method method-${route.method.toLowerCase()}">${route.method}</span></td>
          <td><code>${route.path}</code></td>
          <td>${route.feature}</td>
        </tr>
      `,
    )
    .join("");
}

function renderMilestones() {
  return deliveryMilestones
    .map(
      (milestone) => `
        <article class="timeline-card">
          <p class="eyebrow">${milestone.id}</p>
          <h3>${milestone.title}</h3>
          <p>${milestone.summary}</p>
        </article>
      `,
    )
    .join("");
}

document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
  <div class="page-shell">
    <div class="aurora aurora-one"></div>
    <div class="aurora aurora-two"></div>

    <header class="hero">
      <div class="hero-copy">
        <p class="kicker">Pi Remote Control App</p>
        <h1>Control plane scaffold for repo registration, routing, approvals, and PR workflows.</h1>
        <p class="lede">
          The starter monorepo now mirrors the approved implementation plan with dedicated apps,
          backend modules, shared contracts, and the first SQLite migration.
        </p>
      </div>

      <div class="hero-panel card">
        <p class="eyebrow">first slice</p>
        <h2>What is scaffolded</h2>
        <ul class="checklist">
          <li>UI shell for operator workflows</li>
          <li>API module map for repos, tasks, and approvals</li>
          <li>Rules-first task router package</li>
          <li>Policy engine contract package</li>
          <li>SQLite schema migration <code>${initialMigration.id}</code></li>
        </ul>
      </div>
    </header>

    <main>
      <section class="section">
        <div class="section-heading">
          <p class="kicker">Workspace Layout</p>
          <h2>Monorepo packages are mapped to the product responsibilities in the plan.</h2>
        </div>
        <div class="card-grid workspace-grid">${renderWorkspace()}</div>
      </section>

      <section class="section">
        <div class="section-heading">
          <p class="kicker">SQLite Foundation</p>
          <h2>The initial schema covers the control-plane records the app needs before pi execution.</h2>
        </div>
        <div class="card-grid schema-grid">${renderSchema()}</div>
      </section>

      <section class="section split-section">
        <article class="card route-card">
          <div class="section-heading compact">
            <p class="kicker">API Outline</p>
            <h2>Routes already mapped from the implementation plan.</h2>
          </div>
          <table>
            <thead>
              <tr>
                <th>Method</th>
                <th>Path</th>
                <th>Purpose</th>
              </tr>
            </thead>
            <tbody>${renderRoutes()}</tbody>
          </table>
        </article>

        <article class="card milestone-card">
          <div class="section-heading compact">
            <p class="kicker">Delivery Order</p>
            <h2>Vertical slices stay aligned with the approved rollout.</h2>
          </div>
          <div class="timeline">${renderMilestones()}</div>
        </article>
      </section>
    </main>
  </div>
`;
