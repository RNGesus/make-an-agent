import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  lint: {
    options: { typeAware: true, typeCheck: true },
    ignorePatterns: ["routeTree.gen.ts"],
  },
  fmt: {
    ignorePatterns: ["routeTree.gen.ts"],
  },
});
