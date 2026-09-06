import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
export default defineConfig({
  root: "ui",
  plugins: [react(), tailwind()],
  build: { outDir: "../ui-dist", emptyOutDir: true },
});
