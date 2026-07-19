import { defineConfig } from "vite"

// Relative base so the build works at any mount path (GitHub Pages serves
// project sites under /<repo>/).
export default defineConfig({
	base: "./",
})
