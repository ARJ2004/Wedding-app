module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testRegex: '\\.e2e-spec\\.ts$',
  setupFiles: ['<rootDir>/setup-env.ts'],
  moduleNameMapper: { '^@mehfil/(domain|i18n|design-tokens)$': '<rootDir>/../../../packages/$1/src' },
  globalSetup: '<rootDir>/global-setup.ts',
};
