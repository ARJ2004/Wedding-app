module.exports = {
  root: true,
  extends: '@react-native',
  rules: {
    // Screens never hard-code colours or sizes: everything comes from the theme (lead.md).
    'react-native/no-inline-styles': 'error',
    // `void promise` marks deliberate fire-and-forget (refetch, invalidate).
    'no-void': ['error', { allowAsStatement: true }],
    // Navigator option callbacks (tabBarIcon) are render props, not nested components.
    'react/no-unstable-nested-components': ['warn', { allowAsProps: true }],
  },
};
