export const eslintFlatConfigFiles = [
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
  "eslint.config.ts",
  "eslint.config.mts",
  "eslint.config.cts",
];

export const nextEslintConfig = `import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "eslint.config.*",
      "next.config.*",
      "scripts/**",
    ],
  },
  ...nextVitals,
  ...nextTs,
];

export default eslintConfig;
`;
