import React from 'react';
import { AppRegistry } from 'react-native';
import App from '../App';

/**
 * Web preview of the React Native app (react-native-web), used for quick reviews and screenshots
 * in environments without an Android emulator or iOS Simulator. Native-only modules have
 * `.web.ts` stand-ins in src/lib.
 */
AppRegistry.registerComponent('Mehfil', () => App);
AppRegistry.runApplication('Mehfil', { rootTag: document.getElementById('root') });
void React;
