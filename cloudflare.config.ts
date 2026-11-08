import { defineConfig } from "cf/config";

export default defineConfig({
  worker: {
    name: "ptwords",
    domains: ["words.pie.boats"],
    compatibilityDate: "2026-11-01",
    entrypoint: "./src/worker/index.ts",
    assets: {
      notFoundHandling: "single-page-application",
      runWorkerFirst: ["/api/*"],
    },
    env: {
      // Optional: only let these AnkiWeb accounts log in through this deployment.
      // ALLOWED_USERS: bindings.text("you@example.com"),  (import { bindings } from "cf/config")
    },
    observability: { enabled: true },
  },
});
