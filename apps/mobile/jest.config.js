module.exports = {
  preset: '@react-native/jest-preset',
  moduleNameMapper: {
    '^@mehfil/(domain|design-tokens|i18n|api-client)$': '<rootDir>/../../packages/$1/src',
  },
  transformIgnorePatterns: [
    'node_modules/(?!(@react-native|react-native|@react-navigation|react-native-safe-area-context|react-native-screens)/)',
  ],
  setupFiles: ['<rootDir>/jest.setup.js'],
};
