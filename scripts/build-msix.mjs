import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd(); // run from apps/cairn
const TAURI_SRC = path.join(ROOT, 'src-tauri');
const RELEASE_EXE = path.join(TAURI_SRC, 'target', 'release', 'cairn.exe');
const ICONS_DIR = path.join(TAURI_SRC, 'icons');
const OUT_DIR = path.join(ROOT, 'dist-msix');
const STAGING_DIR = path.join(OUT_DIR, 'staging');
const appVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const storeVersion = `${appVersion}.0`;
const MSIX_OUT = path.join(OUT_DIR, `Cairn-${storeVersion}-x64.msix`);

// Store identity: Partner Center assigns Package/Identity/Name on product
// create. Pass it via MSIX_IDENTITY_NAME (or hardcode once known).
const IDENTITY_NAME = process.env.MSIX_IDENTITY_NAME || 'NoahZixinZhang.Cairn-SystemGuardBackup';
const PUBLISHER = 'CN=30D8BDA3-D85F-4867-B2BE-4EA1E4D27AED';

const MAKEAPPX = 'C:\\Program Files (x86)\\Windows Kits\\10\\bin\\10.0.26100.0\\x64\\makeappx.exe';
const MAKEPRI = path.join(path.dirname(MAKEAPPX), 'makepri.exe');

if (!fs.existsSync(RELEASE_EXE)) {
  console.error('Release binary not found at:', RELEASE_EXE);
  process.exit(1);
}
if (fs.readFileSync(RELEASE_EXE).includes(Buffer.from('Cairn Pro license required'))) {
  throw new Error('The Microsoft Store package requires the Free build.');
}
if (path.basename(OUT_DIR) !== 'dist-msix') throw new Error('bad OUT_DIR');
fs.rmSync(OUT_DIR, { recursive: true, force: true });
fs.mkdirSync(STAGING_DIR, { recursive: true });

fs.copyFileSync(RELEASE_EXE, path.join(STAGING_DIR, 'cairn.exe'));

const targetAssets = path.join(STAGING_DIR, 'Assets');
fs.mkdirSync(targetAssets, { recursive: true });
const assetFiles = [
  'StoreLogo.png',
  'Square150x150Logo.png',
  'Square44x44Logo.png',
  'Square310x310Logo.png',
  'Square71x71Logo.png',
  'Wide310x150Logo.png',
  'SplashScreen.png',
];
assetFiles.push(...fs.readdirSync(ICONS_DIR).filter((name) => /^Square44x44Logo\.targetsize-\d+(?:_altform-(?:light)?unplated)?\.png$/.test(name)));
for (const f of assetFiles) {
  const src = path.join(ICONS_DIR, f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(targetAssets, f));
  else console.warn('Warning: icon missing:', f);
}

const manifest = `<?xml version="1.0" encoding="utf-8"?>
<Package
  xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
  xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
  xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
  xmlns:desktop="http://schemas.microsoft.com/appx/manifest/desktop/windows10"
  IgnorableNamespaces="uap rescap desktop">

  <Identity
    Name="${IDENTITY_NAME}"
    Publisher="${PUBLISHER}"
    Version="${storeVersion}"
    ProcessorArchitecture="x64" />

  <Properties>
    <DisplayName>Cairn: System Guard &amp; Backup</DisplayName>
    <PublisherDisplayName>Noah Zixin Zhang</PublisherDisplayName>
    <Logo>Assets\\StoreLogo.png</Logo>
    <Description>Tray-resident folder protection, live memory and process monitor, and disk analyzer. Free; optional Pro upgrade at cairn.supastack.dev.</Description>
  </Properties>

  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.17763.0" MaxVersionTested="10.0.26100.0" />
  </Dependencies>

  <Resources>
    <Resource Language="en-us" />
    <Resource Language="zh-cn" />
  </Resources>

  <Capabilities>
    <rescap:Capability Name="runFullTrust" />
  </Capabilities>

  <Applications>
    <Application Id="App"
      Executable="cairn.exe"
      EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements
        DisplayName="Cairn"
        Description="System guard for your folders and memory"
        BackgroundColor="transparent"
        Square150x150Logo="Assets\\Square150x150Logo.png"
        Square44x44Logo="Assets\\Square44x44Logo.png">
        <uap:DefaultTile
          Square71x71Logo="Assets\\Square71x71Logo.png"
          Wide310x150Logo="Assets\\Wide310x150Logo.png"
          Square310x310Logo="Assets\\Square310x310Logo.png">
          <uap:ShowNameOnTiles>
            <uap:ShowOn Tile="square150x150Logo" />
          </uap:ShowNameOnTiles>
        </uap:DefaultTile>
        <uap:SplashScreen Image="Assets\\SplashScreen.png" />
      </uap:VisualElements>
    </Application>
  </Applications>
</Package>
`;

fs.writeFileSync(path.join(STAGING_DIR, 'AppxManifest.xml'), manifest, 'utf8');

const priConfig = path.join(OUT_DIR, 'priconfig.xml');
const makepri = (args) => {
  const output = execFileSync(MAKEPRI, args, { windowsHide: true });
  console.log(output.toString('utf16le').trim());
};
makepri(['createconfig', '/cf', priConfig, '/dq', 'en-US', '/o']);
fs.writeFileSync(priConfig, fs.readFileSync(priConfig, 'utf8').replace('foldernameAsQualifier="true"', 'foldernameAsQualifier="false"'));
makepri(['new', '/pr', STAGING_DIR, '/cf', priConfig, '/mn', path.join(STAGING_DIR, 'AppxManifest.xml'), '/of', path.join(STAGING_DIR, 'resources.pri'), '/o']);

console.log('Staging prepared. Running makeappx...');
try {
  const out = execFileSync(MAKEAPPX, ['pack', '/h', 'SHA256', '/d', STAGING_DIR, '/p', MSIX_OUT, '/o'], { encoding: 'utf8', windowsHide: true });
  console.log(out.trim().split(/\r?\n/).slice(-3).join('\n'));
  console.log('MSIX created:', MSIX_OUT);
} catch (err) {
  console.error('MakeAppx failed:', err.stdout || err.message);
  process.exit(1);
}
