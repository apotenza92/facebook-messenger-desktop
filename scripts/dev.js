#!/usr/bin/env node

/**
 * Development script that sets up Electron with proper app name and icon
 */

const { spawn } = require('child_process');
const path = require('path');
const electron = require('electron');

// Set environment variables to help with app identification
process.env.ELECTRON_APP_NAME = 'Messenger';
process.env.ELECTRON_APP_PATH = path.join(__dirname, '..');

// Get any extra arguments passed after `npm start --`
const extraArgs = process.argv.slice(2);

// Spawn Electron with our app and any extra arguments
const electronProcess = spawn(electron, [path.join(__dirname, '..'), ...extraArgs], {
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_ENV: 'development',
    ELECTRON_APP_NAME: 'Messenger',
  },
});

electronProcess.on('close', (code) => {
  process.exit(code);
});

