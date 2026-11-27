import { setVersion } from './desktop-release/version.mjs';
const version = process.argv[2];
setVersion(version).then(old => console.log(old === version ? `版本已是 ${version}` : `${old} → ${version}`))
  .catch(error => { console.error(error.message); process.exitCode = 1; });
