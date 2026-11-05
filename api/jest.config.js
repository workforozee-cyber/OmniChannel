module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  setupFiles: ['<rootDir>/test/env.ts'],
  testTimeout: 30000,
  maxWorkers: 1,
};
