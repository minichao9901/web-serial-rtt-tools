from pathlib import Path
import json,hashlib,zipfile,datetime,subprocess,re
ROOT=Path.cwd();OUT=Path(__file__).resolve().parent
sha=lambda data:hashlib.sha256(data).hexdigest()
inputs=json.loads((OUT/'inputs-ownership.json').read_text('utf-8'))
changed=[name for name,digest in inputs.items() if sha((ROOT/name).read_bytes())!=digest]
assert not changed,changed
reg=json.loads((OUT/'regression-ownership/results.json').read_text('utf-8'))
assert len(reg)==107 and all(row['exitCode']==0 for row in reg)
bundle=json.loads((ROOT/'app/site/manifest.json').read_text('utf-8'))
download=json.loads((ROOT/'bridge/etm/downloads/manifest.json').read_text('utf-8'))
archive=ROOT/'bridge/etm/downloads/etm-bridge-win64.zip'
assert sha(archive.read_bytes())==download['sha256']
with zipfile.ZipFile(archive) as zip_:
 prefix='etm-bridge-kit/toolbox/'
 mismatches=[name for name,digest in bundle['inputs'].items() if sha(zip_.read(prefix+name).decode('utf-8').replace('\r\n','\n').encode('utf-8'))!=digest]
 assert not mismatches,mismatches
 assert zip_.read(prefix+'app/site/main.js')==(ROOT/'app/site/main.js').read_bytes()
 assert json.loads(zip_.read('etm-bridge-kit/package-manifest.json'))['packageId']==download['packageId']
browser=json.loads((OUT/'bundle-ownership-browser.json').read_text('utf-8'))
assert len(browser['pages'])==15 and not browser['warnings']
assert all(bundle['outputSha256'][:16] in row['preload'] for row in browser['pages'])
layouts=json.loads((OUT/'browser-layouts.json').read_text('utf-8'))
assert len(layouts)==45 and all(row['documentWidth']<=row['width']+1 and row['duplicateIds']==0 for row in layouts)
subtabs=json.loads((OUT/'browser-subtabs.json').read_text('utf-8'))
assert len(subtabs)==83 and all(row['ok'] for row in subtabs)
assert 'Ran 7 tests' in (OUT/'portable-ownership.log').read_text('utf-8') and '\nOK' in (OUT/'portable-ownership.log').read_text('utf-8')
metadata=dict(completedAt=datetime.datetime.now().astimezone().isoformat(),revision=subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),testedDirty=True,functionalFixes=13,regressionEntries=107,regressionsPassed=True,sourceInputsChangedSinceFinalRun=changed,makeTestOfflineExitCode=0,etmTests=77,portableTests=7,browserMainPages=15,browserTabsAndPreviews=83,layoutChecks=45,bundleSourceModules=len(bundle['inputs']),bundleSha256=bundle['outputSha256'],portableSha256=download['sha256'],portablePackageId=download['packageId'],packagedSourceMismatches=mismatches,originalAPAdditionsRetained=True,hardware='not-run',gitCommit='not-created',deployment='not-run')
(OUT/'final-status.json').write_text(json.dumps(metadata,ensure_ascii=False,indent=2),encoding='utf-8')
missing=[link for link in re.findall(r'\]\(([^)]+)\)',(OUT/'report.md').read_text('utf-8')) if '://' not in link and not (OUT/link.split('#')[0]).exists()]
assert not missing,missing
print(json.dumps(metadata,ensure_ascii=False))
