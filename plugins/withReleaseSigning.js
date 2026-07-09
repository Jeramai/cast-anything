const { withAppBuildGradle } = require('@expo/config-plugins');

/**
 * Injects the release (Play Store) signing config into android/app/build.gradle
 * so it survives `expo prebuild` — the native android/ dir is generated and
 * gitignored, so a hand edit there is wiped on every prebuild.
 *
 * The upload key + passwords are read at build time from a gitignored
 * ../credentials/keystore.properties (never committed). When that file is
 * absent — e.g. a teammate who doesn't have the key, or a fresh checkout — the
 * release build falls back to debug signing so `expo run:android` still works.
 *
 * Idempotent: keyed off the `castKeystorePropsFile` marker, so re-running the
 * plugin (or applying it to an already-processed file) is a no-op.
 */

const LOADER = `
// Release (Play Store) signing — injected by plugins/withReleaseSigning.js.
// Reads the upload key from a gitignored ../credentials/keystore.properties so
// the key + passwords never enter the repo; falls back to debug signing when
// that file is absent so \`expo run:android\` still works.
def castKeystorePropsFile = file("\${rootProject.projectDir}/../credentials/keystore.properties")
def castKeystoreProps = new Properties()
if (castKeystorePropsFile.exists()) {
    castKeystoreProps.load(new FileInputStream(castKeystorePropsFile))
}

android {`;

const RELEASE_SIGNING_CONFIG = `        release {
            if (castKeystorePropsFile.exists()) {
                storeFile file(castKeystoreProps['storeFile'])
                storePassword castKeystoreProps['storePassword']
                keyAlias castKeystoreProps['keyAlias']
                keyPassword castKeystoreProps['keyPassword']
            }
        }
`;

/** Apply the three edits to a pristine (Expo-generated) build.gradle. */
function addReleaseSigning(contents) {
  // Idempotent guard: bail if we've already run against this content.
  if (contents.includes('castKeystorePropsFile')) return contents;

  // 1) Load the keystore props just before the top-level `android {` block.
  const withLoader = contents.replace(/\nandroid\s*\{/, LOADER);
  if (withLoader === contents) {
    throw new Error("withReleaseSigning: couldn't find the `android {` block");
  }
  contents = withLoader;

  // 2) Declare a `release` signingConfig right after the `debug { ... }` one.
  const withRelease = contents.replace(
    /(signingConfigs\s*\{\n\s*debug\s*\{[\s\S]*?\n\s*\}\n)/,
    `$1${RELEASE_SIGNING_CONFIG}`,
  );
  if (withRelease === contents) {
    throw new Error("withReleaseSigning: couldn't find the debug signingConfig");
  }
  contents = withRelease;

  // 3) Point the release *buildType* at that signing config (was debug). The
  //    Expo template precedes it with a "Caution!" comment, which we replace.
  const withSwap = contents.replace(
    /\/\/ Caution![\s\S]*?signed-apk-android\.\n\s*signingConfig signingConfigs\.debug/,
    'signingConfig castKeystorePropsFile.exists() ? signingConfigs.release : signingConfigs.debug',
  );
  if (withSwap === contents) {
    throw new Error("withReleaseSigning: couldn't find the release buildType signingConfig");
  }
  return withSwap;
}

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (cfg) => {
    if (cfg.modResults.language !== 'groovy') {
      throw new Error('withReleaseSigning: expected a groovy build.gradle');
    }
    cfg.modResults.contents = addReleaseSigning(cfg.modResults.contents);
    return cfg;
  });
};

// Exported for a quick unit check without running a full prebuild.
module.exports.addReleaseSigning = addReleaseSigning;
