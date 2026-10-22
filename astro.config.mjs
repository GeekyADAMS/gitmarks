import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import node from "@astrojs/node";
import vercel from "@astrojs/vercel";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  // Every page checks a session and every write goes to GitHub, so nothing is static.
  output: "server",
  // Vercel sets VERCEL=1 during its build; everywhere else runs on plain Node,
  // which is also what `astro preview` needs.
  adapter: process.env.VERCEL ? vercel() : node({ mode: "standalone" }),
  integrations: [react()],
  vite: { plugins: [tailwindcss()] },
});
