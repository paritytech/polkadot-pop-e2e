// Lint for the TypeScript under environments/runtime-diff: typed rules, no type
// assertions and no non-null assertions. Values from JSON or SCALE are `unknown`
// until a check narrows them (see environments/runtime-diff/json.ts).
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config({
  files: ["environments/runtime-diff/**/*.ts"],
  extends: [eslint.configs.recommended, tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
  languageOptions: {
    parserOptions: { project: "environments/tsconfig.json", tsconfigRootDir: import.meta.dirname },
  },
  rules: {
    "@typescript-eslint/consistent-type-assertions": ["error", { assertionStyle: "never" }],
    "@typescript-eslint/no-non-null-assertion": "error",
    "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
    // node:test's describe() and it() return promises the runner awaits itself.
    "@typescript-eslint/no-floating-promises": [
      "error",
      { allowForKnownSafeCalls: [{ from: "package", name: ["describe", "it"], package: "node:test" }] },
    ],
  },
});
