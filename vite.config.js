import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Si tu déploies sur GitHub Pages sous forme de projet (ex.
// https://TON_USER.github.io/arc-corner-app/), décommente la ligne "base" ci-dessous
// et remplace par le nom exact de ton repo. Pour Vercel/Netlify, laisse commenté.
export default defineConfig({
  plugins: [react()],
  // base: "/arc-corner-app/",
});
