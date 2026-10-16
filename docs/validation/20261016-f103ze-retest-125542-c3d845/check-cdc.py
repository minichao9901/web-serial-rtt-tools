import datetime,json,pathlib,time
import serial
from serial.tools.list_ports import comports
out=pathlib.Path(__file__).resolve().parent
restore=json.loads((out/'backup.json').read_text(encoding='utf8'));assert restore['passed']
ports=[p for p in comports() if p.vid==0xf055 and p.pid==0x1031 and p.serial_number=='F103CDC0001']
assert len(ports)==1, 'Restored target CDC not uniquely enumerated'
payload=b'PING\r\nINFO\r\nECHO acceptance-restored\r\n';data=b'';error=None
try:
    with serial.Serial(ports[0].device,115200,timeout=.1,write_timeout=2) as port:
        port.dtr=True;time.sleep(.2);port.reset_input_buffer()
        port.write(payload);port.flush()
        until=time.monotonic()+3
        while time.monotonic()<until:
            data+=port.read(4096)
            if b'PONG\r\n' in data and b'acceptance-restored\r\n' in data and b'48000000' in data:break
except Exception as exception:error=repr(exception)
(out/'restored-cdc-rx.bin').write_bytes(data)
result=dict(port=ports[0].device,plannedTx=payload.decode('ascii'),rx=data.decode('utf8',errors='replace'),error=error,pong=b'PONG' in data.splitlines(),echo=b'acceptance-restored' in data.splitlines(),time=datetime.datetime.now().astimezone().isoformat())
result['passed']=result['pong'] and result['echo']
(out/'restored-cdc.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf8')
print(json.dumps(result,ensure_ascii=False))

