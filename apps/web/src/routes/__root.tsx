import { HeadContent, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";
import appCssHref from "../style.css?url";
import { OperatorLayout } from "../components/operator-layout";
import { OperatorAppProvider } from "../lib/operator-app";

export const Route = createRootRoute({
  component: RootComponent,
  head: () => ({
    links: [{ href: appCssHref, rel: "stylesheet" }],
    meta: [
      {
        charSet: "utf-8",
      },
      {
        content: "width=device-width, initial-scale=1",
        name: "viewport",
      },
      {
        title: "Pi Remote Control App",
      },
    ],
  }),
  notFoundComponent: () => (
    <div className="panel">
      <p className="eyebrow">Route Missing</p>
      <h2>This operator route does not exist.</h2>
    </div>
  ),
});

function RootComponent() {
  return (
    <RootDocument>
      <OperatorAppProvider>
        <OperatorLayout>
          <Outlet />
        </OperatorLayout>
      </OperatorAppProvider>
    </RootDocument>
  );
}

function RootDocument(props: { children: React.ReactNode }) {
  return (
    <html>
      <head>
        <HeadContent />
      </head>
      <body>
        {props.children}
        <Scripts />
      </body>
    </html>
  );
}
