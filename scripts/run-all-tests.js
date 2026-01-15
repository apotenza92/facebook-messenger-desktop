/**
 * Master Test Runner
 * Runs all beta/stable coexistence tests
 */

const { testVMConnection } = require('./test-vm-helpers');

async function runAllTests() {
  console.log('\n');
  console.log('==========================================');
  console.log('  Beta/Stable Coexistence Test Suite');
  console.log('==========================================\n');

  const startTime = Date.now();
  let testsFailed = false;

  // Test VM connectivity first
  console.log('Checking VM connectivity...\n');

  const vmsAvailable = {
    windows: false,
    ubuntu: false,
    fedora: false
  };

  try {
    vmsAvailable.windows = testVMConnection('windows');
    console.log(`✓ Windows VM: ${vmsAvailable.windows ? 'Connected' : 'Not available'}`);
  } catch (err) {
    console.log('✗ Windows VM: Not available');
  }

  try {
    vmsAvailable.ubuntu = testVMConnection('ubuntu');
    console.log(`✓ Ubuntu VM: ${vmsAvailable.ubuntu ? 'Connected' : 'Not available'}`);
  } catch (err) {
    console.log('✗ Ubuntu VM: Not available');
  }

  try {
    vmsAvailable.fedora = testVMConnection('fedora');
    console.log(`✓ Fedora VM: ${vmsAvailable.fedora ? 'Connected' : 'Not available'}`);
  } catch (err) {
    console.log('✗ Fedora VM: Not available');
  }

  console.log('');

  // Run test suites
  const testSuites = [
    {
      name: 'Installation & Uninstallation Tests',
      module: './test-installation',
      required: true
    },
    {
      name: 'Coexistence Tests',
      module: './test-coexistence',
      required: true
    },
    {
      name: 'Version Upgrade Tests',
      module: './test-version-upgrades',
      required: true
    },
    {
      name: 'Icon Verification Tests',
      module: './test-icon-verification',
      required: false
    }
  ];

  for (const suite of testSuites) {
    try {
      console.log(`\n${'='.repeat(50)}`);
      console.log(`Running: ${suite.name}`);
      console.log('='.repeat(50));

      const testModule = require(suite.module);

      // Run the test module's main function
      if (typeof testModule.runTests === 'function') {
        await testModule.runTests();
      } else {
        // If no runTests function, call the module directly
        await testModule();
      }

      console.log(`✅ ${suite.name} - PASSED\n`);

    } catch (err) {
      console.error(`\n❌ ${suite.name} - FAILED`);
      console.error(`Error: ${err.message}\n`);

      if (suite.required) {
        testsFailed = true;
      } else {
        console.log('⚠️  Non-critical test failure, continuing...\n');
      }
    }
  }

  // Print summary
  const endTime = Date.now();
  const duration = ((endTime - startTime) / 1000).toFixed(2);

  console.log('\n');
  console.log('==========================================');
  console.log('  Test Suite Summary');
  console.log('==========================================\n');

  console.log(`Total duration: ${duration}s`);
  console.log(`\nVM Availability:`);
  console.log(`  - Windows: ${vmsAvailable.windows ? '✓ Available' : '✗ Not available'}`);
  console.log(`  - Ubuntu:  ${vmsAvailable.ubuntu ? '✓ Available' : '✗ Not available'}`);
  console.log(`  - Fedora:  ${vmsAvailable.fedora ? '✓ Available' : '✗ Not available'}`);

  console.log('\n');

  if (testsFailed) {
    console.log('❌ Some tests FAILED. See errors above.\n');
    process.exit(1);
  } else {
    console.log('✅ All tests PASSED!\n');
    console.log('Next steps:');
    console.log('  1. Review test screenshots in test-screenshots/');
    console.log('  2. Commit changes: git add . && git commit');
    console.log('  3. Push and release: git push && npm run release\n');
    process.exit(0);
  }
}

// Run tests
runAllTests().catch(err => {
  console.error('\n❌ Test runner error:', err);
  console.error(err.stack);
  process.exit(1);
});
