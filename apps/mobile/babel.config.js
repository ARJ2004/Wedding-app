module.exports = {
  presets: ['module:@react-native/babel-preset'],
  // zod 4 (shared validation in packages/domain) ships `export * as ns` syntax.
  plugins: ['@babel/plugin-transform-export-namespace-from'],
};
