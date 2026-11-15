import { render, screen } from '@testing-library/react-native';
import React from 'react';
import App from '../App';

jest.mock('../src/lib/secure-store', () => ({ secureStore: { get: async () => null, set: async () => undefined, clear: async () => undefined } }));

test('signed-out users land on Welcome with dev sign-in in development', async () => {
  await render(<App />);
  expect(await screen.findByText('Hosts and planners')).toBeTruthy();
  expect(screen.getByTestId('dev-sign-in')).toBeTruthy();
  expect(screen.getByText('I have an invite link')).toBeTruthy();
});
