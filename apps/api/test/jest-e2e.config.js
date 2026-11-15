module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testRegex: '\\.e2e-spec\\.ts$',
  setupFiles: ['<rootDir>/setup-env.ts'],
};
