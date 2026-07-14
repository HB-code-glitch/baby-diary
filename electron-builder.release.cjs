const base = require('./package.json').build

module.exports = {
  ...base,
  forceCodeSigning: true,
  mac: {
    ...base.mac,
    forceCodeSigning: true,
    cscLink: process.env.MAC_CSC_LINK,
    cscKeyPassword: process.env.MAC_CSC_KEY_PASSWORD,
    identity: process.env.MAC_CSC_NAME,
    type: 'distribution',
    hardenedRuntime: true,
    strictVerify: true,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.inherit.plist',
    notarize: true,
  },
  win: {
    ...base.win,
    forceCodeSigning: true,
    cscLink: process.env.WIN_CSC_LINK,
    cscKeyPassword: process.env.WIN_CSC_KEY_PASSWORD,
    signtoolOptions: {
      publisherName: process.env.WIN_EXPECTED_PUBLISHER,
      signingHashAlgorithms: ['sha256'],
      rfc3161TimeStampServer: 'http://timestamp.digicert.com',
    },
  },
}
