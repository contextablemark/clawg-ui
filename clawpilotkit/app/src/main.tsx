import React from "react";
import { createRoot } from "react-dom/client";
import { Embedded } from "./Embedded";
import { Standalone } from "./Standalone";
import { waitForInitialContext } from "./openclaw-bridge";
import "./styles.css";

async function bootstrap() {
  const container = document.getElementById("root");
  if (!container) throw new Error("#root container missing from index.html");
  const root = createRoot(container);

  const ctx = await waitForInitialContext();
  if (ctx) {
    document.documentElement.dataset.theme = ctx.theme.resolved;
    root.render(
      <React.StrictMode>
        <Embedded initialCtx={ctx} />
      </React.StrictMode>,
    );
    return;
  }
  root.render(
    <React.StrictMode>
      <Standalone />
    </React.StrictMode>,
  );
}

void bootstrap();
