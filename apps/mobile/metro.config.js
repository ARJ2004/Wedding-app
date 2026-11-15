const path = require('path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

const root = path.resolve(__dirname, '../..');

/** Monorepo: watch shared packages and resolve their TypeScript sources directly. */
const config = {
  // Hoisted pnpm install: dependencies live in the repo-root node_modules, shared code in packages/.
  watchFolders: [path.join(root, 'node_modules'), path.join(root, 'packages')],
  resolver: {
    nodeModulesPaths: [path.join(__dirname, 'node_modules'), path.join(root, 'node_modules')],
    unstable_enablePackageExports: true,
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
