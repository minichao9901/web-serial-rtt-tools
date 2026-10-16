import json, os, pathlib, subprocess
out=pathlib.Path(__file__).resolve().parent
profile=pathlib.Path(os.environ['TEMP'])/('chrome-f103ze-'+out.name)
assert not profile.exists()
src=pathlib.Path(os.environ['TEMP'])/'chrome-rtt-authorized/Default/Preferences'
existing=json.loads(src.read_text(encoding='utf8'))['profile']['content_settings']['exceptions']
instance=subprocess.check_output(['pwsh','-NoProfile','-Command',"(Get-PnpDevice -PresentOnly | Where-Object { $_.InstanceId -match 'VID_0D28&PID_0204&MI_01' }).InstanceId"],encoding='utf8').strip()
assert instance.startswith('USB\\VID_0D28&PID_0204&MI_01\\')
origin='http://127.0.0.1:8899,*'
exceptions={}
for kind in ('usb_chooser_data','hid_chooser_data'):
    objects=existing[kind][origin]['setting']['chosen-objects']
    objects=[x for x in objects if x.get('vendor-id')==0xd28 and x.get('product-id')==0x204 and x.get('serial-number')=='8F538633E6AEC4CA8ABB6A36FEBB1AC2']
    assert len(objects)==1
    exceptions[kind]={origin:dict(setting={'chosen-objects':objects})}
exceptions['serial_chooser_data']={origin:dict(setting={'chosen-objects':[dict(name='akaLinkPro CMSIS-DAP',device_instance_id=instance)]})}
(profile/'Default').mkdir(parents=True)
(profile/'Default/Preferences').write_text(json.dumps(dict(profile=dict(content_settings=dict(exceptions=exceptions)))),encoding='utf8')
(out/'browser.json').write_text(json.dumps(dict(profile=str(profile),cdp=9333,origin=origin,instance=instance),indent=2),encoding='utf8')
subprocess.run(['pwsh','-NoProfile','-File','tools/selftest/launch-browser.ps1','-Port','9333','-Url','http://127.0.0.1:8899/index.html','-Profile',str(profile)],check=True)
