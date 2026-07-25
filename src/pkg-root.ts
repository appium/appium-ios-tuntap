import {fileURLToPath} from 'node:url';

import {node, util} from '@appium/support';

const PACKAGE_NAME = 'appium-ios-tuntap';

/** Package root (contains binding.gyp, prebuilds/, or build/ after compile). */
export const getPkgRoot = util.memoize(function resolvePkgRoot(): string {
  const root = node.getModuleRootSync(PACKAGE_NAME, fileURLToPath(import.meta.url));
  if (!root) {
    throw new Error(`Could not locate the root of the '${PACKAGE_NAME}' package`);
  }
  return root;
});
