# Acceptance Gates

- [x] g1: Core implementation complete without stubs or TODOs
  CHECK: npm test
  EXPECT: 0 failed
- [x] g2: Static audit and lint pass cleanly
  CHECK: npm run audit
  EXPECT: CRITICAL=0 HIGH=0
