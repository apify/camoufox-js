// eslint-disable-next-line import/extensions
import eslintConfigPrettier from "eslint-config-prettier/flat";

import apifyTypescriptConfig from "@apify/eslint-config/ts.js";

// eslint-disable-next-line import/no-default-export
export default [
  { ignores: ["**/dist", "**/test"] }, // Ignores need to happen first
  ...apifyTypescriptConfig,
  {
    languageOptions: {
      sourceType: "module",

      parserOptions: {
        project: "tsconfig.json",
      },
    },
  },
  {
    files: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"],
    rules: {
      // the project follows the naming conventions of the original Python project,
      // which uses snake_case for variable and property names.
      camelcase: "off",
      "no-underscore-dangle": "off",
    },
  },
  eslintConfigPrettier,
];
