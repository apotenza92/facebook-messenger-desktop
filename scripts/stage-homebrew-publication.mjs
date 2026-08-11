import {createHash} from 'node:crypto';
import {mkdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import process from 'node:process';
import {buildPublication} from './build-homebrew-publication.mjs';

const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const identities = {
  stable: {token: 'facebook-messenger-desktop', prefix: 'Messenger-macos', name: 'Messenger', app: 'Messenger.app', bundle: 'com.facebook.messenger.desktop', data: 'Messenger'},
  beta: {token: 'facebook-messenger-desktop@beta', prefix: 'Messenger-Beta-macos', name: 'Messenger Beta', app: 'Messenger Beta.app', bundle: 'com.facebook.messenger.desktop.beta', data: 'Messenger-Beta'},
};
function cask(identity, version, tag, assets) {
  const entries = [['arm','arm64'],['intel','x64']].map(([block, arch]) => {
    const name=`${identity.prefix}-${arch}.zip`; const digest=sha(join(assets,name));
    return `  on_${block} do\n    sha256 "${digest}"\n\n    url "https://github.com/apotenza92/facebook-messenger-desktop/releases/download/v#{version}/${name}"\n  end`;
  }).join('\n');
  const livecheck = identity === identities.beta
    ? `    url "https://github.com/apotenza92/facebook-messenger-desktop/releases"\n    regex(/v?(\\d+\\.\\d+\\.\\d+(?:-beta\\.[1-9]\\d*)?)/i)\n    strategy :page_match`
    : `    url :url\n    strategy :github_latest`;
  return `cask "${identity.token}" do
  version "${version}"

${entries}

  name "${identity.name}"
  desc "Desktop client for Facebook Messenger${identity === identities.beta ? ' (Beta)' : ''}"
  homepage "https://github.com/apotenza92/facebook-messenger-desktop"

  livecheck do
${livecheck}
  end

  depends_on :macos

  app "${identity.app}"

  zap trash: [
    "~/Library/Application Support/${identity.data}",
    "~/Library/Caches/${identity.bundle}",
    "~/Library/Caches/${identity.bundle}.ShipIt",
    "~/Library/Preferences/${identity.bundle}.plist",
    "~/Library/Saved Application State/${identity.bundle}.savedState",
  ]
end
`;
}
export function stage({channel,tag,assetsDirectory,outputDirectory,commit,runId,runAttempt}) {
  const version=tag.slice(1); const channels=channel==='stable'?['stable','beta']:['beta'];
  const casksDirectory=join(outputDirectory,'candidate-casks'); mkdirSync(casksDirectory,{recursive:true});
  const releaseAssets={assets:[]};
  for (const value of channels) { const identity=identities[value]; writeFileSync(join(casksDirectory,`${identity.token}.rb`),cask(identity,version,tag,assetsDirectory));
    for (const arch of ['arm64','x64']) { const name=`${identity.prefix}-${arch}.zip`; const file=join(assetsDirectory,name); const size=statSync(file).size; releaseAssets.assets.push({name,size,digest:`sha256:${sha(file)}`}); }
  }
  const publication=join(outputDirectory,'publication'); mkdirSync(publication,{recursive:true});
  const manifest=buildPublication({channel,tag,commit,runId,runAttempt,casksDirectory,releaseAssets,outputDirectory:publication});
  const files=['manifest.json',...manifest.casks.map(name=>`Casks/${name}`)].sort();
  writeFileSync(join(publication,'SHA256SUMS'),files.map(name=>`${sha(join(publication,name))}  ${name}`).join('\n')+'\n');
}
function option(name){const i=process.argv.indexOf(name);if(i<0)throw new Error(`Missing ${name}`);return process.argv[i+1];}
if(resolve(process.argv[1])===resolve(import.meta.filename)) stage({channel:option('--channel'),tag:option('--tag'),assetsDirectory:resolve(option('--assets')),outputDirectory:resolve(option('--output')),commit:process.env.GITHUB_SHA,runId:process.env.GITHUB_RUN_ID,runAttempt:process.env.GITHUB_RUN_ATTEMPT});
